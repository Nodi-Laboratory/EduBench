import type { PoolClient } from 'pg';
import {
  INITIAL_EVENT_CURSOR,
  selectRequestEventCursor,
  type EventCursor,
} from '@/domain/event-cursor';
import { db } from '@/server/db/pool';
import { sanitizeActivityEventPayload } from '@/server/activity/event-stream';

type Queryable = Pick<PoolClient, 'query'>;

export type ControlRoomEventRow = {
  id: EventCursor;
  aggregate_type: string;
  aggregate_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  job_id: string | null;
  job_kind: string | null;
  job_payload: Record<string, unknown> | null;
  label: string | null;
};

export type ControlRoomEventEnvelope = {
  id: EventCursor;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  stage: string;
  state: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type ControlRoomEventReader = (
  after: EventCursor,
  limit: number,
) => Promise<ControlRoomEventEnvelope[]>;

function referencedAggregate(row: ControlRoomEventRow): {
  aggregateType: string;
  aggregateId: string;
} {
  if (row.aggregate_type !== 'job' && row.aggregate_id) {
    return {
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
    };
  }
  const sourceId = row.job_payload?.sourceId;
  if (typeof sourceId === 'string') {
    return { aggregateType: 'source', aggregateId: sourceId };
  }
  const batchId = row.job_payload?.batchId;
  if (typeof batchId === 'string') {
    return { aggregateType: 'generation', aggregateId: batchId };
  }
  const runId = row.job_payload?.runId;
  if (typeof runId === 'string') {
    return { aggregateType: 'benchmark_run', aggregateId: runId };
  }
  return {
    aggregateType: row.aggregate_type || 'job',
    aggregateId: row.aggregate_id ?? row.job_id ?? '',
  };
}

export function controlRoomEventStage(eventType: string): string {
  if (/^(RUN_SCORING|SCORE_|JUDGE_)/.test(eventType)) return 'SCORING';
  if (/^(DOCUMENT_|PIPELINE_)/.test(eventType)) return 'PARSING';
  if (/^(CHUNKING_|TABLE_OF_CONTENTS_)/.test(eventType)) return 'CHUNKING';
  if (/^(GEMINI_EMBEDDING_|EMBEDDING_)/.test(eventType)) return 'EMBEDDING';
  if (/^QUESTION_DIRECTION_/.test(eventType)) return 'DIRECTION';
  if (/^(QUESTION_RETRIEVAL_|RETRIEVAL_)/.test(eventType)) return 'RETRIEVAL';
  if (/^(QUESTION_GENERATION_|GENERATION_)/.test(eventType)) {
    return 'QUESTION_GENERATION';
  }
  if (/^RUN_/.test(eventType)) return 'BENCHMARK';
  if (/^JOB_/.test(eventType)) return 'QUEUE';
  return 'SYSTEM';
}

export function controlRoomEventState(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  if (eventType === 'JOB_RELEASED_ON_SHUTDOWN') return 'RETRY_WAIT';
  if (/(?:FAILED|FAILURE|TERMINAL_FAILED|ERROR)$/.test(eventType)) return 'FAILED';
  if (/(?:CANCELLED|STOPPED)$/.test(eventType)) return 'CANCELLED';
  if (/(?:PAUSED)$/.test(eventType)) return 'PAUSED';
  if (/(?:RETRY|RETRIED|RETRY_SCHEDULED)$/.test(eventType)) return 'RETRY_WAIT';
  if (/(?:COMPLETED|SUCCEEDED|PERSISTED|VERIFIED|ALIGNED|EXTRACTED|RENDERED)$/.test(eventType)) {
    return 'SUCCEEDED';
  }
  if (/(?:STARTED|CLAIMED|REQUESTED|RECEIVED)$/.test(eventType)) return 'RUNNING';
  if (/(?:ENQUEUED|QUEUED|CREATED)$/.test(eventType)) return 'PENDING';
  return typeof payload.state === 'string' ? payload.state : 'INFO';
}

function eventTypeLabel(eventType: string): string {
  return eventType
    .toLowerCase()
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function eventSummary(row: ControlRoomEventRow): string {
  const detail = typeof row.payload.message === 'string' && row.payload.message.trim()
    ? row.payload.message.trim()
    : eventTypeLabel(row.event_type);
  return row.label ? `${row.label} · ${detail}` : detail;
}

export function mapControlRoomEventRow(
  row: ControlRoomEventRow,
): ControlRoomEventEnvelope {
  const aggregate = referencedAggregate(row);
  const payload = aggregate.aggregateType === 'generation'
    ? sanitizeActivityEventPayload('generation', row.event_type, row.payload)
    : row.payload;
  return {
    id: row.id,
    aggregateType: aggregate.aggregateType,
    aggregateId: aggregate.aggregateId,
    eventType: row.event_type,
    stage: controlRoomEventStage(row.event_type),
    state: controlRoomEventState(row.event_type, payload),
    summary: eventSummary(row),
    payload,
    createdAt: row.created_at.toISOString(),
  };
}

export async function readControlRoomEvents(
  queryable: Queryable,
  after: EventCursor | string = INITIAL_EVENT_CURSOR,
  limit = 200,
): Promise<ControlRoomEventEnvelope[]> {
  const result = await queryable.query<ControlRoomEventRow>(
    `with resolved as (
       select e.id::text,e.aggregate_type,e.aggregate_id::text,
              e.event_type,e.payload,e.created_at,e.job_id::text,
              j.kind job_kind,j.payload job_payload,
              case
                when e.aggregate_type<>'job' and e.aggregate_id is not null
                  then e.aggregate_type
                when j.payload->>'sourceId' is not null then 'source'
                when j.payload->>'batchId' is not null then 'generation'
                when j.payload->>'runId' is not null then 'benchmark_run'
                else coalesce(e.aggregate_type,'job')
              end resolved_type,
              case
                when e.aggregate_type<>'job' and e.aggregate_id is not null
                  then e.aggregate_id::text
                when j.payload->>'sourceId' is not null then j.payload->>'sourceId'
                when j.payload->>'batchId' is not null then j.payload->>'batchId'
                when j.payload->>'runId' is not null then j.payload->>'runId'
                else coalesce(e.aggregate_id::text,e.job_id::text,'')
              end resolved_id
         from job_events e
         left join jobs j on j.id=e.job_id
        where e.id>$1::bigint
        order by e.id
        limit $2
     )
     select resolved.id,resolved.aggregate_type,resolved.aggregate_id,
            resolved.event_type,resolved.payload,resolved.created_at,
            resolved.job_id,resolved.job_kind,resolved.job_payload,
            coalesce(
              source.original_name,
              run.title,
              nullif(resolved.resolved_id,'')
            ) label
       from resolved
       left join source_files source
         on resolved.resolved_type='source'
        and source.id::text=resolved.resolved_id
       left join benchmark_runs run
         on resolved.resolved_type='benchmark_run'
        and run.id::text=resolved.resolved_id
      order by resolved.id::bigint`,
    [after, limit],
  );
  return result.rows.map(mapControlRoomEventRow);
}

export function readControlRoomEventsFromPool(
  after: EventCursor,
  limit: number,
): Promise<ControlRoomEventEnvelope[]> {
  return readControlRoomEvents(db, after, limit);
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createControlRoomEventResponse(
  request: Request,
  input: {
    readEvents?: ControlRoomEventReader;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
): Response {
  let cursor = selectRequestEventCursor({
    after: new URL(request.url).searchParams.get('after'),
    lastEventId: request.headers.get('last-event-id'),
  });
  const readEvents = input.readEvents ?? readControlRoomEventsFromPool;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  const encoder = new TextEncoder();
  let heartbeatAt = Date.now();
  let cancelled = false;
  const streamStop = new AbortController();
  const stopForRequestAbort = () => streamStop.abort();
  if (request.signal.aborted) streamStop.abort();
  else request.signal.addEventListener('abort', stopForRequestAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      try {
        while (!streamStop.signal.aborted) {
          const events = await readEvents(cursor, 200);
          if (streamStop.signal.aborted) break;
          for (const event of events) {
            cursor = event.id;
            controller.enqueue(encoder.encode(
              `id: ${event.id}\nevent: control-room\ndata: ${JSON.stringify(event)}\n\n`,
            ));
          }
          if (Date.now() - heartbeatAt >= heartbeatIntervalMs) {
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            heartbeatAt = Date.now();
          }
          await waitForNextPoll(pollIntervalMs, streamStop.signal);
        }
      } finally {
        request.signal.removeEventListener('abort', stopForRequestAbort);
        try {
          if (!cancelled) controller.close();
        } catch {
          // The browser can close its body before the request abort reaches this loop.
        }
      }
    },
    cancel() {
      cancelled = true;
      streamStop.abort();
      request.signal.removeEventListener('abort', stopForRequestAbort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
