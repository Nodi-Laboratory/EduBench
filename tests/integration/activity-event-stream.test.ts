import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { readActivityEvents } from '@/server/activity/event-stream';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test.each([
  {
    aggregate: 'source' as const,
    jobKind: 'document.parse',
    payloadKey: 'sourceId',
    directType: 'DOCUMENT_PARSE_STARTED',
  },
  {
    aggregate: 'generation' as const,
    jobKind: 'question.generate',
    payloadKey: 'batchId',
    directType: 'GENERATION_STARTED',
  },
])('orders and unions direct $aggregate events with associated job lifecycle events', async ({
  aggregate,
  jobKind,
  payloadKey,
  directType,
}) => {
  const client = await db.connect();
  const aggregateId = randomUUID();
  const jobId = randomUUID();
  try {
    await client.query('begin');
    await client.query(
      `insert into jobs(id,kind,payload,idempotency_key)
       values($1,$2,$3::jsonb,$4)`,
      [jobId, jobKind, JSON.stringify({ [payloadKey]: aggregateId }), randomUUID()],
    );
    const direct = await client.query<{ id: string }>(
      `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
       values($1,$2,$3,'{"direct":true}'::jsonb)
       returning id::text`,
      [aggregate, aggregateId, directType],
    );
    const lifecycle = await client.query<{ id: string }>(
      `insert into job_events(job_id,aggregate_type,aggregate_id,event_type,payload)
       values($1,'job',$1,'JOB_CLAIMED','{"attempt":1}'::jsonb)
       returning id::text`,
      [jobId],
    );
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type)
       values($1,$2,'UNRELATED_EVENT')`,
      [aggregate, randomUUID()],
    );

    const events = await readActivityEvents(client, aggregate, aggregateId, '0', 100);
    expect(events.map((event) => event.eventType)).toEqual([directType, 'JOB_CLAIMED']);
    expect(events.map((event) => event.id)).toEqual([
      direct.rows[0]!.id,
      lifecycle.rows[0]!.id,
    ]);

    const exclusive = await readActivityEvents(
      client,
      aggregate,
      aggregateId,
      direct.rows[0]!.id,
      100,
    );
    expect(exclusive.map((event) => event.id)).toEqual([lifecycle.rows[0]!.id]);
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('keeps a cursor above 2^53 exact and accepts the PostgreSQL bigint maximum boundary', async () => {
  const client = await db.connect();
  const runId = randomUUID();
  try {
    await client.query('begin');
    await client.query(
      `update job_event_cursor_allocator
          set last_id='9007199254740992'
        where singleton=true`,
    );
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
       values('benchmark_run',$1,'RUN_LARGE_CURSOR','{}'::jsonb)`,
      [runId],
    );

    const events = await readActivityEvents(client, 'benchmark_run', runId, '9007199254740992', 100);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('9007199254740993');
    expect(typeof events[0]?.id).toBe('string');

    await expect(
      readActivityEvents(client, 'benchmark_run', runId, '9223372036854775807', 100),
    ).resolves.toEqual([]);
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('allocates event cursors in commit-safe order across concurrent transactions', async () => {
  const firstClient = await db.connect();
  const secondClient = await db.connect();
  const aggregateId = randomUUID();
  let firstCommitted = false;
  let secondCommitted = false;
  let secondInsert: Promise<{ id: string }> | null = null;

  try {
    await firstClient.query('begin');
    await secondClient.query('begin');
    const secondBackend = await secondClient.query<{ pid: number }>(
      'select pg_backend_pid() pid',
    );
    const first = await firstClient.query<{ id: string }>(
      `insert into job_events(aggregate_type,aggregate_id,event_type)
       values('source',$1,'COMMIT_ORDER_FIRST')
       returning id::text`,
      [aggregateId],
    );

    secondInsert = secondClient.query<{ id: string }>(
      `insert into job_events(aggregate_type,aggregate_id,event_type)
       values('source',$1,'COMMIT_ORDER_SECOND')
       returning id::text`,
      [aggregateId],
    ).then((result) => result.rows[0]!);

    let blockedOnAllocator = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await db.query<{ wait_event_type: string | null }>(
        'select wait_event_type from pg_stat_activity where pid=$1',
        [secondBackend.rows[0]!.pid],
      );
      if (activity.rows[0]?.wait_event_type === 'Lock') {
        blockedOnAllocator = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blockedOnAllocator).toBe(true);

    await firstClient.query('commit');
    firstCommitted = true;
    const second = await secondInsert;
    await secondClient.query('commit');
    secondCommitted = true;

    expect(BigInt(second.id)).toBeGreaterThan(BigInt(first.rows[0]!.id));
    const afterFirst = await readActivityEvents(
      db,
      'source',
      aggregateId,
      first.rows[0]!.id,
      100,
    );
    expect(afterFirst.map((event) => event.id)).toEqual([second.id]);
  } finally {
    if (!firstCommitted) await firstClient.query('rollback');
    if (!secondCommitted) {
      if (secondInsert) await secondInsert.catch(() => undefined);
      await secondClient.query('rollback');
    }
    firstClient.release();
    secondClient.release();
    await db.query(
      `delete from job_events
        where aggregate_type='source' and aggregate_id=$1`,
      [aggregateId],
    );
  }
});

test('benchmark run streams only direct benchmark events', async () => {
  const client = await db.connect();
  const runId = randomUUID();
  const jobId = randomUUID();
  try {
    await client.query('begin');
    await client.query(
      `insert into jobs(id,kind,payload,idempotency_key)
       values($1,'benchmark.execute',$2::jsonb,$3)`,
      [jobId, JSON.stringify({ runId }), randomUUID()],
    );
    await client.query(
      `insert into job_events(job_id,aggregate_type,aggregate_id,event_type)
       values($1,'job',$1,'JOB_CLAIMED')`,
      [jobId],
    );
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type)
       values('benchmark_run',$1,'RUN_STARTED')`,
      [runId],
    );

    const events = await readActivityEvents(client, 'benchmark_run', runId, '0', 100);
    expect(events.map((event) => event.eventType)).toEqual(['RUN_STARTED']);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
