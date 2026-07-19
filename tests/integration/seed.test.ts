import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('creates a deterministic 500 by 6 sample workspace and remains idempotent', async () => {
  await seedDatabase();
  await seedDatabase();

  const providers = await db.query<{ count: string }>('select count(*) from provider_configs');
  const questions = await db.query<{ count: string }>(
    `select count(*) from questions where public_id like 'SAMPLE-Q-%'`,
  );
  const items = await db.query<{ count: string }>(
    `select count(*) from run_items ri
     join benchmark_runs br on br.id = ri.benchmark_run_id
     where br.public_id = 'SAMPLE-RUN-001'`,
  );

  expect(Number(providers.rows[0]?.count)).toBe(6);
  expect(Number(questions.rows[0]?.count)).toBe(500);
  expect(Number(items.rows[0]?.count)).toBe(3_000);
});
