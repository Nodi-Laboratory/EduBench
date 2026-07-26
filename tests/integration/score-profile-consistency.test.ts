import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { GET as listProfiles, POST as createProfile } from '@/app/api/settings/profiles/route';
import { GET as exportResult, summarizeExportRun } from '@/app/api/results/[id]/export/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { executeRunItem } from '@/server/runs/executor';
import { getRunDetails } from '@/server/runs/details';
import { MockProvider } from '@/server/providers/mock';
import { getResultAnalytics } from '@/server/results/analytics';
import { scoreRun } from '@/server/scoring/service';
import {
  beginScoringWhenExecutionFinished,
  claimRunItems,
  commandRun,
  createRun,
  failRunItem,
} from '@/server/runs/service';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;
let twoQuestionDatasetId: string;

beforeAll(async () => {
  await migrate();
  datasetVersionId = await createRealPublishedDataset(1);
  twoQuestionDatasetId = await createRealPublishedDataset(2);
});

afterAll(async () => {
  await db.end();
});

test('validates weights and requires the complete Judge provider/model pair', async () => {
  const invalidWeight = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score', version:`invalid-weight-${randomUUID()}`, title:'잘못된 가중치',
      metrics:['accuracy'], weights:{ accuracy:-1 }, judgeProvider:'gemini', judgeModel:'judge-exact',
    }),
  }));
  expect(invalidWeight.status).toBe(400);

  const incompleteJudge = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score', version:`missing-judge-${randomUUID()}`, title:'불완전 Judge',
      metrics:['accuracy'], weights:{ accuracy:1 }, judgeProvider:'gemini',
    }),
  }));
  expect(incompleteJudge.status).toBe(400);

  await expect(db.query(
    `insert into score_profiles(version,title,metrics,weights,judge_provider)
     values($1,'DB pair 검사','["accuracy"]'::jsonb,'{}'::jsonb,'gemini')`,
    [`invalid-db-pair-${randomUUID()}`],
  )).rejects.toMatchObject({ code:'23514' });

  const unsupportedProvider = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score', version:`unsupported-provider-${randomUUID()}`, title:'지원하지 않는 Judge',
      metrics:['accuracy'], weights:{ accuracy:1 }, judgeProvider:'gemni-typo', judgeModel:'judge-v1',
    }),
  }));
  expect(unsupportedProvider.status).toBe(400);
});

