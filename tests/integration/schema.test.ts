import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('installs vector and the auditable benchmark tables', async () => {
  const tableResult = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const tables = tableResult.rows.map((row) => row.table_name);

  expect(tables).toEqual(expect.arrayContaining([
    'source_files',
    'source_chunks',
    'questions',
    'question_revisions',
    'dataset_versions',
    'benchmark_runs',
    'run_items',
    'model_responses',
    'scores',
    'job_events',
    'price_profiles',
  ]));

  const extension = await db.query<{ exists: boolean }>(
    `select exists(select 1 from pg_extension where extname = 'vector') as exists`,
  );
  expect(extension.rows[0]?.exists).toBe(true);
});

test('migration runner is idempotent', async () => {
  const first = await migrate();
  const second = await migrate();
  expect(first.applied).toBe(0);
  expect(second.applied).toBe(0);
});
