import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { commandRun, createRun } from '@/server/runs/service';
import { scoreRun } from '@/server/scoring/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;
let scoreProfileId: string;

beforeAll(async () => {
  await migrate();
  datasetVersionId = await createRealPublishedDataset(1);
  const profile = await db.query<{ id: string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,content_hash
     ) values($1,'엔진 런타임 검사','["response_present"]'::jsonb,'{}'::jsonb,'응답 존재 검사','temporary')
     returning id`,
    [`engine-runtime-${randomUUID()}`],
  );
  scoreProfileId = profile.rows[0]!.id;
});

afterAll(async () => {
  await db.end();
});

async function createEngineRun(title: string) {
  return createRun({
    title,
    datasetVersionId,
    scoreProfileId,
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거로 답하라.',
    questionLimit: 1,
    models: [{
      providerKey: 'gemini',
      displayName: 'Gemini',
      modelId: 'candidate-v1',
      protocol: 'gemini',
    }],
  });
}

async function tamperPinnedEngine(runId: string) {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      'alter table benchmark_runs disable trigger benchmark_runs_scoring_engine_immutable',
    );
    await client.query(
      `update benchmark_runs
          set scoring_engine_snapshot=jsonb_set(
            scoring_engine_snapshot,
            '{definition,judge,sampling,maxOutputTokens}',
            '4096'::jsonb
          )
        where id=$1`,
      [runId],
    );
    await client.query(
      'alter table benchmark_runs enable trigger benchmark_runs_scoring_engine_immutable',
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

test('blocks queueing when the pinned engine definition differs from runtime rules', async () => {
  const run = await createEngineRun(`엔진 불일치 실행 ${randomUUID()}`);
  await tamperPinnedEngine(run.id);

  await expect(commandRun(run.id, 'QUEUE')).rejects.toMatchObject({
    code: 'SCORING_ENGINE_REPLACEMENT_REQUIRED',
  });
  const stored = await db.query<{ state: string }>(
    'select state from benchmark_runs where id=$1',
    [run.id],
  );
  expect(stored.rows[0]?.state).toBe('DRAFT');
});

test('fails an active scoring run once when its engine cannot be verified', async () => {
  const run = await createEngineRun(`채점 엔진 불일치 ${randomUUID()}`);
  await tamperPinnedEngine(run.id);
  await db.query(
    `update benchmark_runs set state='SCORING',updated_at=now() where id=$1`,
    [run.id],
  );

  await expect(scoreRun(run.id)).rejects.toMatchObject({
    code: 'SCORING_ENGINE_REPLACEMENT_REQUIRED',
  });
  const stored = await db.query<{
    state: string;
    code: string;
    events: string;
  }>(
    `select br.state,br.last_scoring_error->>'code' code,
       (select count(*) from job_events
        where aggregate_type='benchmark_run'
          and aggregate_id=br.id
          and event_type='RUN_SCORING_ENGINE_REPLACEMENT_REQUIRED')::text events
     from benchmark_runs br where br.id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state: 'FAILED',
    code: 'SCORING_ENGINE_REPLACEMENT_REQUIRED',
    events: '1',
  });
});
