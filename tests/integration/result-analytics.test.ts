import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { createRealPublishedDataset } from './helpers/real-dataset';
import { beginScoringWhenExecutionFinished, claimRunItems, commandRun, createRun } from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import { MockProvider } from '@/server/providers/mock';
import { scoreRun } from '@/server/scoring/service';
import {
  getResultAnalytics,
  getResultQuestionHeatmapPage,
} from '@/server/results/analytics';

let datasetVersionId: string;
let runId: string;
beforeAll(async () => {
  await migrate();
  await seedDatabase();
  datasetVersionId = await createRealPublishedDataset(1);
  await db.query(
    `update question_revisions qr set quality_scores='{"benchmarkDesign":{"benchmarkType":"PREREQUISITE_RELATIONSHIP"}}'::jsonb
     from dataset_questions dq where dq.question_id=qr.question_id and dq.question_revision=qr.revision and dq.dataset_version_id=$1`,
    [datasetVersionId],
  );
  const run = await createRun({
    title:'분석 통합 테스트', datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001', priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.', questionLimit:1,
    models:[{ providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', protocol:'gemini' }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'analytics-worker', 1, 30_000);
  await executeRunItem(item!, 'analytics-worker', new MockProvider('gemini', 'gemini-test'));
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);
  runId = run.id;
});
afterAll(async () => { await db.end(); });

test('reads aggregate analytics and a separate question heatmap page from a completed run', async () => {
  const analytics = await getResultAnalytics(runId);
  expect(analytics.models[0]).toMatchObject({ displayName:'Gemini', responses:1, compositeScore:expect.any(Number) });
  expect(analytics.metricRows.some((row) => row.metricKey === 'accuracy')).toBe(true);
  expect(analytics.prerequisiteRows.length).toBeGreaterThan(0);
  expect(analytics.purposeRows).toHaveLength(1);
  expect(analytics).not.toHaveProperty('questionRows');
  await expect(getResultQuestionHeatmapPage(runId)).resolves.toMatchObject({
    total:1,
    rows:[{ purpose:expect.any(String), scores:expect.any(Object) }],
  });
});

test('retains the filtered heatmap total when the requested page is past the final row', async () => {
  await expect(getResultQuestionHeatmapPage(runId, {
    page:2,
    pageSize:1,
  })).resolves.toEqual({
    page:2,
    pageSize:1,
    total:1,
    rows:[],
  });
});

test('keeps multi-purpose and retrieval-mode analytics aggregate-only', async () => {
  const aggregateDatasetVersionId = await createRealPublishedDataset(12);
  await db.query(
    `update questions question
        set purpose=case
          when dataset_item.ordinal % 2=0 then '개념 적용'
          else '선수 관계'
        end
       from dataset_questions dataset_item
      where dataset_item.dataset_version_id=$1
        and question.id=dataset_item.question_id`,
    [aggregateDatasetVersionId],
  );
  const run = await createRun({
    title:`대용량 분석 ${randomUUID().slice(0, 8)}`,
    datasetVersionId:aggregateDatasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'교과서 근거에 따라 답하라.',
    questionLimit:12,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-test',
      protocol:'gemini',
    }],
  });
  await db.query(
    `insert into run_items(
       benchmark_run_id,run_model_id,question_id,question_revision,
       idempotency_key,retrieval_mode
     )
     select item.benchmark_run_id,item.run_model_id,item.question_id,
            item.question_revision,
            item.id::text || ':aggregate:' || mode.retrieval_mode,
            mode.retrieval_mode
       from run_items item
       cross join unnest(array['NONE','VECTOR','PIKE']::text[])
         mode(retrieval_mode)
      where item.benchmark_run_id=$1
        and item.retrieval_mode='LEGACY_EVIDENCE'`,
    [run.id],
  );
  await db.query(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text,
       latency_ms,cost_krw
     )
     select item.id,1,model.model_id,'정답입니다.','정답입니다.',
            case item.retrieval_mode
              when 'LEGACY_EVIDENCE' then 100
              when 'NONE' then 200
              when 'VECTOR' then 300
              else 400
            end,
            case item.retrieval_mode
              when 'LEGACY_EVIDENCE' then 1
              when 'NONE' then 2
              when 'VECTOR' then 3
              else 4
            end
       from run_items item
       join run_models model on model.id=item.run_model_id
      where item.benchmark_run_id=$1`,
    [run.id],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,
       rationale,provenance
     )
     select response.id,run.score_profile_id,'response_present',1,
            'PRESENT','응답 존재','DETERMINISTIC_ENGINE_VERIFIED'
       from model_responses response
       join run_items item on item.id=response.run_item_id
       join benchmark_runs run on run.id=item.benchmark_run_id
      where run.id=$1`,
    [run.id],
  );
  await db.query(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,state,requested_metric_keys,resolved_metric_keys,
       request_snapshot,request_hash,provider_key,model_id,
       provider_request_id,response_model_id,raw_response,response_text,
       latency_ms,parsed_response,requested_at,response_received_at,parsed_at
     )
     select run.id,response.id,run.score_profile_id,
            run.scoring_engine_version_id,'PRIMARY',1,
            'aggregate-metrics',
            'aggregate-metrics:' || response.id::text,
            'PARSED',
            array[
              'accuracy','faithfulness','prerequisite_relation_accuracy'
            ]::text[],
            array[
              'accuracy','faithfulness','prerequisite_relation_accuracy'
            ]::text[],
            '{"system":"fixture","prompt":"fixture"}'::jsonb,
            repeat('0',64),
            run.score_profile_snapshot->>'judgeProvider',
            run.score_profile_snapshot->>'judgeModel',
            'aggregate-request:' || response.id::text,
            run.score_profile_snapshot->>'judgeModel',
            '{"fixture":true}'::jsonb,
            '{"scores":[]}',
            1,
            '{"scores":[]}'::jsonb,
            now()-interval '2 seconds',
            now()-interval '1 second',
            now()
       from model_responses response
       join run_items item on item.id=response.run_item_id
       join benchmark_runs run on run.id=item.benchmark_run_id
      where run.id=$1`,
    [run.id],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,rationale,
       judge_provider,judge_model,judge_request_id,judge_invocation_id,
       provenance
     )
     select invocation.model_response_id,invocation.score_profile_id,
            metric.metric_key,
            case metric.metric_key
              when 'accuracy' then case
                when item.retrieval_mode='LEGACY_EVIDENCE'
                  and dataset_item.ordinal=1 then null
                when item.retrieval_mode='LEGACY_EVIDENCE' then 0.1
                when item.retrieval_mode='NONE' then 0.2
                when item.retrieval_mode='VECTOR' then 0.6
                else 1
              end
              when 'faithfulness' then 0.5
              else 0.4
            end,
            metric.metric_key,'집계 테스트',
            invocation.provider_key,invocation.model_id,
            invocation.provider_request_id,invocation.id,
            'JUDGE_INVOCATION_VERIFIED'
       from judge_invocations invocation
       join model_responses response
         on response.id=invocation.model_response_id
       join run_items item on item.id=response.run_item_id
       join dataset_questions dataset_item
         on dataset_item.dataset_version_id=$2
        and dataset_item.question_id=item.question_id
        and dataset_item.question_revision=item.question_revision
       cross join unnest(invocation.resolved_metric_keys)
         metric(metric_key)
      where invocation.benchmark_run_id=$1
        and invocation.logical_key='aggregate-metrics'`,
    [run.id, aggregateDatasetVersionId],
  );
  const retryItem = (await db.query<{
    id:string;
    question_id:string;
    model_id:string;
  }>(
    `select item.id,item.question_id,model.model_id
       from run_items item
       join run_models model on model.id=item.run_model_id
       join dataset_questions dataset_item
         on dataset_item.dataset_version_id=$2
        and dataset_item.question_id=item.question_id
        and dataset_item.question_revision=item.question_revision
      where item.benchmark_run_id=$1
        and item.retrieval_mode='LEGACY_EVIDENCE'
        and dataset_item.ordinal=2`,
    [run.id, aggregateDatasetVersionId],
  )).rows[0]!;
  const retryResponse = (await db.query<{ id:string }>(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text,
       input_tokens,output_tokens,latency_ms,cost_krw
     ) values(
       $1,2,$2,'최신 재시도 응답','최신 재시도 응답',
       999,111,999,9
     )
     returning id`,
    [retryItem.id, retryItem.model_id],
  )).rows[0]!;
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,
       rationale,provenance
     )
     select $2,run.score_profile_id,'response_present',1,
            'PRESENT','최신 재시도 응답','DETERMINISTIC_ENGINE_VERIFIED'
       from benchmark_runs run
      where run.id=$1`,
    [run.id, retryResponse.id],
  );
  const retryInvocation = (await db.query<{ id:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,state,requested_metric_keys,resolved_metric_keys,
       request_snapshot,request_hash,provider_key,model_id,
       provider_request_id,response_model_id,raw_response,response_text,
       latency_ms,parsed_response,requested_at,response_received_at,parsed_at
     )
     select run.id,$2::uuid,run.score_profile_id,
            run.scoring_engine_version_id,'PRIMARY',1,
            'aggregate-metrics','aggregate-metrics:' || $2::text,
            'PARSED',
            array[
              'accuracy','faithfulness','prerequisite_relation_accuracy'
            ]::text[],
            array[
              'accuracy','faithfulness','prerequisite_relation_accuracy'
            ]::text[],
            '{"system":"retry fixture","prompt":"retry fixture"}'::jsonb,
            repeat('0',64),
            run.score_profile_snapshot->>'judgeProvider',
            run.score_profile_snapshot->>'judgeModel',
            'aggregate-request:' || $2::text,
            run.score_profile_snapshot->>'judgeModel',
            '{"fixture":"retry"}'::jsonb,
            '{"scores":[]}',
            1,
            '{"scores":[]}'::jsonb,
            now()-interval '2 seconds',
            now()-interval '1 second',
            now()
       from benchmark_runs run
      where run.id=$1
     returning id`,
    [run.id, retryResponse.id],
  )).rows[0]!;
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,rationale,
       judge_provider,judge_model,judge_request_id,judge_invocation_id,
       provenance
     )
     select invocation.model_response_id,invocation.score_profile_id,
            metric.metric_key,metric.value,metric.metric_key,
            '최신 재시도 점수',invocation.provider_key,invocation.model_id,
            invocation.provider_request_id,invocation.id,
            'JUDGE_INVOCATION_VERIFIED'
       from judge_invocations invocation
       cross join (values
         ('accuracy',0.9::numeric),
         ('faithfulness',0.6::numeric),
         ('prerequisite_relation_accuracy',0.5::numeric)
       ) metric(metric_key,value)
      where invocation.id=$1`,
    [retryInvocation.id],
  );
  const rawScoreCount = Number((await db.query<{ count:string }>(
    `select count(*)::text count
       from scores score
       join eligible_model_responses response
         on response.id=score.model_response_id
       join run_items item on item.id=response.run_item_id
       join benchmark_runs run on run.id=item.benchmark_run_id
        and run.score_profile_id=score.score_profile_id
      where run.id=$1
        and score.metric_key<>'exact_match'`,
    [run.id],
  )).rows[0]!.count);
  const returnedRowCounts:number[] = [];
  const queryable = {
    query:async (...args:unknown[]) => {
      const result = await Reflect.apply(db.query, db, args) as {
        rows:unknown[];
      };
      returnedRowCounts.push(result.rows.length);
      return result;
    },
  } as unknown as NonNullable<Parameters<typeof getResultAnalytics>[1]>;

  const analytics = await getResultAnalytics(run.id, queryable);
  const retryHeatmap = await getResultQuestionHeatmapPage(run.id, {
    purpose:'개념 적용',
    retrievalModes:['LEGACY_EVIDENCE'],
    pageSize:12,
  });

  expect(rawScoreCount).toBe(196);
  expect(Math.max(...returnedRowCounts)).toBeLessThan(rawScoreCount);
  expect(analytics.retrievalModes).toEqual(['NONE', 'VECTOR', 'PIKE']);
  expect(analytics.purposeOptions).toEqual(['개념 적용', '선수 관계']);
  expect(analytics.models.map((model) => model.seriesKey)).toEqual([
    'M01::PIKE',
    'M01::VECTOR',
    'M01::NONE',
    'M01::LEGACY_EVIDENCE',
  ]);
  expect(analytics.models).toEqual([
    expect.objectContaining({
      responses:12, avgLatencyMs:400, costKrw:48,
      compositeScore:0.633333, scoreCount:36,
    }),
    expect.objectContaining({
      responses:12, avgLatencyMs:300, costKrw:36,
      compositeScore:0.5, scoreCount:36,
    }),
    expect.objectContaining({
      responses:12, avgLatencyMs:200, costKrw:24,
      compositeScore:0.366667, scoreCount:36,
    }),
    expect.objectContaining({
      responses:12, avgLatencyMs:174.91666666666666, costKrw:20,
      compositeScore:0.363131, scoreCount:35,
    }),
  ]);
  expect(
    analytics.metricRows.find((row) => row.metricKey === 'accuracy'),
  ).toMatchObject({
    scores:{
      'M01::LEGACY_EVIDENCE':0.172727,
      'M01::NONE':0.2,
      'M01::VECTOR':0.6,
      'M01::PIKE':1,
    },
    counts:{
      'M01::LEGACY_EVIDENCE':11,
      'M01::NONE':12,
      'M01::VECTOR':12,
      'M01::PIKE':12,
    },
  });
  expect(
    analytics.prerequisiteRows.find(
      (row) => row.metricKey === 'prerequisite_relation_accuracy',
    ),
  ).toMatchObject({
    scores:{
      'M01::LEGACY_EVIDENCE':0.408333,
      'M01::NONE':0.4,
      'M01::VECTOR':0.4,
      'M01::PIKE':0.4,
    },
  });
  expect(analytics.distributions).toEqual([
    { blindId:'M01::LEGACY_EVIDENCE', bins:[10, 0, 0, 0, 1] },
    { blindId:'M01::NONE', bins:[0, 12, 0, 0, 0] },
    { blindId:'M01::PIKE', bins:[0, 0, 0, 0, 12] },
    { blindId:'M01::VECTOR', bins:[0, 0, 0, 12, 0] },
  ]);
  expect(analytics.purposeViews['선수 관계']).toMatchObject({
    models:[
      expect.objectContaining({
        seriesKey:'M01::PIKE', responses:6, scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::VECTOR', responses:6, scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::NONE', responses:6, scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::LEGACY_EVIDENCE', responses:6, scoreCount:17,
      }),
    ],
  });
  expect(analytics.purposeViews['개념 적용']).toMatchObject({
    models:[
      expect.objectContaining({
        seriesKey:'M01::PIKE', responses:6, scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::VECTOR', responses:6, scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::LEGACY_EVIDENCE',
        responses:6,
        avgLatencyMs:249.83333333333334,
        costKrw:14,
        compositeScore:0.388889,
        scoreCount:18,
      }),
      expect.objectContaining({
        seriesKey:'M01::NONE', responses:6, scoreCount:18,
      }),
    ],
  });
  expect(
    retryHeatmap.rows.find((row) => row.questionId === retryItem.question_id),
  ).toMatchObject({
    scores:{ 'M01::LEGACY_EVIDENCE':0.9 },
  });
}, 60_000);
