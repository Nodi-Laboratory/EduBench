import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('uses one read-only repeatable-read client so a boundary event remains after the snapshot cursor', async () => {
  const aggregateId = randomUUID();
  const initial = await db.query<{ id: string }>(
    `insert into job_events(aggregate_type,aggregate_id,event_type)
     values('source',$1,'SNAPSHOT_INITIAL')
     returning id::text`,
    [aggregateId],
  );
  let signalSnapshotRead!: () => void;
  const snapshotRead = new Promise<void>((resolve) => {
    signalSnapshotRead = resolve;
  });
  let releaseSnapshot!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });

  try {
    const snapshotPromise = withReadOnlyRepeatableReadTransaction(async (client) => {
      const settings = await client.query<{
        isolation: string;
        read_only: string;
        pid: number;
      }>(
        `select current_setting('transaction_isolation') isolation,
                current_setting('transaction_read_only') read_only,
                pg_backend_pid() pid`,
      );
      const first = await client.query<{ cursor: string; pid: number }>(
        `select coalesce(max(id),0)::text cursor,pg_backend_pid() pid
           from job_events
          where aggregate_type='source' and aggregate_id=$1
          group by pg_backend_pid()`,
        [aggregateId],
      );
      signalSnapshotRead();
      await release;
      const second = await client.query<{ cursor: string; pid: number }>(
        `select coalesce(max(id),0)::text cursor,pg_backend_pid() pid
           from job_events
          where aggregate_type='source' and aggregate_id=$1
          group by pg_backend_pid()`,
        [aggregateId],
      );
      return {
        settings: settings.rows[0]!,
        first: first.rows[0]!,
        second: second.rows[0]!,
      };
    });

    await snapshotRead;
    const boundary = await db.query<{ id: string }>(
      `insert into job_events(aggregate_type,aggregate_id,event_type)
       values('source',$1,'SNAPSHOT_BOUNDARY')
       returning id::text`,
      [aggregateId],
    );
    releaseSnapshot();
    const snapshot = await snapshotPromise;

    expect(snapshot.settings).toMatchObject({
      isolation: 'repeatable read',
      read_only: 'on',
    });
    expect(snapshot.first.pid).toBe(snapshot.settings.pid);
    expect(snapshot.second.pid).toBe(snapshot.settings.pid);
    expect(snapshot.first.cursor).toBe(initial.rows[0]!.id);
    expect(snapshot.second.cursor).toBe(initial.rows[0]!.id);
    expect(boundary.rows[0]!.id).not.toBe(snapshot.second.cursor);
  } finally {
    releaseSnapshot();
    await db.query(
      `delete from job_events
        where aggregate_type='source' and aggregate_id=$1`,
      [aggregateId],
    );
  }
});