test('rejects legacy Judge provenance and missing exact Judge configuration before creating a run', async () => {
  const legacyVersion = `legacy-judge-${randomUUID()}`;
  const legacy = await db.query<{ id:string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,judge_provider,judge_model,content_hash
     ) values(
       $1,'출처 미확정 Judge','["accuracy"]'::jsonb,'{}'::jsonb,'평가',
       'gemini','legacy-environment-default-unrecorded','temporary'
     ) returning id`,
    [legacyVersion],
  );
  await expect(createRun({
    title:`레거시 프로필 거부 ${randomUUID()}`,
    datasetVersionId,
    scoreProfileId:legacy.rows[0]!.id,
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'candidate-v1', protocol:'gemini' }],
  })).rejects.toMatchObject({ code:'SCORE_PROFILE_REPLACEMENT_REQUIRED' });

  const configuredVersion = `missing-credential-${randomUUID()}`;
  const configured = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score', version:configuredVersion, title:'환경 사전 검증',
      metrics:['accuracy'], weights:{ accuracy:1 },
      judgeProvider:'gemini', judgeModel:'judge-exact-v9',
    }),
  }));
  expect(configured.status).toBe(201);
  const profile = await db.query<{ id:string }>('select id from score_profiles where version=$1', [configuredVersion]);
  const previousMock = process.env.MOCK_PROVIDERS;
  const previousGoogleKey = process.env.GOOGLE_API_KEY;
  process.env.MOCK_PROVIDERS = 'false';
  delete process.env.GOOGLE_API_KEY;
  try {
    await expect(createRun({
      title:`Judge 환경 누락 ${randomUUID()}`,
      datasetVersionId,
      scoreProfileId:profile.rows[0]!.id,
      priceProfileVersion:'test-price-v1',
      systemPrompt:'답하라.',
      questionLimit:1,
      models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'candidate-v1', protocol:'gemini' }],
    })).rejects.toMatchObject({ code:'SCORING_JUDGE_NOT_CONFIGURED' });
  } finally {
    if (previousMock == null) delete process.env.MOCK_PROVIDERS;
    else process.env.MOCK_PROVIDERS = previousMock;
    if (previousGoogleKey == null) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogleKey;
  }
});

test('database inserts always receive an atomic score profile snapshot', async () => {
  const suffix = randomUUID();
  const version = `database-snapshot-${suffix}`;
  const created = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score',
      version,
      title:'DB 자동 스냅샷',
      metrics:['exact_match'],
      weights:{ exact_match:2 },
    }),
  }));
  expect(created.status).toBe(201);
  const profile = await db.query<{ id:string; content_hash:string }>(
    'select id,content_hash from score_profiles where version=$1',
    [version],
  );
  const inserted = await db.query<{ score_profile_snapshot:Record<string, unknown> }>(
    `insert into benchmark_runs(
       public_id,title,dataset_version_id,score_profile_id,price_profile_version,
       system_prompt,parameters
     ) values($1,$2,$3,$4,'test-price-v1','교과서 근거로 답하라.','{}'::jsonb)
     returning score_profile_snapshot`,
    [`DIRECT-${suffix}`, '직접 DB 실행', datasetVersionId, profile.rows[0]!.id],
  );
  expect(inserted.rows[0]?.score_profile_snapshot).toMatchObject({
    id:profile.rows[0]!.id,
    version,
    metrics:['exact_match'],
    weights:{ exact_match:2 },
    contentHash:profile.rows[0]!.content_hash,
  });
});

test('direct run insert locks the profile until commit and a concurrent profile update then fails', async () => {
  const suffix = randomUUID();
  const version = `snapshot-lock-${suffix}`;
  const created = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score',
      version,
      title:'동시성 스냅샷',
      metrics:['exact_match'],
      weights:{ exact_match:1 },
    }),
  }));
  expect(created.status).toBe(201);
  const profile = await db.query<{ id:string }>('select id from score_profiles where version=$1', [version]);
  const insertClient = await db.connect();
  const updateClient = await db.connect();
  let insertCommitted = false;
  let updateOutcome: Promise<{ ok:boolean; code?:string }> | null = null;
  try {
    await insertClient.query('begin');
    await updateClient.query('begin');
    const backend = await updateClient.query<{ pid:number }>('select pg_backend_pid() pid');
    await insertClient.query(
      `insert into benchmark_runs(
         public_id,title,dataset_version_id,score_profile_id,price_profile_version,
         system_prompt,parameters
       ) values($1,$2,$3,$4,'test-price-v1','교과서 근거로 답하라.','{}'::jsonb)`,
      [`LOCK-${suffix}`, '동시성 직접 실행', datasetVersionId, profile.rows[0]!.id],
    );
    updateOutcome = updateClient.query(
      'update score_profiles set title=$2 where id=$1',
      [profile.rows[0]!.id, '동시 변경'],
    ).then(() => ({ ok:true })).catch((error: { code?:string }) => ({ ok:false, code:error.code }));

    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await db.query<{ wait_event_type:string | null }>(
        'select wait_event_type from pg_stat_activity where pid=$1',
        [backend.rows[0]!.pid],
      );
      if (activity.rows[0]?.wait_event_type === 'Lock') {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);

    await insertClient.query('commit');
    insertCommitted = true;
    await expect(updateOutcome).resolves.toEqual({ ok:false, code:'55000' });
    const snapshot = await db.query<{ title:string }>(
      `select score_profile_snapshot->>'title' title
       from benchmark_runs where public_id=$1`,
      [`LOCK-${suffix}`],
    );
    expect(snapshot.rows[0]?.title).toBe('동시성 스냅샷');
  } finally {
    if (!insertCommitted) await insertClient.query('rollback');
    if (updateOutcome) await updateOutcome;
    await updateClient.query('rollback');
    insertClient.release();
    updateClient.release();
  }
});

test('snapshots the full score profile and prevents mutation after a run uses it', async () => {
  const suffix = randomUUID();
  const version = `snapshot-${suffix}`;
  const created = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score', version, title:'스냅샷 프로필',
      metrics:['accuracy','response_present'],
      weights:{ accuracy:2, response_present:0 },
      rubricPrompt:'정확성 루브릭',
      judgeProvider:'gemini',
      judgeModel:'judge-exact-v7',
    }),
  }));
  expect(created.status).toBe(201);
  const initialProfile = await db.query<{ id:string; content_hash:string }>(
    'select id,content_hash from score_profiles where version=$1',
    [version],
  );
  await db.query(
    'update score_profiles set rubric_prompt=$2 where id=$1',
    [initialProfile.rows[0]!.id, '자동 해시 갱신 루브릭'],
  );
  const profile = await db.query<{ id:string; content_hash:string }>(
    'select id,content_hash from score_profiles where version=$1',
    [version],
  );
  expect(profile.rows[0]!.content_hash).not.toBe(initialProfile.rows[0]!.content_hash);
  const listed = await listProfiles();
  const listing = await listed.json() as { items:Array<{ version:string; weights:Record<string, number> }> };
  expect(listing.items.find((item) => item.version === version)?.weights).toEqual({
    accuracy:2,
    response_present:0,
  });

  const run = await createRun({
    title:`스냅샷 실행 ${suffix}`,
    datasetVersionId,
    scoreProfileId:profile.rows[0]!.id,
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:1,
    models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', protocol:'gemini' }],
  });
  const stored = await db.query<{ score_profile_snapshot: Record<string, unknown> }>(
    'select score_profile_snapshot from benchmark_runs where id=$1',
    [run.id],
  );
  expect(stored.rows[0]?.score_profile_snapshot).toEqual({
    id:profile.rows[0]!.id,
    version,
    title:'스냅샷 프로필',
    metrics:['accuracy','response_present'],
    weights:{ accuracy:2, response_present:0 },
    rubricPrompt:'자동 해시 갱신 루브릭',
    judgeProvider:'gemini',
    judgeModel:'judge-exact-v7',
    contentHash:profile.rows[0]!.content_hash,
  });

  await expect(db.query('update score_profiles set title=$2 where id=$1', [profile.rows[0]!.id, '변경']))
    .rejects.toMatchObject({ code:'55000' });
  await expect(db.query('delete from score_profiles where id=$1', [profile.rows[0]!.id]))
    .rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update benchmark_runs set score_profile_snapshot=jsonb_set(score_profile_snapshot,'{title}','"변경"'::jsonb) where id=$1`,
    [run.id],
  )).rejects.toMatchObject({ code:'55000' });
});

