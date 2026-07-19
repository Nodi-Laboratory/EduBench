import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { GET, POST } from '@/app/api/sources/route';

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
