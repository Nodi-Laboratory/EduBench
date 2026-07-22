import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { DomainError } from '@/domain/errors';

const postgresUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'PostgreSQL UUID 형식이어야 합니다.',
);

const freezeSchema = z.object({
  version: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  questionIds: z.array(postgresUuid).min(1).max(5000),
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
    if (new Set(input.questionIds).size !== input.questionIds.length) {
      throw new DomainError('DATASET_QUESTION_DUPLICATE', '서로 다른 문항만 데이터셋에 포함할 수 있습니다.');
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
    if (questions.rowCount !== input.questionIds.length || questions.rows.some((question) => question.status !== 'APPROVED')) {
      throw new DomainError('DATASET_QUESTIONS_NOT_APPROVED', '선택한 문항은 모두 승인 상태여야 합니다.');
    }
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
         ) values ($1, $2, 'DRAFT', $3, $4, $5, $6::jsonb, $7, now())`,
        [id, input.version, input.title, input.description ?? null, questions.rows.length, JSON.stringify(distribution), contentHash],
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
