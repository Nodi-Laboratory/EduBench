import { NextResponse } from 'next/server';
import { db } from '@/server/db/pool';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const batch = await db.query(
    `select id, state, requested_count, conditions, source_scope, generation_model,
            prompt_version, progress, created_at, updated_at
       from generation_batches where id = $1`,
    [id],
  );
  if (!batch.rows[0]) return NextResponse.json({ code: 'GENERATION_BATCH_NOT_FOUND' }, { status: 404 });

  const job = await db.query(
    `select id, state, attempts, max_attempts, created_at, updated_at, completed_at,
            last_error_code, last_error_message, result
       from jobs where kind = 'question.generate' and payload->>'batchId' = $1
      order by created_at desc limit 1`,
    [id],
  );
  const events = await db.query(
    `select e.id::text, e.event_type, e.payload, e.created_at
       from job_events e
      where (e.aggregate_type = 'generation' and e.aggregate_id = $1)
         or e.job_id in (
           select id from jobs where kind = 'question.generate' and payload->>'batchId' = $1::text
         )
      order by e.id asc`,
    [id],
  );
  const questions = await db.query(
    `select q.public_id, q.status, qr.question_text, qr.answer_text,
            qr.design_summary, qr.evidence_summary, q.created_at
       from questions q
       join question_revisions qr on qr.question_id = q.id and qr.revision = q.current_revision
      where q.generation_batch_id = $1 and q.deleted_at is null
      order by q.created_at, q.public_id`,
    [id],
  );
  return NextResponse.json({
    batch: batch.rows[0],
    job: job.rows[0] ?? null,
    events: events.rows,
    questions: questions.rows,
  });
}
