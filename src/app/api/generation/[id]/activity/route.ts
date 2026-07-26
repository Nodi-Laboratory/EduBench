import { NextResponse } from 'next/server';
import {
  readActivityEventCursor,
  readActivityEventHistory,
} from '@/server/activity/event-stream';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const includeHistory = new URL(request.url).searchParams.get('history') !== '0';
  const snapshot = await withReadOnlyRepeatableReadTransaction(async (client) => {
  const batch = await client.query(
    `select id, state, requested_count, conditions, source_scope, generation_model,
            prompt_version, progress, created_at, updated_at
       from generation_batches where id = $1`,
    [id],
  );
  if (!batch.rows[0]) return null;

  const job = await client.query(
    `select id, state, attempts, max_attempts, created_at, updated_at, completed_at,
            last_error_code, last_error_message, result
       from jobs where kind = 'question.generate' and payload->>'batchId' = $1
      order by created_at desc limit 1`,
    [id],
  );
  const events = includeHistory
    ? await readActivityEventHistory(client, 'generation', id)
    : null;
  const questions = await client.query(
    `select q.public_id, q.status, qr.question_text, qr.answer_text,
            qr.design_summary, qr.evidence_summary, q.created_at
       from questions q
       join question_revisions qr on qr.question_id = q.id and qr.revision = q.current_revision
      where q.generation_batch_id = $1 and q.deleted_at is null
      order by q.created_at, q.public_id`,
    [id],
  );
  const items = await client.query<{
    id: string;
    ordinal: number;
    state: string;
    attempts: number;
    retryable: boolean;
    direction: Record<string, unknown> | null;
    error_code: string | null;
    error_message: string | null;
    claimed_job_id: string | null;
    claimed_job_attempt: number | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
    retrieval_id: string | null;
    retrieval_attempt: number | null;
    retrieval_query_text: string | null;
    retrieval_candidate_scope: Record<string, unknown> | null;
    retrieval_selected_chunks: unknown[] | null;
    retrieval_created_at: string | null;
    question_id: string | null;
    question_public_id: string | null;
  }>(
    `select item.id,item.ordinal,item.state,item.attempts,item.retryable,item.direction,
            item.error_code,item.error_message,item.claimed_job_id,item.claimed_job_attempt,
            item.started_at,item.completed_at,item.created_at,item.updated_at,
            retrieval.id as retrieval_id,retrieval.attempt as retrieval_attempt,
            retrieval.query_text as retrieval_query_text,
            retrieval.candidate_scope as retrieval_candidate_scope,
            retrieval.selected_chunks as retrieval_selected_chunks,
            retrieval.created_at as retrieval_created_at,
            question.id as question_id,question.public_id as question_public_id
       from generation_items item
       left join lateral (
         select id,attempt,query_text,candidate_scope,selected_chunks,created_at
           from generation_retrievals
          where generation_item_id=item.id
          order by attempt desc,created_at desc
          limit 1
       ) retrieval on true
       left join questions question
         on question.generation_item_id=item.id
        and question.deleted_at is null
      where item.generation_batch_id=$1
      order by item.ordinal`,
    [id],
  );
  const activeJob = await client.query<{ active: boolean }>(
    `select exists(
       select 1
         from jobs
        where kind='question.generate'
          and payload->>'batchId'=$1
          and (
            state in ('PENDING','RETRY_WAIT')
            or (state='LEASED' and lease_expires_at>now())
          )
     ) as active`,
    [id],
  );
  const itemRecords = items.rows.map((item) => ({
    id: item.id,
    ordinal: item.ordinal,
    state: item.state,
    attempts: item.attempts,
    retryable: item.retryable,
    direction: item.direction,
    error: item.error_code || item.error_message
      ? { code: item.error_code, message: item.error_message, retryable: item.retryable }
      : null,
    claimedJobId: item.claimed_job_id,
    claimedJobAttempt: item.claimed_job_attempt,
    latestRetrieval: item.retrieval_id ? {
      id: item.retrieval_id,
      attempt: item.retrieval_attempt,
      queryText: item.retrieval_query_text,
      candidateScope: item.retrieval_candidate_scope,
      selectedChunks: item.retrieval_selected_chunks,
      createdAt: item.retrieval_created_at,
    } : null,
    questionId: item.question_id,
    questionPublicId: item.question_public_id,
    startedAt: item.started_at,
    completedAt: item.completed_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }));
  const hasActiveJob = activeJob.rows[0]?.active ?? false;
  const eventCursor = await readActivityEventCursor(client, 'generation', id);
  return {
    batch: batch.rows[0],
    job: job.rows[0] ?? null,
    eventCursor,
    ...(events ? {
      events: events.map((event) => ({
        id: event.id,
        event_type: event.eventType,
        payload: event.payload,
        created_at: event.createdAt.toISOString(),
      })),
    } : {}),
    questions: questions.rows,
    items: itemRecords,
    canResume: batch.rows[0].state !== 'COMPLETED'
      && !hasActiveJob
      && itemRecords.some((item) =>
        item.state === 'PENDING'
         || item.state === 'RUNNING'
         || (item.state === 'FAILED' && item.retryable)),
  };
  });
  return snapshot
    ? NextResponse.json(snapshot)
    : NextResponse.json({ code: 'GENERATION_BATCH_NOT_FOUND' }, { status: 404 });
}
