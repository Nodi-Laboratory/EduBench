import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { GET } from '@/app/api/runs/[id]/details/route';
import { GET as getRunItemDetails } from '@/app/api/runs/[id]/items/[itemId]/details/route';
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

async function observeNextDatabaseConnectionRowCounts<T>(
  work:() => Promise<T>,
): Promise<{ value:T; rowCounts:number[] }> {
  const rowCounts:number[] = [];
  const originalConnect = db.connect;
  const observedClients:Array<{
    client:PoolClient;
    query:PoolClient['query'];
  }> = [];
  const mutableDb = db as unknown as {
    connect:() => Promise<PoolClient>;
  };
  mutableDb.connect = async () => {
    const client = await Reflect.apply(originalConnect, db, []) as PoolClient;
    const originalQuery = client.query;
    observedClients.push({ client, query:originalQuery });
    client.query = ((...args:unknown[]) => (
      Reflect.apply(originalQuery, client, args) as Promise<{
        rows:unknown[];
      }>
    ).then((result) => {
      rowCounts.push(result.rows.length);
      return result;
    })) as PoolClient['query'];
    return client;
  };
  try {
    return { value:await work(), rowCounts };
  } finally {
    mutableDb.connect = originalConnect as unknown as () => Promise<PoolClient>;
    for (const observed of observedClients) {
      observed.client.query = observed.query;
    }
  }
}

