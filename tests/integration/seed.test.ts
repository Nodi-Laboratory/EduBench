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

test('bootstraps runtime configuration without inserting sample questions, datasets, or runs', async () => {
  await seedDatabase();
  await seedDatabase();

  const providers = await db.query<{ count: string }>('select count(*) from provider_configs');
  const questions = await db.query<{ count: string }>(
    `select count(*) from questions where public_id like 'SAMPLE-Q-%'`,
  );
  const datasets = await db.query<{ count: string }>(`select count(*) from dataset_versions where distribution->>'sample_data'='true'`);
  const runs = await db.query<{ count: string }>(
    `select count(*) from benchmark_runs where public_id like 'SAMPLE-RUN-%' or parameters->>'sample_data'='true'`,
  );
  const scoreProfiles = await db.query<{ count: string }>('select count(*) from score_profiles');

  expect(Number(providers.rows[0]?.count)).toBe(3);
  expect(Number(scoreProfiles.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  expect(Number(questions.rows[0]?.count)).toBe(0);
  expect(Number(datasets.rows[0]?.count)).toBe(0);
  expect(Number(runs.rows[0]?.count)).toBe(0);
});
