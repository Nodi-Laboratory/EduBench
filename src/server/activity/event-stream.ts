import type { PoolClient } from 'pg';
import {
  INITIAL_EVENT_CURSOR,
  selectRequestEventCursor,
  type EventCursor,
} from '@/domain/event-cursor';
import { db } from '@/server/db/pool';

export const activityAggregates = ['source', 'generation', 'benchmark_run'] as const;
export type ActivityAggregate = typeof activityAggregates[number];

export type ActivityEventRecord = {
  id: EventCursor;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type ActivityEventEnvelope = {
  id: EventCursor;
  aggregate: ActivityAggregate;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Queryable = Pick<PoolClient, 'query'>;
type ActivityEventReader = (
  aggregate: ActivityAggregate,
  aggregateId: string,
  after: EventCursor,
  limit: number,
) => Promise<ActivityEventRecord[]>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function retrievalChunkSummary(value: unknown): Record<string, unknown> | null {
  const chunk = recordValue(value);
  if (!chunk || typeof chunk.chunkId !== 'string') return null;
  const allowed = [
    'chunkId',
    'rank',
    'page',
    'unit',
    'source',
    'similarity',
    'semanticRank',
    'anchorChunkId',
  ] as const;
  return Object.fromEntries(
    allowed
      .filter((key) => chunk[key] !== undefined)
      .map((key) => [key, chunk[key]]),
  );
}

export function sanitizeActivityEventPayload(
  aggregate: ActivityAggregate,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (aggregate !== 'generation' || eventType !== 'QUESTION_RETRIEVAL_COMPLETED') {
    return payload;
  }
  const rawChunks = Array.isArray(payload.chunks)
    ? payload.chunks
    : Array.isArray(payload.selectedChunks)
      ? payload.selectedChunks
      : [];
  const chunks = rawChunks
    .map(retrievalChunkSummary)
    .filter((chunk): chunk is Record<string, unknown> => chunk !== null);
  const explicitIds = Array.isArray(payload.selectedChunkIds)
    ? payload.selectedChunkIds.filter((value): value is string => typeof value === 'string')
    : [];
  const selectedChunkIds = [...new Set([
    ...explicitIds,
    ...chunks
      .map((chunk) => chunk.chunkId)
      .filter((value): value is string => typeof value === 'string'),
  ])];
  const summary = {
    ordinal: payload.ordinal,
    attempt: payload.attempt,
    queryText: payload.queryText,
    chunkCount: typeof payload.chunkCount === 'number'
      ? payload.chunkCount
      : selectedChunkIds.length,
    selectedChunkIds,
    chunks,
    queryVector: payload.queryVector,
    retrievalConfig: payload.retrievalConfig,
  };
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  );
}

function activityPredicate(aggregate: ActivityAggregate): string {
  if (aggregate === 'source') {
    return `(
      (e.aggregate_type='source' and e.aggregate_id=$1)
      or e.job_id in (
        select id from jobs
         where kind='document.parse' and payload->>'sourceId'=$1::text
      )
    )`;
  }
  if (aggregate === 'generation') {
    return `(
      (e.aggregate_type='generation' and e.aggregate_id=$1)
      or e.job_id in (
        select id from jobs
         where kind='question.generate' and payload->>'batchId'=$1::text
      )
    )`;
  }
  return `(e.aggregate_type='benchmark_run' and e.aggregate_id=$1)`;
}

export async function readActivityEvents(
  queryable: Queryable,
  aggregate: ActivityAggregate,
  aggregateId: string,
  after: EventCursor | string = INITIAL_EVENT_CURSOR,
  limit = 200,
): Promise<ActivityEventRecord[]> {
  const result = await queryable.query<{
    id: EventCursor;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `select e.id::text,e.event_type,e.payload,e.created_at
       from job_events e
      where ${activityPredicate(aggregate)}
        and e.id>$2::bigint
      order by e.id
      limit $3`,
    [aggregateId, after, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    payload: sanitizeActivityEventPayload(aggregate, row.event_type, row.payload),
    createdAt: row.created_at,
  }));
}

export async function readActivityEventHistory(
  queryable: Queryable,
  aggregate: ActivityAggregate,
  aggregateId: string,
  limit = 200,
): Promise<ActivityEventRecord[]> {
  const result = await queryable.query<{
    id: EventCursor;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `select recent.id,recent.event_type,recent.payload,recent.created_at
       from (
         select e.id::text,e.event_type,e.payload,e.created_at,e.id as numeric_id
           from job_events e
          where ${activityPredicate(aggregate)}
          order by e.id desc
          limit $2
       ) recent
      order by recent.numeric_id`,
    [aggregateId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    payload: sanitizeActivityEventPayload(aggregate, row.event_type, row.payload),
    createdAt: row.created_at,
  }));
}

export async function readActivityEventCursor(
  queryable: Queryable,
  aggregate: ActivityAggregate,
  aggregateId: string,
): Promise<EventCursor> {
  const result = await queryable.query<{ cursor: EventCursor }>(
    `select coalesce(max(e.id),0)::text as cursor
       from job_events e
      where ${activityPredicate(aggregate)}`,
    [aggregateId],
  );
  return result.rows[0]?.cursor ?? INITIAL_EVENT_CURSOR as EventCursor;
}

export async function readActivityEventsFromPool(
  aggregate: ActivityAggregate,
  aggregateId: string,
  after: EventCursor,
  limit: number,
): Promise<ActivityEventRecord[]> {
  return readActivityEvents(db, aggregate, aggregateId, after, limit);
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

export function createActivityEventResponse(
  request: Request,
  input: {
    aggregate: ActivityAggregate;
    aggregateId: string;
    readEvents?: ActivityEventReader;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
  },
): Response {
  const after = new URL(request.url).searchParams.get('after');
  let cursor = selectRequestEventCursor({
    after,
    lastEventId: request.headers.get('last-event-id'),
  });
  const readEvents = input.readEvents ?? readActivityEventsFromPool;
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
          const events = await readEvents(input.aggregate, input.aggregateId, cursor, 200);
          if (streamStop.signal.aborted) break;
          for (const event of events) {
            cursor = event.id;
            const envelope: ActivityEventEnvelope = {
              id: event.id,
              aggregate: input.aggregate,
              aggregateId: input.aggregateId,
              eventType: event.eventType,
              payload: sanitizeActivityEventPayload(
                input.aggregate,
                event.eventType,
                event.payload,
              ),
              createdAt: event.createdAt.toISOString(),
            };
            controller.enqueue(encoder.encode(
              `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(envelope)}\n\n`,
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
          // The browser may close the response body before the request abort reaches this loop.
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
