import { NextResponse } from 'next/server';
import { db } from '@/server/db/pool';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const source = await db.query(
    `select id, original_name, subject, grade, status, failed_stage, failure_code,
            failure_message, created_at, updated_at
       from source_files where id = $1 and deleted_at is null`,
    [id],
  );
  if (!source.rows[0]) return NextResponse.json({ code: 'SOURCE_NOT_FOUND' }, { status: 404 });
  const events = await db.query(
    `select e.id::text, e.event_type, e.payload, e.created_at
       from job_events e
      where e.aggregate_id = $1
         or e.job_id in (
           select id from jobs where kind = 'document.parse' and payload->>'sourceId' = $1::text
         )
      order by e.id asc`,
    [id],
  );
  const job = await db.query(
    `select id, state, attempts, max_attempts, created_at, updated_at, completed_at,
            last_error_code, last_error_message, result
       from jobs where kind = 'document.parse' and payload->>'sourceId' = $1
      order by created_at desc limit 1`,
    [id],
  );
  return NextResponse.json({ source: source.rows[0], job: job.rows[0] ?? null, events: events.rows });
}
