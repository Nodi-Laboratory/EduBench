import { NextResponse } from 'next/server';
import { z } from 'zod';
import { transitionQuestion, type QuestionCommand, type QuestionState } from '@/domain/status';
import { DomainError } from '@/domain/errors';
import { withTransaction } from '@/server/db/transaction';
import {
  assignQuestionToTargetSet,
  type QuestionSetTarget,
} from '@/server/question-sets/service';

const postgresUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'PostgreSQL UUID 형식이어야 합니다.',
);

const targetSetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    id: postgresUuid,
  }),
  z.object({
    kind: z.literal('new'),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional(),
  }),
]);

const reviewSchema = z.object({
  action: z.enum(['APPROVE', 'EDIT_AND_APPROVE', 'HOLD', 'REOPEN', 'DELETE']),
  questionText: z.string().trim().min(3).optional(),
  answerText: z.string().trim().min(1).optional(),
  scoringCriteria: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1).optional(),
    maxScore: z.number().positive(),
  })).min(1).optional(),
  note: z.string().trim().max(1000).optional(),
  targetSet: targetSetSchema.optional(),
}).superRefine((input, context) => {
  if (
    ['APPROVE', 'EDIT_AND_APPROVE'].includes(input.action)
    && !input.targetSet
  ) {
    context.addIssue({
      code: 'custom',
      path: ['targetSet'],
      message: '승인할 질문 세트를 선택하거나 새로 만들어야 합니다.',
    });
  }
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const input = reviewSchema.parse(await request.json());
    const result = await withTransaction(async (client) => {
      const currentResult = await client.query<{
        status: QuestionState;
        current_revision: number;
      }>('select status, current_revision from questions where id = $1 for update', [id]);
      const current = currentResult.rows[0];
      if (!current) throw new DomainError('QUESTION_NOT_FOUND', '문항을 찾을 수 없습니다.', { id });
      const command = input.action as QuestionCommand;
      const next = transitionQuestion(current.status, command);
      let revision = current.current_revision;

      if (input.action === 'EDIT_AND_APPROVE') {
        if (!input.questionText || !input.answerText || !input.scoringCriteria) {
          throw new DomainError('REVIEW_CONTENT_REQUIRED', '수정 후 승인에는 질문, 답안, 채점 기준이 필요합니다.');
        }
        revision += 1;
        await client.query(
          `insert into question_revisions(
             question_id, revision, question_text, answer_text, answer_options, scoring_criteria,
             accepted_answers, design_summary, evidence_summary, quality_scores, change_reason
           ) select question_id, $2, $3, $4, answer_options, $5::jsonb,
             accepted_answers, design_summary, evidence_summary, quality_scores, $6
           from question_revisions where question_id = $1 and revision = $7`,
          [id, revision, input.questionText, input.answerText, JSON.stringify(input.scoringCriteria), input.note ?? '수정 후 승인', current.current_revision],
        );
        await client.query(
          `insert into question_evidence(question_id, question_revision, source_chunk_id, ordinal, role, quote_text)
           select question_id, $2, source_chunk_id, ordinal, role, quote_text
           from question_evidence where question_id = $1 and question_revision = $3`,
          [id, revision, current.current_revision],
        );
      }

      await client.query(
        'update questions set status = $2, current_revision = $3, updated_at = now() where id = $1',
        [id, next, revision],
      );
      let questionSet:
        | Awaited<ReturnType<typeof assignQuestionToTargetSet>>
        | undefined;
      if (['APPROVE', 'EDIT_AND_APPROVE'].includes(input.action)) {
        if (!input.targetSet) {
          throw new DomainError(
            'REVIEW_TARGET_SET_REQUIRED',
            '승인할 질문 세트를 선택하거나 새로 만들어야 합니다.',
          );
        }
        questionSet = await assignQuestionToTargetSet(
          client,
          input.targetSet as QuestionSetTarget,
          id,
          revision,
        );
      }
      const metadata = questionSet ? {
        questionSetId: questionSet.item.id,
        questionSetTitle: questionSet.item.title,
        questionSetCreated: questionSet.created,
      } : {};
      await client.query(
        `insert into review_actions(
           question_id, action, from_status, to_status, revision, note, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          id,
          input.action,
          current.status,
          next,
          revision,
          input.note ?? null,
          JSON.stringify(metadata),
        ],
      );
      return {
        id,
        status: next,
        revision,
        ...(questionSet ? { questionSet: questionSet.item } : {}),
      };
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ code: 'INVALID_REVIEW_INPUT', issues: error.issues }, { status: 400 });
    }
    if (error instanceof DomainError) {
      const status = error.code === 'QUESTION_NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ code: error.code, message: error.message }, { status });
    }
    throw error;
  }
}
