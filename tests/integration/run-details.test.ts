import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { GET } from '@/app/api/runs/[id]/details/route';
import { GET as exportResult } from '@/app/api/results/[id]/export/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import { MockProvider } from '@/server/providers/mock';
import { createRealPublishedDataset } from './helpers/real-dataset';

let datasetVersionId: string;
beforeAll(async () => { await migrate(); await seedDatabase(); datasetVersionId = await createRealPublishedDataset(1); });
afterAll(async () => { await db.end(); });

test('returns the exact request, response, scores, failure fields, and score profile', async () => {
  const run = await createRun({
    title: `상세 조회 ${randomUUID().slice(0, 8)}`, datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-details', 1, 30_000);
  await executeRunItem(item!, 'worker-details', new MockProvider('gemini', 'gemini-test'));
  await db.query('update run_items set request_snapshot=null where id=$1', [item!.id]);
  const auditContext = await db.query<{
    response_id:string;
    score_profile_id:string;
    scoring_engine_version_id:string;
    judge_provider:string;
    judge_model:string;
  }>(
    `select response.id response_id,run.score_profile_id,
       run.scoring_engine_version_id,
       run.score_profile_snapshot->>'judgeProvider' judge_provider,
       run.score_profile_snapshot->>'judgeModel' judge_model
     from benchmark_runs run
     join run_items run_item on run_item.benchmark_run_id=run.id
     join model_responses response on response.run_item_id=run_item.id
     where run.id=$1`,
    [run.id],
  );
  const context = auditContext.rows[0]!;
  const parsedInvocation = await db.query<{ id:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,requested_metric_keys,request_snapshot,
       provider_key,model_id
     ) values(
       $1,$2,$3,$4,'PRIMARY',1,'accuracy',$5,array['accuracy'],
       '{"system":"JUDGE SYSTEM","prompt":"JUDGE REQUEST"}'::jsonb,$6,$7
     ) returning id`,
    [
      run.id,
      context.response_id,
      context.score_profile_id,
      context.scoring_engine_version_id,
      `details-parsed-${randomUUID()}`,
      context.judge_provider,
      context.judge_model,
    ],
  );
  await db.query(
    `update judge_invocations set
       state='RESPONSE_RECEIVED',
       raw_response='{"providerPayload":{"answer":"raw judge"}}'::jsonb,
       response_text='{"scores":[{"metricKey":"accuracy","value":1}]}',
       provider_request_id='judge-request-details',
       response_model_id=$2,response_model_snapshot='judge-snapshot-details',
       finish_reason='STOP',input_tokens=11,output_tokens=7,latency_ms=23,
       response_received_at=now()
     where id=$1`,
    [parsedInvocation.rows[0]!.id, context.judge_model],
  );
  await db.query(
    `update judge_invocations set
       state='PARSED',
       parsed_response='{"scores":[{"metricKey":"accuracy","value":1,"rationale":"교과서 근거 일치"}]}'::jsonb,
       resolved_metric_keys=array['accuracy'],
       missing_metric_keys=array[]::text[],
       parsed_at=now()
     where id=$1`,
    [parsedInvocation.rows[0]!.id],
  );
  const failedInvocation = await db.query<{ id:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,requested_metric_keys,request_snapshot,
       provider_key,model_id
     ) values(
       $1,$2,$3,$4,'PRIMARY',1,'faithfulness',$5,array['faithfulness'],
       '{"system":"JUDGE SYSTEM","prompt":"FAILED JUDGE REQUEST"}'::jsonb,$6,$7
     ) returning id`,
    [
      run.id,
      context.response_id,
      context.score_profile_id,
      context.scoring_engine_version_id,
      `details-failed-${randomUUID()}`,
      context.judge_provider,
      context.judge_model,
    ],
  );
  await db.query(
    `update judge_invocations set
       state='FAILED',error_code='JUDGE_TIMEOUT',
       error_message='Judge 응답 제한 시간을 초과했습니다.',
       error_stage='PROVIDER',failed_at=now()
     where id=$1`,
    [failedInvocation.rows[0]!.id],
  );

  const response = await GET(new Request(`http://localhost/api/runs/${run.id}/details`), { params: Promise.resolve({ id: run.id }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.profile).toMatchObject({ version: 'score-v1', metrics: expect.any(Array), rubricPrompt: expect.any(String) });
  expect(body.scoringEngine).toMatchObject({
    id:expect.any(String),
    version:'edubench-scoring-v1',
    title:'EduBench 선수관계 평가 엔진 v1',
    definition:expect.objectContaining({
      judge:expect.objectContaining({
        systemPrompt:expect.stringContaining('EDUBENCH_JUDGE_JSON'),
      }),
    }),
    contentHash:expect.stringMatching(/^[0-9a-f]{64}$/),
    snapshotProvenance:'AT_CREATION_VERIFIED',
    verified:true,
  });
  expect(body.eventCursor).toBe(body.events.at(-1).id);
  expect(body.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ event_type: 'RUN_CREATED' }),
    expect.objectContaining({ event_type: 'RUN_ITEM_COMPLETED' }),
  ]));
  const refresh = await GET(
    new Request(`http://localhost/api/runs/${run.id}/details?history=0`),
    { params: Promise.resolve({ id: run.id }) },
  );
  const refreshBody = await refresh.json();
  expect(refreshBody).not.toHaveProperty('events');
  expect(refreshBody.eventCursor).toBe(body.eventCursor);
  expect(body.items[0]).toMatchObject({
    questionText: expect.any(String), request: { system: '교과서 근거에 따라 답하라.', prompt: expect.any(String), reconstructed: true },
    response: { text: expect.any(String), raw: expect.any(Object) }, scores: expect.any(Array),
    errorCode: null, errorMessage: null,
  });
  expect(body.items[0].judgeInvocations).toEqual([
    expect.objectContaining({
      id:parsedInvocation.rows[0]!.id,
      state:'PARSED',
      invocationKind:'PRIMARY',
      requestHash:expect.stringMatching(/^[0-9a-f]{64}$/),
      requestSnapshot:{ system:'JUDGE SYSTEM', prompt:'JUDGE REQUEST' },
      rawResponse:{ providerPayload:{ answer:'raw judge' } },
      parsedResponse:expect.objectContaining({
        scores:expect.arrayContaining([
          expect.objectContaining({ metricKey:'accuracy', value:1 }),
        ]),
      }),
      errorCode:null,
    }),
    expect.objectContaining({
      id:failedInvocation.rows[0]!.id,
      state:'FAILED',
      requestHash:expect.stringMatching(/^[0-9a-f]{64}$/),
      errorCode:'JUDGE_TIMEOUT',
      errorMessage:'Judge 응답 제한 시간을 초과했습니다.',
      errorStage:'PROVIDER',
    }),
  ]);

  const jsonExport = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(jsonExport.status).toBe(200);
  const exported = await jsonExport.json();
  expect(exported.scoringEngine).toMatchObject({
    version:'edubench-scoring-v1',
    snapshotProvenance:'AT_CREATION_VERIFIED',
    contentHash:expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(exported.judgeInvocations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id:parsedInvocation.rows[0]!.id,
      state:'PARSED',
      requestHash:expect.stringMatching(/^[0-9a-f]{64}$/),
    }),
    expect.objectContaining({
      id:failedInvocation.rows[0]!.id,
      state:'FAILED',
      errorCode:'JUDGE_TIMEOUT',
    }),
  ]));

  const csvExport = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=csv`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(csvExport.status).toBe(200);
  const csv = await csvExport.text();
  expect(csv).toContain('scoring_engine_snapshot_provenance');
  expect(csv).toContain('scoring_engine_content_hash');
  expect(csv).toContain('judge_invocation_ids');
  expect(csv).toContain('judge_invocation_states');
  expect(csv).toContain('judge_request_hashes');
  expect(csv).toContain(parsedInvocation.rows[0]!.id);
  expect(csv).toContain(failedInvocation.rows[0]!.id);
});

test('rejects official PDF export when the scoring engine snapshot is unverified', async () => {
  const run = await createRun({
    title:`엔진 출처 미검증 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:1,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-test',
      protocol:'gemini',
    }],
  });
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      'alter table benchmark_runs disable trigger benchmark_runs_scoring_engine_immutable',
    );
    await client.query(
      `update benchmark_runs set
         scoring_engine_version_id=null,
         scoring_engine_snapshot=null,
         scoring_engine_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED'
       where id=$1`,
      [run.id],
    );
    await client.query(
      'alter table benchmark_runs enable trigger benchmark_runs_scoring_engine_immutable',
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    await client.query(
      'alter table benchmark_runs enable trigger benchmark_runs_scoring_engine_immutable',
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const pdf = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=pdf`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(pdf.status).toBe(409);
  await expect(pdf.json()).resolves.toMatchObject({
    code:'SCORING_ENGINE_REPLACEMENT_REQUIRED',
    message:expect.stringContaining('새 실행'),
  });
});
