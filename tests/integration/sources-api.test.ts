import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { GET, POST } from '@/app/api/sources/route';
import { GET as GET_ACTIVITY } from '@/app/api/sources/[id]/activity/route';
import { POST as CANCEL } from '@/app/api/sources/[id]/cancel/route';
import { DELETE } from '@/app/api/sources/[id]/route';

beforeAll(async () => {
  await migrate();
  process.env.STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'edubench-sources-'));
});

beforeEach(async () => {
  await db.query(`delete from job_events where job_id in (select id from jobs where kind = 'document.parse')`);
  await db.query(`delete from jobs where kind = 'document.parse'`);
  await db.query('delete from source_chunks');
  await db.query('delete from source_revisions');
  await db.query('delete from source_files');
});

afterAll(async () => {
  await db.end();
});

function uploadRequest() {
  const form = new FormData();
  form.set('file', new File(['%PDF-1.7\nfixture'], 'science-2.pdf', { type: 'application/pdf' }));
  form.set('subject', '과학');
  form.set('grade', '중학교 2학년');
  return new Request('http://localhost/api/sources', { method: 'POST', body: form });
}

test('stores one PDF and enqueues one idempotent parse job', async () => {
  const first = await POST(uploadRequest());
  const second = await POST(uploadRequest());
  const firstBody = await first.json();
  const secondBody = await second.json();

  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  expect(firstBody.existing).toBe(false);
  expect(secondBody).toMatchObject({ existing: true, id: firstBody.id });

  const sourceCount = await db.query<{ count: string }>('select count(*) from source_files');
  const jobCount = await db.query<{ count: string }>(`select count(*) from jobs where kind = 'document.parse'`);
  expect(Number(sourceCount.rows[0]?.count)).toBe(1);
  expect(Number(jobCount.rows[0]?.count)).toBe(1);
});

test('rejects a non-PDF upload and lists stored sources', async () => {
  const invalid = new FormData();
  invalid.set('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  const response = await POST(new Request('http://localhost/api/sources', { method: 'POST', body: invalid }));
  expect(response.status).toBe(400);

  await POST(uploadRequest());
  const list = await GET();
  const body = await list.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ original_name: 'science-2.pdf', status: 'UPLOADED' });
});

test('lists source processing events and cancels its active parse job', async () => {
  const upload = await POST(uploadRequest());
  const { id, jobId } = await upload.json();

  const activity = await GET_ACTIVITY(new Request(`http://localhost/api/sources/${id}/activity`), {
    params: Promise.resolve({ id }),
  });
  const activityBody = await activity.json();
  expect(activityBody.source.id).toBe(id);
  expect(activityBody.events[0]).toMatchObject({ event_type: 'JOB_ENQUEUED' });

  const cancelled = await CANCEL(new Request(`http://localhost/api/sources/${id}/cancel`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ jobId, state: 'CANCELLED' });

  const rows = await db.query<{ job_state: string; source_status: string }>(
    `select j.state as job_state, s.status as source_status
       from jobs j join source_files s on s.id = (j.payload->>'sourceId')::uuid
      where j.id = $1`,
    [jobId],
  );
  expect(rows.rows[0]).toEqual({ job_state: 'CANCELLED', source_status: 'CANCELLED' });
});

test('stores different contents with the same filename as separate sources', async () => {
  const first = await POST(uploadRequest());
  const secondForm = new FormData();
  secondForm.set('file', new File(['%PDF-1.7\ndifferent'], 'science-2.pdf', { type: 'application/pdf' }));
  const second = await POST(new Request('http://localhost/api/sources', { method: 'POST', body: secondForm }));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect((await first.json()).id).not.toBe((await second.json()).id);
});

test('soft deletes a source, cancels its job, and restores it when the same file is uploaded again', async () => {
  const upload = await POST(uploadRequest());
  const { id } = await upload.json();
  const removed = await DELETE(new Request(`http://localhost/api/sources/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
  expect(removed.status).toBe(200);
  expect((await GET().then((response) => response.json())).items).toHaveLength(0);

  const restored = await POST(uploadRequest());
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ id, restored: true });
  expect((await GET().then((response) => response.json())).items).toHaveLength(1);
});
