import { db } from '@/server/db/pool';

export async function recordGenerationEvent(
  batchId: string,
  jobId: string | null,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `insert into job_events(job_id, aggregate_type, aggregate_id, event_type, payload)
     values ($1, 'generation', $2, $3, $4::jsonb)`,
    [jobId, batchId, eventType, JSON.stringify(payload)],
  );
}
