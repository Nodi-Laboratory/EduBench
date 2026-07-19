import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { DomainError } from '@/domain/errors';
import { DEFAULT_DATASET_TARGET, validateDatasetProfile } from '@/domain/distribution';

const postgresUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'PostgreSQL UUID 형식이어야 합니다.',
);

const freezeSchema = z.object({
  version: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  questionIds: z.array(postgresUuid).length(500),
});

type FreezeQuestion = {
  id: string;
  public_id: string;
  current_revision: number;
  status: string;
  purpose: string;
  question_type: string;
  evidence_mode: string;
  question_text: string;
  answer_text: string;
  answer_options: unknown;
  scoring_criteria: unknown;
  accepted_answers: unknown;
  design_summary: string | null;
  evidence_summary: string | null;
  evidence: unknown;
};

function countBy(rows: FreezeQuestion[], key: keyof FreezeQuestion): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = String(row[key]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function assertExactDistribution(rows: FreezeQuestion[]) {
  const expected = {
    purpose: { '핵심 개념 이해': DEFAULT_DATASET_TARGET.capabilities.coreConcept, '개념 적용·문제풀이': DEFAULT_DATASET_TARGET.capabilities.application, '여러 단원 연결 추론': DEFAULT_DATASET_TARGET.capabilities.crossUnit, '학생 수준별 설명': DEFAULT_DATASET_TARGET.capabilities.studentExplanation, '오개념·잘못된 주장 교정': DEFAULT_DATASET_TARGET.capabilities.misconceptionCorrection },
    question_type: { '객관식': DEFAULT_DATASET_TARGET.responseFormats.multipleChoice, '단답형': DEFAULT_DATASET_TARGET.responseFormats.shortAnswer, '구조화 서술형': DEFAULT_DATASET_TARGET.responseFormats.structuredResponse, '학생 설명형': DEFAULT_DATASET_TARGET.responseFormats.studentExplanation, '교정·범위 판단형': DEFAULT_DATASET_TARGET.responseFormats.correctionScope },
    evidence_mode: { GROUNDED: DEFAULT_DATASET_TARGET.evidenceModes.grounded, CLOSED_BOOK: DEFAULT_DATASET_TARGET.evidenceModes.closedBook, INSUFFICIENT_EVIDENCE: DEFAULT_DATASET_TARGET.evidenceModes.insufficientEvidence },
  } as const;
  for (const [key, target] of Object.entries(expected) as Array<[keyof typeof expected, Record<string, number>]>) {
    const actual = countBy(rows, key);
    if (Object.entries(target).some(([label, count]) => actual[label] !== count) || Object.keys(actual).some((label) => !(label in target))) {
      throw new DomainError('DATASET_DISTRIBUTION_MISMATCH', `${key} 분포가 공식 500문항 목표와 일치하지 않습니다.`, { expected: target, actual });
    }
  }
  const multipleChoice = rows.filter((row) => row.question_type === '객관식').map((row) => {
    const raw = Array.isArray(row.accepted_answers) ? String(row.accepted_answers[0] ?? row.answer_text) : row.answer_text;
    const option = ({ '1':'A','2':'B','3':'C','4':'D','①':'A','②':'B','③':'C','④':'D' } as Record<string,string>)[raw.trim()] ?? raw.trim().toUpperCase();
    return { questionType:'multipleChoice' as const, correctOption: option as 'A'|'B'|'C'|'D' };
  });
  if (multipleChoice.some((item) => !['A','B','C','D'].includes(item.correctOption))) throw new DomainError('MULTIPLE_CHOICE_KEY_INVALID', '객관식 승인 답안은 A–D 또는 1–4 위치여야 합니다.');
  const balance = validateDatasetProfile(multipleChoice); if (!balance.valid) throw new DomainError(balance.issues[0]!.code, balance.issues[0]!.message);
}

export async function GET() {
  const result = await db.query(
    `select id, version, status, title, description, question_count, distribution,
       content_hash, published_at from dataset_versions
     order by published_at desc`,
  );
  return NextResponse.json({ items: result.rows });
}

export async function POST(request: Request) {
  try {
    const input = freezeSchema.parse(await request.json());
    if (new Set(input.questionIds).size !== 500) {
      throw new DomainError('DATASET_QUESTION_DUPLICATE', '500개의 서로 다른 문항이 필요합니다.');
    }
    const questions = await db.query<FreezeQuestion>(
      `select q.id, q.public_id, q.current_revision, q.status, q.purpose, q.question_type, q.evidence_mode,
       qr.question_text, qr.answer_text, qr.answer_options, qr.scoring_criteria, qr.accepted_answers,
       qr.design_summary, qr.evidence_summary,
       coalesce((select jsonb_agg(jsonb_build_object('chunkId',qe.source_chunk_id,'ordinal',qe.ordinal,'role',qe.role,'quote',qe.quote_text) order by qe.ordinal) from question_evidence qe where qe.question_id=q.id and qe.question_revision=q.current_revision),'[]'::jsonb) evidence
       from questions q join question_revisions qr on qr.question_id=q.id and qr.revision=q.current_revision
       where q.id = any($1::uuid[]) order by q.public_id`,
      [input.questionIds],
    );
    if (questions.rowCount !== 500 || questions.rows.some((question) => question.status !== 'APPROVED')) {
      throw new DomainError('DATASET_QUESTIONS_NOT_APPROVED', '승인된 문항 500개만 버전으로 확정할 수 있습니다.');
    }
    assertExactDistribution(questions.rows);
    const contentHash = createHash('sha256').update(JSON.stringify(questions.rows)).digest('hex');

    const existing = await db.query<{ id: string; version: string; content_hash: string }>(
      'select id, version, content_hash from dataset_versions where version = $1 or content_hash = $2',
      [input.version, contentHash],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].version !== input.version || existing.rows[0].content_hash !== contentHash) {
        throw new DomainError('DATASET_VERSION_CONFLICT', '버전 또는 내용 해시가 기존 데이터셋과 충돌합니다.');
      }
      return NextResponse.json({
        id: existing.rows[0].id,
        contentHash: existing.rows[0].content_hash,
        existing: true,
      });
    }

    const distribution = {
      capabilities: countBy(questions.rows, 'purpose'),
      responseFormats: countBy(questions.rows, 'question_type'),
      evidenceModes: countBy(questions.rows, 'evidence_mode'),
    };
    const id = randomUUID();
    await withTransaction(async (client) => {
      await client.query(
        `insert into dataset_versions(
           id, version, status, title, description, question_count, distribution, content_hash, published_at
         ) values ($1, $2, 'DRAFT', $3, $4, 500, $5::jsonb, $6, now())`,
        [id, input.version, input.title, input.description ?? null, JSON.stringify(distribution), contentHash],
      );
      for (let index = 0; index < questions.rows.length; index += 1) {
        const question = questions.rows[index]!;
        await client.query(
          `insert into dataset_questions(dataset_version_id, question_id, question_revision, ordinal)
           values ($1, $2, $3, $4)`,
          [id, question.id, question.current_revision, index + 1],
        );
      }
      await client.query(
        `update dataset_versions set status = 'PUBLISHED', published_at = now() where id = $1`, [id],
      );
    });
    return NextResponse.json({ id, contentHash, existing: false }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ code: 'INVALID_DATASET_INPUT', issues: error.issues }, { status: 400 });
    }
    if (error instanceof DomainError) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
}