test('returns a bounded run overview without item payloads', async () => {
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
  const largeRawMarker = 'MODEL_RAW_BOUNDARY_FIXTURE';
  await db.query(
    `update model_responses
        set raw_response=$2::jsonb
      where id=$1`,
    [
      context.response_id,
      JSON.stringify({
        marker:largeRawMarker,
        payload:'x'.repeat(2_000_000),
      }),
    ],
  );

  const response = await GET(new Request(`http://localhost/api/runs/${run.id}/details`), { params: Promise.resolve({ id: run.id }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.profile).toMatchObject({ version: 'score-v1', metrics: expect.any(Array), rubricPrompt: expect.any(String) });
  expect(body.scoringEngine).toMatchObject({
    id:expect.any(String),
    version:'edubench-scoring-v2',
    title:'EduBench 선수관계 평가 엔진 v2',
    definition:expect.objectContaining({
      judge:expect.objectContaining({
        systemPrompt:expect.stringContaining('EDUBENCH_JUDGE_JSON'),
      }),
    }),
    contentHash:expect.stringMatching(/^[0-9a-f]{64}$/),
    snapshotProvenance:'AT_CREATION_VERIFIED',
    verified:true,
  });
  expect(body).not.toHaveProperty('events');
  const historyResponse = await GET(
    new Request(`http://localhost/api/runs/${run.id}/details?history=1`),
    { params:Promise.resolve({ id:run.id }) },
  );
  const historyBody = await historyResponse.json();
  expect(body.eventCursor).toBe(historyBody.events.at(-1).id);
  expect(historyBody.events).toEqual(expect.arrayContaining([
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
  expect(body.itemPagination).toEqual({
    page:1,
    pageSize:50,
    total:1,
    totalPages:1,
  });
  expect(body.items[0]).toMatchObject({
    questionText: expect.any(String),
    hasResponse:true,
    errorCode: null, errorMessage: null,
  });
  expect(body.items[0]).not.toHaveProperty('request');
  expect(body.items[0]).not.toHaveProperty('response');
  expect(body.items[0]).not.toHaveProperty('retrieval');
  expect(body.items[0]).not.toHaveProperty('scores');
  expect(body.items[0]).not.toHaveProperty('judgeInvocations');
  expect(JSON.stringify(body.items)).not.toContain('raw judge');
  expect(JSON.stringify(body.items)).not.toContain('JUDGE REQUEST');
  expect(JSON.stringify(body)).not.toContain(largeRawMarker);

  const itemDetailResponse = await getRunItemDetails(
    new Request(
      `http://localhost/api/runs/${run.id}/items/${item!.id}/details?judgeLimit=1`,
    ),
    { params:Promise.resolve({ id:run.id, itemId:item!.id }) },
  );
  expect(itemDetailResponse.status).toBe(200);
  const itemDetail = await itemDetailResponse.json();
  expect(itemDetail.item).toMatchObject({
    id:item!.id,
    request:{
      system:'교과서 근거에 따라 답하라.',
      prompt:expect.any(String),
      reconstructed:true,
    },
    response:{ text:expect.any(String), raw:expect.any(Object) },
    retrieval:expect.objectContaining({
      id:expect.any(String),
      selectedChunks:expect.any(Array),
      graphTrace:expect.any(Object),
      renderedContext:expect.any(String),
    }),
    scores:expect.any(Array),
  });
  expect(itemDetail.item.judgeInvocations).toEqual([
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
  ]);
  expect(itemDetail.judgePagination).toEqual({
    limit:1,
    offset:0,
    total:2,
    nextOffset:1,
  });

  const secondJudgePageResponse = await getRunItemDetails(
    new Request(
      `http://localhost/api/runs/${run.id}/items/${item!.id}/details?judgeLimit=1&judgeOffset=1`,
    ),
    { params:Promise.resolve({ id:run.id, itemId:item!.id }) },
  );
  const secondJudgePage = await secondJudgePageResponse.json();
  expect(secondJudgePage.item.judgeInvocations).toEqual([
    expect.objectContaining({
      id:failedInvocation.rows[0]!.id,
      state:'FAILED',
      errorCode:'JUDGE_TIMEOUT',
      errorMessage:'Judge 응답 제한 시간을 초과했습니다.',
      errorStage:'PROVIDER',
    }),
  ]);
  expect(secondJudgePage.judgePagination).toEqual({
    limit:1,
    offset:1,
    total:2,
    nextOffset:null,
  });

  const jsonExport = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(jsonExport.status).toBe(200);
  const exported = await jsonExport.json();
  expect(exported.scoringEngine).toMatchObject({
    version:'edubench-scoring-v2',
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

test('counts only required metrics on the latest eligible response', async () => {
  const counterDatasetVersionId = await createRealPublishedDataset(2);
  await db.query(
    `update question_revisions revision
        set quality_scores =
          '{"benchmarkDesign":{"benchmarkType":"PREREQUISITE_RELATIONSHIP"}}'
          ::jsonb
       from dataset_questions item
      where item.dataset_version_id=$1
        and item.ordinal=1
        and revision.question_id=item.question_id
        and revision.revision=item.question_revision`,
    [counterDatasetVersionId],
  );
  const scoreProfileId = randomUUID();
  await db.query(
    `insert into score_profiles(
       id,version,title,metrics,weights,rubric_prompt,
       judge_provider,judge_model,content_hash
     ) values(
       $1,$2,'집계 카운터 프로필',
       '["accuracy","accuracy"]'::jsonb,
       '{"accuracy":1}'::jsonb,'집계 카운터 테스트',
       'gemini','gemini-test',$3
     )`,
    [
      scoreProfileId,
      `aggregate-counter-${randomUUID()}`,
      randomUUID().replaceAll('-', ''),
    ],
  );
  const run = await createRun({
    title:`집계 카운터 ${randomUUID().slice(0, 8)}`,
    datasetVersionId:counterDatasetVersionId,
    scoreProfileId,
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:2,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-test',
      protocol:'gemini',
    }],
  });
  const items = await db.query<{
    id:string;
    model_id:string;
    ordinal:number;
  }>(
    `select run_item.id,model.model_id,dataset_item.ordinal
       from run_items run_item
       join run_models model on model.id=run_item.run_model_id
       join dataset_questions dataset_item
         on dataset_item.dataset_version_id=$2
        and dataset_item.question_id=run_item.question_id
        and dataset_item.question_revision=run_item.question_revision
      where run_item.benchmark_run_id=$1
      order by dataset_item.ordinal`,
    [run.id, counterDatasetVersionId],
  );
  const responseIds = new Map<string, string>();
  for (const item of items.rows) {
    const response = await db.query<{ id:string }>(
      `insert into model_responses(
         run_item_id,attempt,model_id,response_text,normalized_text
       ) values($1,1,$2,'정답입니다.','정답입니다.')
       returning id`,
      [item.id, item.model_id],
    );
    responseIds.set(item.id, response.rows[0]!.id);
  }
  const prerequisiteItem = items.rows.find((item) => item.ordinal === 1)!;
  const ordinaryItem = items.rows.find((item) => item.ordinal === 2)!;
  const newerOrdinaryResponse = await db.query<{ id:string }>(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text
     ) values($1,2,$2,'최신 정답입니다.','최신 정답입니다.')
     returning id`,
    [ordinaryItem.id, ordinaryItem.model_id],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,
       rationale,provenance
     ) values
       ($1,$3,'response_present',1,'PRESENT','이전 응답','DETERMINISTIC_ENGINE_VERIFIED'),
       ($2,$3,'response_present',1,'PRESENT','선수관계 응답','DETERMINISTIC_ENGINE_VERIFIED'),
       ($4,$3,'exact_match',1,'MATCH','폐기 지표','DETERMINISTIC_ENGINE_VERIFIED')`,
    [
      responseIds.get(ordinaryItem.id),
      responseIds.get(prerequisiteItem.id),
      scoreProfileId,
      newerOrdinaryResponse.rows[0]!.id,
    ],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,rubric_key,
       value,label,rationale,provenance
     ) values(
       $1,$2,'response_present','duplicate-rubric',
       1,'PRESENT','중복 루브릭 행','DETERMINISTIC_ENGINE_VERIFIED'
     )`,
    [responseIds.get(prerequisiteItem.id), scoreProfileId],
  );

  const response = await GET(
    new Request(`http://localhost/api/runs/${run.id}/details?history=0`),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.counters).toEqual({
    itemTotal:2,
    scoreEligibleItems:2,
    requiredScorePairs:10,
    scoredPairs:1,
  });
  expect(body.profile.metrics).toEqual(['accuracy', 'accuracy']);
});

test('keeps database result sets bounded by the requested overview page', async () => {
  const largeDatasetVersionId = await createRealPublishedDataset(40);
  const run = await createRun({
    title:`집계 전송 경계 ${randomUUID().slice(0, 8)}`,
    datasetVersionId:largeDatasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:40,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-test',
      protocol:'gemini',
    }],
  });

  const observed = await observeNextDatabaseConnectionRowCounts(() => GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=1&pageSize=5&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  ));
  expect(observed.value.status).toBe(200);
  const body = await observed.value.json();
  expect(body.counters.itemTotal).toBe(40);
  expect(body.items).toHaveLength(5);
  expect(Math.max(...observed.rowCounts)).toBeLessThanOrEqual(5);
});

test('caps run item pages at 100 and returns a stable total', async () => {
  const run = await createRun({
    title:`대용량 상세 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:1,
    models:[{
      providerKey:'fixture-000',
      displayName:'Fixture 000',
      modelId:'fixture-model-000',
      protocol:'gemini',
    }],
  });
  await db.query(
    `with inserted_models as (
       insert into run_models(
         benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
       )
       select $1,
              'fixture-' || lpad(series::text,3,'0'),
              'Fixture ' || lpad(series::text,3,'0'),
              'M' || lpad((series + 1)::text,3,'0'),
              'fixture-model-' || lpad(series::text,3,'0'),
              'gemini'
         from generate_series(1,104) series
       returning id,benchmark_run_id,provider_key
     )
     insert into run_items(
       benchmark_run_id,run_model_id,question_id,question_revision,
       idempotency_key,retrieval_mode
     )
     select model.benchmark_run_id,model.id,item.question_id,
            item.question_revision,
            model.benchmark_run_id || ':' || model.id || ':' || item.question_id,
             case
               when model.provider_key between 'fixture-010' and 'fixture-029'
                 then 'NONE'
               else 'LEGACY_EVIDENCE'
             end
       from inserted_models model
       cross join lateral (
         select question_id,question_revision
           from run_items
          where benchmark_run_id=$1
          limit 1
       ) item`,
    [run.id],
  );
  await db.query(
    `update benchmark_runs
        set total_items=(
          select count(*) from run_items where benchmark_run_id=$1
        )
      where id=$1`,
    [run.id],
  );
  await db.query(
    `update run_items item
        set state='FAILED'
       from run_models model
      where item.benchmark_run_id=$1
        and model.id=item.run_model_id
        and model.provider_key between 'fixture-001' and 'fixture-023'`,
    [run.id],
  );

  const firstResponse = await GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=1&pageSize=1000&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const first = await firstResponse.json();
  expect(first.itemPagination).toEqual({
    page:1,
    pageSize:100,
    total:105,
    totalPages:2,
  });
  expect(first.items).toHaveLength(100);

  const secondResponse = await GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=2&pageSize=100&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const second = await secondResponse.json();
  expect(second.itemPagination).toEqual({
    page:2,
    pageSize:100,
    total:105,
    totalPages:2,
  });
  expect(second.items).toHaveLength(5);
  expect(new Set([
    ...first.items.map((item: { id:string }) => item.id),
    ...second.items.map((item: { id:string }) => item.id),
  ])).toHaveLength(105);

  const targetModelResult = await db.query<{
    id:string;
    provider_key:string;
    blind_id:string;
  }>(
    `select id,provider_key,blind_id
       from run_models
      where benchmark_run_id=$1
        and provider_key='fixture-104'`,
    [run.id],
  );
  const targetModel = targetModelResult.rows[0]!;
  expect(first.items.some((item: {
    providerKey:string;
  }) => item.providerKey === 'fixture-104')).toBe(false);

  const modelFilteredResponse = await GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=1&pageSize=10&runModelId=${targetModel.id}&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const modelFiltered = await modelFilteredResponse.json();
  expect(modelFiltered.itemPagination).toEqual({
    page:1,
    pageSize:10,
    total:1,
    totalPages:1,
  });
  expect(modelFiltered.items).toEqual([
    expect.objectContaining({
      runModelId:targetModel.id,
      providerKey:'fixture-104',
      blindId:targetModel.blind_id,
    }),
  ]);
  expect(modelFiltered.itemFilters).toMatchObject({
    runModelId:targetModel.id,
  });
  expect(modelFiltered.itemFilterOptions.models).toContainEqual({
    runModelId:targetModel.id,
    providerKey:'fixture-104',
    displayName:'Fixture 104',
    blindId:targetModel.blind_id,
    modelId:'fixture-model-104',
  });
  expect(modelFiltered.itemFilterOptions.models).toHaveLength(105);

  const filteredResponse = await GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=1&pageSize=10&state=FAILED&retrievalMode=NONE&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const filtered = await filteredResponse.json();
  expect(filtered.itemPagination).toEqual({
    page:1,
    pageSize:10,
    total:14,
    totalPages:2,
  });
  expect(filtered.items).toHaveLength(10);
  expect(filtered.items.every((item: {
    state:string;
    retrievalMode:string;
  }) => item.state === 'FAILED' && item.retrievalMode === 'NONE')).toBe(true);
  expect(filtered.itemFilterOptions).toMatchObject({
    states:['FAILED', 'PENDING'],
    retrievalModes:['LEGACY_EVIDENCE', 'NONE'],
  });

  const filteredSecondResponse = await GET(
    new Request(
      `http://localhost/api/runs/${run.id}/details?page=2&pageSize=10&state=FAILED&retrievalMode=NONE&history=0`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const filteredSecond = await filteredSecondResponse.json();
  expect(filteredSecond.itemPagination).toMatchObject({
    page:2,
    pageSize:10,
    total:14,
    totalPages:2,
  });
  expect(filteredSecond.items).toHaveLength(4);
  expect(filteredSecond.itemFilterOptions).toEqual(
    filtered.itemFilterOptions,
  );
});

test('resolves a lightweight retrieval receipt through its root audit', async () => {
  const run = await createRun({
    title:`공유 검색 상세 ${randomUUID().slice(0, 8)}`,
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
    }, {
      providerKey:'openai',
      displayName:'OpenAI',
      modelId:'openai-test',
      protocol:'openai-responses',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const items = await claimRunItems(run.id, 'worker-shared-details', 2, 30_000);
  const modelByItem = new Map((await db.query<{
    item_id:string;
    provider_key:string;
    model_id:string;
  }>(
    `select item.id item_id,model.provider_key,model.model_id
       from run_items item
       join run_models model on model.id=item.run_model_id
      where item.id=any($1::uuid[])`,
    [items.map((item) => item.id)],
  )).rows.map((model) => [model.item_id, model]));
  for (const item of items) {
    const model = modelByItem.get(item.id)!;
    await executeRunItem(
      item,
      'worker-shared-details',
      new MockProvider(model.provider_key, model.model_id),
    );
  }
  const retrievals = await db.query<{
    id:string;
    run_item_id:string;
    selected_chunks:unknown[] | null;
    rendered_context:string | null;
    shared_from_retrieval_id:string | null;
  }>(
    `select retrieval.id,retrieval.run_item_id,retrieval.selected_chunks,
            retrieval.rendered_context,retrieval.shared_from_retrieval_id
       from run_item_retrievals retrieval
       join run_items item on item.id=retrieval.run_item_id
      where item.benchmark_run_id=$1
      order by retrieval.created_at,retrieval.id`,
    [run.id],
  );
  const receipt = retrievals.rows.find(
    (retrieval) => retrieval.shared_from_retrieval_id != null,
  );
  expect(receipt).toMatchObject({
    selected_chunks:null,
    rendered_context:null,
    shared_from_retrieval_id:expect.any(String),
  });
  const root = retrievals.rows.find(
    (retrieval) => retrieval.id === receipt!.shared_from_retrieval_id,
  )!;

  const response = await getRunItemDetails(
    new Request(
      `http://localhost/api/runs/${run.id}/items/${receipt!.run_item_id}/details`,
    ),
    {
      params:Promise.resolve({
        id:run.id,
        itemId:receipt!.run_item_id,
      }),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.item.retrieval).toMatchObject({
    id:receipt!.id,
    sharedFromRetrievalId:root.id,
    selectedChunks:root.selected_chunks,
    renderedContext:root.rendered_context,
  });
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

test('returns the provider-wide quota cooldown affecting the run', async () => {
  const run = await createRun({
    title:`호출 제한 상세 ${randomUUID().slice(0, 8)}`,
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
  const blockedUntil = new Date(Date.now() + 120_000);
  try {
    await db.query(
      `insert into benchmark_provider_cooldowns(
         provider_key,blocked_until,rate_limit_dimension,retry_after_ms,
         source_run_id,source_phase,source_model_id,request_id,
         last_error_message,hit_count
       ) values($1,$2,'RPM',120000,$3,'MODEL_RESPONSE',$4,$5,$6,1)
       on conflict(provider_key) do update set
         blocked_until=excluded.blocked_until,
         rate_limit_dimension=excluded.rate_limit_dimension,
         retry_after_ms=excluded.retry_after_ms,
         source_run_id=excluded.source_run_id,
         source_phase=excluded.source_phase,
         source_model_id=excluded.source_model_id,
         request_id=excluded.request_id,
         last_error_message=excluded.last_error_message,
         hit_count=1,
         activated_at=now(),
         updated_at=now()`,
      [
        'gemini',
        blockedUntil,
        run.id,
        'gemini-test',
        'quota-details-request',
        'RATE_LIMIT: 분당 요청 한도',
      ],
    );

    const response = await GET(
      new Request(`http://localhost/api/runs/${run.id}/details`),
      { params:Promise.resolve({ id:run.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providerCooldowns).toEqual([
      expect.objectContaining({
        providerKey:'gemini',
        active:true,
        rateLimitDimension:'RPM',
        sourceRunId:run.id,
        sourcePhase:'MODEL_RESPONSE',
        sourceModelId:'gemini-test',
        requestId:'quota-details-request',
        retryAfterMs:120_000,
        hitCount:1,
      }),
    ]);
    expect(Date.parse(body.providerCooldowns[0].blockedUntil)).toBe(
      blockedUntil.getTime(),
    );
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      ['gemini'],
    );
  }
});
