import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import {
  claimRunItems,
  commandRun,
  createRun,
  failRunItem,
  retryFailedRunItems,
} from '@/server/runs/service';

beforeAll(async () => {
  await migrate();
  await seedDatabase();
});

afterAll(async () => {
  await db.end();
});

test('creates the complete question × model execution matrix', async () => {
  const run = await createRun({
    title: `통합 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId: '10000000-0000-0000-0000-000000000001',
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '근거에 따라 답하라.',
    questionLimit: 5,
    models: [
      { providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' },
      { providerKey: 'openai', displayName: 'OpenAI', modelId: 'openai-test', protocol: 'openai-responses' },
    ],
  });

  expect(run).toMatchObject({ state: 'DRAFT', totalItems: 10 });
  const matrix = await db.query<{ count: string }>(
    'select count(*) from run_items where benchmark_run_id = $1', [run.id],
  );
  expect(Number(matrix.rows[0]?.count)).toBe(10);
});

test('pause prevents new claims, resume restores them, and failed items retry explicitly', async () => {
  const run = await createRun({
    title: `통제 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId: '10000000-0000-0000-0000-000000000001',
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '근거에 따라 답하라.',
    questionLimit: 3,
    models: [
      { providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' },
    ],
  });

  expect((await commandRun(run.id, 'QUEUE')).state).toBe('QUEUED');
  expect((await commandRun(run.id, 'START')).state).toBe('RUNNING');
  const [claimed] = await claimRunItems(run.id, 'worker-a', 1, 30_000);
  expect(claimed?.state).toBe('LEASED');

  expect((await commandRun(run.id, 'PAUSE')).state).toBe('PAUSED');
  expect(await claimRunItems(run.id, 'worker-b', 2, 30_000)).toEqual([]);
  await failRunItem(claimed!.id, 'worker-a', 'PROVIDER_5XX', 'upstream unavailable');

  expect(await retryFailedRunItems(run.id)).toBe(1);
  expect((await commandRun(run.id, 'RESUME')).state).toBe('RUNNING');
  expect(await claimRunItems(run.id, 'worker-b', 3, 30_000)).toHaveLength(3);

  const events = await db.query<{ event_type: string }>(
    `select event_type from job_events
     where aggregate_type = 'benchmark_run' and aggregate_id = $1 order by id`,
    [run.id],
  );
  expect(events.rows.map((event) => event.event_type)).toEqual(expect.arrayContaining([
    'RUN_CREATED', 'RUN_QUEUED', 'RUN_STARTED', 'RUN_PAUSED', 'RUN_ITEM_FAILED', 'RUN_ITEMS_RETRIED', 'RUN_RESUMED',
  ]));
});
