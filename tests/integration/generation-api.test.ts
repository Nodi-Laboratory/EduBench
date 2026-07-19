import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { POST } from '@/app/api/generation/route';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('creates a persistent nine-stage generation batch limited to selected files', async () => {
  const sourceId = randomUUID();
  await db.query(
    `insert into source_files(
       id, sha256, original_name, storage_path, mime_type, byte_size, subject, grade, status
     ) values ($1, $2, 'generation.pdf', 'fixture', 'application/pdf', 10, '과학', '중학교 2학년', 'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  const response = await POST(new Request('http://localhost/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: '과학',
      grade: '중학교 2학년',
      sourceFileIds: [sourceId],
      units: ['물질의 구성'],
      purpose: '핵심 개념 이해',
      questionType: '구조화 서술형',
      difficulty: '중',
      direction: '교과서 근거로 개념 관계를 설명',
      chunkCount: 8,
      crossUnit: false,
      requestedCount: 12,
    }),
  }));
  const body = await response.json();

  expect(response.status).toBe(201);
  expect(body.progress.stages).toHaveLength(9);
  const batch = await db.query<{ source_scope: { sourceFileIds: string[] } }>(
    'select source_scope from generation_batches where id = $1', [body.id],
  );
  expect(batch.rows[0]?.source_scope.sourceFileIds).toEqual([sourceId]);
  const job = await db.query<{ count: string }>(
    `select count(*) from jobs where kind = 'question.generate' and payload->>'batchId' = $1`, [body.id],
  );
  expect(Number(job.rows[0]?.count)).toBe(1);
});
