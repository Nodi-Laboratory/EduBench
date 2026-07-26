import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { GET as exportResult } from '@/app/api/results/[id]/export/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { MockProvider } from '@/server/providers/mock';
import { beginScoringWhenExecutionFinished, createRun, retryScoringRun } from '@/server/runs/service';
import { scoreRun } from '@/server/scoring/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;

beforeAll(async () => {
  await migrate();
  datasetVersionId = await createRealPublishedDataset(1);
});

afterAll(async () => {
  await db.end();
});

async function provenanceSchemaReady(): Promise<boolean> {
  const result = await db.query<{ ready:boolean }>(
    `select
       exists(
         select 1 from information_schema.columns
         where table_schema='public' and table_name='benchmark_runs'
           and column_name='score_profile_snapshot_provenance'
       )
       and to_regprocedure('infer_score_profile_snapshot_provenance(timestamp with time zone)') is not null
       and to_regprocedure('mark_score_profile_replacement_required_runs()') is not null
       as ready`,
  );
  return Boolean(result.rows[0]?.ready);
}

async function createProfile(input: {
  versionPrefix:string;
  judgeProvider?:string | null;
  judgeModel?:string | null;
}): Promise<{ id:string; version:string; contentHash:string }> {
  const version = `${input.versionPrefix}-${randomUUID()}`;
  const result = await db.query<{ id:string; content_hash:string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,judge_provider,judge_model,content_hash
     ) values($1,$2,'["exact_match"]'::jsonb,'{}'::jsonb,'검증 루브릭',$3,$4,'temporary')
     returning id,content_hash`,
    [version, `${input.versionPrefix} 프로필`, input.judgeProvider ?? null, input.judgeModel ?? null],
  );
  return { id:result.rows[0]!.id, version, contentHash:result.rows[0]!.content_hash };
}

async function insertLegacyRun(input: {
  profile:{ id:string; version:string; contentHash:string };
  state:string;
  provenance:'LEGACY_BACKFILL_UNVERIFIED' | 'AT_CREATION_VERIFIED';
  judgeProvider?:string | null;
  judgeModel?:string | null;
}): Promise<string> {
  const id = randomUUID();
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('alter table benchmark_runs disable trigger benchmark_runs_snapshot_score_profile');
    await client.query(
      `insert into benchmark_runs(
         id,public_id,title,state,dataset_version_id,score_profile_id,
         score_profile_snapshot,score_profile_snapshot_provenance,
         price_profile_version,system_prompt,parameters,total_items,completed_items,failed_items
       ) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'test-price-v1','답하라.','{}'::jsonb,0,0,0)`,
      [
        id,
        `LEGACY-${randomUUID()}`,
        '레거시 실행',
        input.state,
        datasetVersionId,
        input.profile.id,
        JSON.stringify({
          id:input.profile.id,
          version:input.profile.version,
          title:'레거시 프로필',
          metrics:['accuracy'],
          weights:{},
          rubricPrompt:'이전 루브릭',
          judgeProvider:input.judgeProvider ?? null,
          judgeModel:input.judgeModel ?? null,
          contentHash:input.profile.contentHash,
        }),
        input.provenance,
      ],
    );
    await client.query('alter table benchmark_runs enable trigger benchmark_runs_snapshot_score_profile');
    await client.query('commit');
    return id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

test('classifies pre-0015 snapshots as unverified and forces new run snapshots to verified immutable provenance', async () => {
  const ready = await provenanceSchemaReady();
  expect(ready).toBe(true);
  if (!ready) return;

  const inferred = await db.query<{ before_0015:string; after_0015:string }>(
    `select
       infer_score_profile_snapshot_provenance(applied_at - interval '1 second') before_0015,
       infer_score_profile_snapshot_provenance(applied_at + interval '1 second') after_0015
     from schema_migrations where version='0015_score_profile_consistency.sql'`,
  );
  expect(inferred.rows[0]).toEqual({
    before_0015:'LEGACY_BACKFILL_UNVERIFIED',
    after_0015:'AT_CREATION_VERIFIED',
  });
  const missingJudge = await db.query<{ usable:boolean }>(
    `select benchmark_run_score_profile_usable(
       '{"metrics":["accuracy"],"judgeProvider":null,"judgeModel":null}'::jsonb,
       'AT_CREATION_VERIFIED'
     ) usable`,
  );
  expect(missingJudge.rows[0]?.usable).toBe(false);

  const profile = await createProfile({ versionPrefix:'verified-snapshot' });
  const run = await createRun({
    title:`검증 스냅샷 ${randomUUID()}`,
    datasetVersionId,
    scoreProfileId:profile.id,
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'candidate-v1', protocol:'gemini' }],
  });
  const stored = await db.query<{ score_profile_snapshot_provenance:string }>(
    'select score_profile_snapshot_provenance from benchmark_runs where id=$1',
    [run.id],
  );
  expect(stored.rows[0]?.score_profile_snapshot_provenance).toBe('AT_CREATION_VERIFIED');
  await expect(db.query(
    `update benchmark_runs
     set score_profile_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED'
     where id=$1`,
    [run.id],
  )).rejects.toMatchObject({ code:'55000' });
});

test('upgrade marking fails a one-sided legacy scoring snapshot, preserves it, and blocks scoring and retry', async () => {
  const ready = await provenanceSchemaReady();
  expect(ready).toBe(true);
  if (!ready) return;

  const profile = await createProfile({
    versionPrefix:'legacy-upgrade',
    judgeProvider:'gemini',
    judgeModel:'recorded-judge-v1',
  });
  const runId = await insertLegacyRun({
    profile,
    state:'SCORING',
    provenance:'AT_CREATION_VERIFIED',
    judgeProvider:'gemini',
    judgeModel:null,
  });
  const snapshotBefore = await db.query<{ score_profile_snapshot:unknown }>(
    'select score_profile_snapshot from benchmark_runs where id=$1',
    [runId],
  );

  await db.query('select mark_score_profile_replacement_required_runs()');
  const marked = await db.query<{
    state:string;
    last_scoring_error:{ code:string; replacementRequired:boolean };
    score_profile_snapshot:unknown;
    events:string;
  }>(
    `select br.state,br.last_scoring_error,br.score_profile_snapshot,
       (select count(*) from job_events
        where aggregate_type='benchmark_run' and aggregate_id=br.id
          and event_type='RUN_SCORE_PROFILE_REPLACEMENT_REQUIRED')::text events
     from benchmark_runs br where br.id=$1`,
    [runId],
  );
  expect(marked.rows[0]).toMatchObject({
    state:'FAILED',
    last_scoring_error:{
      code:'SCORE_PROFILE_REPLACEMENT_REQUIRED',
      replacementRequired:true,
    },
    events:'1',
  });
  expect(marked.rows[0]?.score_profile_snapshot).toEqual(snapshotBefore.rows[0]?.score_profile_snapshot);

  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate');
  try {
    await expect(scoreRun(runId)).rejects.toMatchObject({ code:'SCORE_PROFILE_REPLACEMENT_REQUIRED' });
    await expect(retryScoringRun(runId)).rejects.toMatchObject({ code:'SCORE_PROFILE_REPLACEMENT_REQUIRED' });
    expect(judgeSpy).not.toHaveBeenCalled();
  } finally {
    judgeSpy.mockRestore();
  }
});

test('blocks scoring transition for an unverified running snapshot after preserving it during upgrade marking', async () => {
  const ready = await provenanceSchemaReady();
  expect(ready).toBe(true);
  if (!ready) return;

  const profile = await createProfile({ versionPrefix:'legacy-backfill' });
  const runId = await insertLegacyRun({
    profile,
    state:'RUNNING',
    provenance:'LEGACY_BACKFILL_UNVERIFIED',
  });
  await db.query('select mark_score_profile_replacement_required_runs()');
  const before = await db.query<{ state:string }>('select state from benchmark_runs where id=$1', [runId]);
  expect(before.rows[0]?.state).toBe('RUNNING');

  await expect(beginScoringWhenExecutionFinished(runId))
    .rejects.toMatchObject({ code:'SCORE_PROFILE_REPLACEMENT_REQUIRED' });
  const after = await db.query<{ state:string; code:string }>(
    `select state,last_scoring_error->>'code' code from benchmark_runs where id=$1`,
    [runId],
  );
  expect(after.rows[0]).toEqual({ state:'FAILED', code:'SCORE_PROFILE_REPLACEMENT_REQUIRED' });
});

test('surfaces snapshot provenance in JSON and CSV and rejects an unverified official PDF', async () => {
  const ready = await provenanceSchemaReady();
  expect(ready).toBe(true);
  if (!ready) return;

  const profile = await createProfile({ versionPrefix:'unverified-export' });
  const runId = await insertLegacyRun({
    profile,
    state:'COMPLETED',
    provenance:'LEGACY_BACKFILL_UNVERIFIED',
  });
  await db.query('select mark_score_profile_replacement_required_runs()');

  const json = await exportResult(
    new Request(`http://localhost/api/results/${runId}/export?format=json`),
    { params:Promise.resolve({ id:runId }) },
  );
  expect(json.status).toBe(200);
  const jsonBody = await json.json();
  expect(jsonBody.run.score_profile_snapshot_provenance).toBe('LEGACY_BACKFILL_UNVERIFIED');

  const csv = await exportResult(
    new Request(`http://localhost/api/results/${runId}/export?format=csv`),
    { params:Promise.resolve({ id:runId }) },
  );
  expect(csv.status).toBe(200);
  expect(await csv.text()).toContain('score_profile_snapshot_provenance');

  const pdf = await exportResult(
    new Request(`http://localhost/api/results/${runId}/export?format=pdf`),
    { params:Promise.resolve({ id:runId }) },
  );
  expect(pdf.status).toBe(409);
  await expect(pdf.json()).resolves.toMatchObject({
    code:'SCORE_PROFILE_REPLACEMENT_REQUIRED',
    message:expect.stringContaining('새 실행'),
  });
});
