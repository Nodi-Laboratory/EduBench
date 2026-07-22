import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { generateQuestions } from '@/server/questions/generator';

let testSourceId: string | null = null;
let testBatchId: string | null = null;

beforeAll(async () => {
  vi.stubEnv('MOCK_PROVIDERS', 'true');
  await migrate();
});

afterAll(async () => {
  if (testBatchId) {
    await db.query(`delete from question_evidence where question_id in (select id from questions where generation_batch_id=$1)`, [testBatchId]);
    await db.query(`delete from question_revisions where question_id in (select id from questions where generation_batch_id=$1)`, [testBatchId]);
    await db.query(`delete from questions where generation_batch_id=$1`, [testBatchId]);
    await db.query(`delete from generation_retrievals where generation_batch_id=$1`, [testBatchId]);
    await db.query(`delete from job_events where aggregate_type='generation' and aggregate_id=$1`, [testBatchId]);
    await db.query(`delete from generation_batches where id=$1`, [testBatchId]);
  }
  if (testSourceId) {
    await db.query(`delete from source_chunks where source_file_id=$1`, [testSourceId]);
    await db.query(`delete from source_revisions where source_file_id=$1`, [testSourceId]);
    await db.query(`delete from source_files where id=$1`, [testSourceId]);
  }
  vi.unstubAllEnvs();
  await db.end();
});

test('runs direction, retrieval, and generation independently for every question', async () => {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const batchId = randomUUID();
  testSourceId = sourceId;
  testBatchId = batchId;
  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'per-question.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model) values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  for (const [index, content] of ['속도는 위치의 시간에 따른 변화이다.', '가속도는 속도의 시간에 따른 변화이다.', '힘은 물체의 운동 상태를 변화시킨다.'].entries()) {
    await db.query(
      `insert into source_chunks(source_file_id,source_revision_id,ordinal,content,page_start,unit)
       values($1,$2,$3,$4,$3,'역학')`,
      [sourceId, revisionId, index + 1, content],
    );
  }
  await db.query(
    `insert into generation_batches(id,requested_count,conditions,source_scope,generation_model,prompt_version)
     values($1,2,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [batchId, JSON.stringify({ subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이', questionType: '구조화 서술형', difficulty: '상', direction: '선수관계를 측정', chunkCount: 2, executionMode: 'parallel' }), JSON.stringify({ sourceFileIds: [sourceId] })],
  );

  await expect(generateQuestions(batchId)).resolves.toEqual({ questions: 2 });

  const retrievals = await db.query<{ query_text: string; candidate_scope: { ordinal: number; questionDirection: { searchQuery: string } } }>(
    `select query_text,candidate_scope from generation_retrievals where generation_batch_id=$1 order by candidate_scope->>'ordinal'`,
    [batchId],
  );
  expect(retrievals.rows).toHaveLength(2);
  expect(retrievals.rows.map((row) => row.candidate_scope.ordinal)).toEqual([1, 2]);
  expect(new Set(retrievals.rows.map((row) => row.query_text)).size).toBe(2);
  expect(retrievals.rows.every((row) => row.query_text === row.candidate_scope.questionDirection.searchQuery)).toBe(true);

  const events = await db.query<{ event_type: string; ordinal: string }>(
    `select event_type,payload->>'ordinal' ordinal from job_events
     where aggregate_type='generation' and aggregate_id=$1 and payload ? 'ordinal'`,
    [batchId],
  );
  for (const ordinal of ['1', '2']) {
    expect(events.rows.filter((event) => event.ordinal === ordinal).map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'QUESTION_DIRECTION_COMPLETED', 'QUESTION_RETRIEVAL_COMPLETED', 'QUESTION_GENERATION_COMPLETED',
    ]));
  }
});
