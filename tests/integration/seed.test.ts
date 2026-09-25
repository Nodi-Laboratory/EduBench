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

  const providers = await db.query<{
    provider_key:string;
    display_name:string;
    protocol:string;
    model_id:string | null;
  }>(
    `select provider_key,display_name,protocol,model_id
     from provider_configs order by provider_key`,
  );
  const questions = await db.query<{ count: string }>(
    `select count(*) from questions where public_id like 'SAMPLE-Q-%'`,
  );
  const datasets = await db.query<{ count: string }>(`select count(*) from dataset_versions where distribution->>'sample_data'='true'`);
  const runs = await db.query<{ count: string }>(
    `select count(*) from benchmark_runs where public_id like 'SAMPLE-RUN-%' or parameters->>'sample_data'='true'`,
  );
  const scoreProfiles = await db.query<{ count: string }>('select count(*) from score_profiles');

  expect(providers.rows).toEqual([
    {
      provider_key:'exaone',
      display_name:'EXAONE',
      protocol:'openai-compatible',
      model_id:'LGAI-EXAONE/K-EXAONE-236B-A23B',
    },
    {
      provider_key:'gemini',
      display_name:'Gemini',
      protocol:'gemini',
      model_id:'gemini-3.5-flash',
    },
    {
      provider_key:'openai',
      display_name:'OpenAI',
      protocol:'openai-responses',
      model_id:process.env.OPENAI_MODEL || 'gpt-5.5',
    },
    {
      provider_key:'upstage',
      display_name:'Upstage',
      protocol:'openai-compatible',
      model_id:'solar-pro3',
    },
  ]);
  expect(Number(scoreProfiles.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  expect(Number(questions.rows[0]?.count)).toBe(0);
  expect(Number(datasets.rows[0]?.count)).toBe(0);
  expect(Number(runs.rows[0]?.count)).toBe(0);
});
