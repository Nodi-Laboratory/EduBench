import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { enqueueJob } from '@/server/jobs/queue';
import { GENERATION_STAGES } from '@/domain/generation';

const generationSchema = z.object({
  subject: z.string().trim().min(1),
  grade: z.string().trim().min(1),
  sourceFileIds: z.array(z.uuid()).min(1),
  units: z.array(z.string().trim().min(1)).default([]),
  purpose: z.string().trim().min(1),
  questionType: z.string().trim().min(1),
  difficulty: z.enum(['하', '중', '상']),
  direction: z.string().trim().min(3).max(2000),
  chunkCount: z.number().int().min(3).max(30),
  crossUnit: z.boolean(),
  requestedCount: z.number().int().min(1).max(100),
});

export async function GET() {
  const result = await db.query(
    `select id, state, requested_count, conditions, source_scope, generation_model,
       prompt_version, progress, created_at, updated_at
     from generation_batches order by created_at desc limit 100`,
  );
  return NextResponse.json({ items: result.rows });
}

export async function POST(request: Request) {
  const parsed = generationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_GENERATION_INPUT', issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  if (new Set(input.sourceFileIds).size !== input.sourceFileIds.length) {
    return NextResponse.json({ code: 'DUPLICATE_SOURCE_SCOPE', message: '교과서 파일 선택이 중복되었습니다.' }, { status: 400 });
  }
  const sources = await db.query<{ id: string; status: string }>(
    'select id, status from source_files where id = any($1::uuid[]) and deleted_at is null',
    [input.sourceFileIds],
  );
  if (sources.rowCount !== input.sourceFileIds.length || sources.rows.some((source) => source.status !== 'READY')) {
    return NextResponse.json({ code: 'SOURCE_NOT_READY', message: '처리가 완료된 교과서만 질문 생성에 사용할 수 있습니다.' }, { status: 409 });
  }

  const id = randomUUID();
  const progress = {
    currentStage: 0,
    completedQuestions: 0,
    failedQuestions: 0,
    stages: GENERATION_STAGES.map((label, index) => ({ index: index + 1, label, state: 'PENDING' })),
  };
  const conditions = {
    subject: input.subject,
    grade: input.grade,
    units: input.units,
    purpose: input.purpose,
    questionType: input.questionType,
    difficulty: input.difficulty,
    direction: input.direction,
    chunkCount: input.chunkCount,
    crossUnit: input.crossUnit,
  };
  await db.query(
    `insert into generation_batches(
       id, state, requested_count, conditions, source_scope, generation_model,
       prompt_version, progress
     ) values ($1, 'QUEUED', $2, $3::jsonb, $4::jsonb, $5, 'question-generation-v1', $6::jsonb)`,
    [
      id,
      input.requestedCount,
      JSON.stringify(conditions),
      JSON.stringify({ sourceFileIds: input.sourceFileIds }),
      process.env.GEMINI_GENERATION_MODEL ?? 'configured-via-env',
      JSON.stringify(progress),
    ],
  );
  const job = await enqueueJob({
    kind: 'question.generate',
    payload: { batchId: id },
    idempotencyKey: `question.generate:${id}:v1`,
    maxAttempts: 3,
  });
  return NextResponse.json({ id, jobId: job.id, state: 'QUEUED', progress }, { status: 201 });
}