test('scores only eligible responses and persists the exact snapshotted Judge model', async () => {
  const suffix = randomUUID();
  const version = `exact-judge-${suffix}`;
  const created = await createProfile(new Request('http://localhost/api/settings/profiles', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      kind:'score',
      version,
      title:'정확한 Judge 모델',
      metrics:['accuracy'],
      weights:{ accuracy:1 },
      rubricPrompt:'정확성을 절대평가한다.',
      judgeProvider:'gemini',
      judgeModel:'judge-exact-v7',
    }),
  }));
  expect(created.status).toBe(201);
  const profile = await db.query<{ id:string }>('select id from score_profiles where version=$1', [version]);
  const run = await createRun({
    title:`정확 Judge 실행 ${suffix}`,
    datasetVersionId:twoQuestionDatasetId,
    scoreProfileId:profile.rows[0]!.id,
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:2,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'candidate-model',
      protocol:'gemini',
      concurrency:2,
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item, failedItem] = await claimRunItems(run.id, 'score-consistency-worker', 2, 30_000);
  await executeRunItem(item!, 'score-consistency-worker', new MockProvider('gemini', 'candidate-model'));
  await failRunItem(
    failedItem!.id,
    'score-consistency-worker',
    'FIXTURE_FAILURE',
    '응답 전에 실패한 테스트 항목',
  );
  await db.query(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text,ignored_after_cancel
     ) values($1,2,'candidate-model','취소 후 응답','취소 후 응답',true)`,
    [item!.id],
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);

  const stored = await db.query<{ state:string; judge_models:string[]; eligible_responses:string }>(
    `select br.state,
       array_remove(array_agg(distinct s.judge_model),null) judge_models,
       count(distinct mr.id)::text eligible_responses
     from benchmark_runs br
     join run_items ri on ri.benchmark_run_id=br.id
     join eligible_model_responses mr on mr.run_item_id=ri.id
     join scores s on s.model_response_id=mr.id
     where br.id=$1 group by br.id`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state:'COMPLETED',
    judge_models:['judge-exact-v7'],
    eligible_responses:'1',
  });
  const analytics = await getResultAnalytics(run.id);
  expect(analytics.models[0]?.responses).toBe(1);
  const details = await getRunDetails(run.id);
  expect(details?.items).toHaveLength(2);
  expect(details?.items.find((entry) => entry.id === item!.id)?.response?.text).not.toBe('취소 후 응답');
  expect(details?.items.find((entry) => entry.id === failedItem!.id)?.response).toBeNull();

  const json = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params:Promise.resolve({ id:run.id }) },
  );
  const body = await json.json();
  expect(body.run.eligible_response_count).toBe(1);
  expect(body.items).toHaveLength(2);
  expect(body.items.find((entry: { run_item_id:string }) => entry.run_item_id === item!.id).response_text)
    .not.toBe('취소 후 응답');
  expect(body.items.find((entry: { run_item_id:string }) => entry.run_item_id === failedItem!.id))
    .toMatchObject({ response_text:null, raw_response:null, scores:{} });
  expect(JSON.stringify(body)).not.toContain('취소 후 응답');
  expect(summarizeExportRun(body.run)).toEqual({
    eligibleResponseCount:1,
    smallSample:true,
  });
  expect(() => summarizeExportRun({ eligible_response_count:null }))
    .toThrow('EXPORT_ELIGIBLE_RESPONSE_COUNT_MISSING');
  const csv = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=csv`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(await csv.text()).not.toContain('취소 후 응답');
  const pdf = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=pdf`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
});
