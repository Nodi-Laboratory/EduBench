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
    if (new Set(input.questionIds).size !== 500) {
      throw new DomainError('DATASET_QUESTION_DUPLICATE', '500개의 서로 다른 문항이 필요합니다.');
    }
    const questions = await db.query<FreezeQuestion>(
      `select id, public_id, current_revision, status, purpose, question_type, evidence_mode
       from questions where id = any($1::uuid[]) order by public_id`,
      [input.questionIds],
    );
    if (questions.rowCount !== 500 || questions.rows.some((question) => question.status !== 'APPROVED')) {
      throw new DomainError('DATASET_QUESTIONS_NOT_APPROVED', '승인된 문항 500개만 버전으로 확정할 수 있습니다.');
    }
    const contentHash = createHash('sha256')
      .update(JSON.stringify(questions.rows.map((question) => [question.public_id, question.current_revision])))
      .digest('hex');

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
