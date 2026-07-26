import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  commitJudgeParse,
  commitJudgeResponse,
  failJudgeInvocationAndRecordRun,
  persistJudgeScores,
  reserveOrResumeJudgeInvocation,
  type ReserveJudgeInvocationInput,
} from '@/server/scoring/invocations';

type Fixture = {
  runId: string;
  responseId: string;
  profileId: string;
  engineId: string;
};

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const dataset = await db.query<{ id:string }>(
    `insert into dataset_versions(
       version,status,title,question_count,distribution,content_hash
     ) values($1,'PUBLISHED','Judge 호출 테스트',1,'{}'::jsonb,$2)
     returning id`,
    [`judge-service-dataset-${suffix}`, `judge-service-dataset-${suffix}`],
  );
  const profile = await db.query<{ id:string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,judge_provider,
       judge_model,content_hash
     ) values(
       $1,'Judge 호출 프로필','["accuracy","faithfulness"]'::jsonb,
       '{}'::jsonb,'정확히 채점한다.','gemini','judge-v1','temporary'
     )
     returning id`,
    [`judge-service-profile-${suffix}`],
  );
  const question = await db.query<{ id:string }>(
    `insert into questions(
       public_id,status,subject,grade,purpose,difficulty,question_type,
       evidence_mode
     ) values(
       $1,'APPROVED','과학','중학교','선수관계','중','short_answer',
       'closed_book'
     )
     returning id`,
    [`JUDGE-SERVICE-Q-${suffix}`],
  );
  await db.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,scoring_criteria
     ) values($1,1,'질문','답','[]'::jsonb)`,
    [question.rows[0]!.id],
  );
  const run = await db.query<{
    id:string;
    scoring_engine_version_id:string;
  }>(
    `insert into benchmark_runs(
       public_id,title,dataset_version_id,score_profile_id,
       price_profile_version,system_prompt,parameters
     ) values(
       $1,'Judge 호출 실행',$2,$3,'test-price-v1','답하라.','{}'::jsonb
     )
     returning id,scoring_engine_version_id`,
    [`JUDGE-SERVICE-RUN-${suffix}`, dataset.rows[0]!.id, profile.rows[0]!.id],
  );
  const model = await db.query<{ id:string }>(
    `insert into run_models(
       benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
     ) values($1,'gemini','Gemini','M01','candidate-v1','gemini')
     returning id`,
    [run.rows[0]!.id],
  );
  const item = await db.query<{ id:string }>(
    `insert into run_items(
       benchmark_run_id,run_model_id,question_id,question_revision,
       idempotency_key
     ) values($1,$2,$3,1,$4)
     returning id`,
    [
      run.rows[0]!.id,
      model.rows[0]!.id,
      question.rows[0]!.id,
      `judge-service-item-${suffix}`,
    ],
  );
  const response = await db.query<{ id:string }>(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text
     ) values($1,1,'candidate-v1','후보 답변','후보 답변')
     returning id`,
    [item.rows[0]!.id],
  );
  return {
    runId:run.rows[0]!.id,
    responseId:response.rows[0]!.id,
    profileId:profile.rows[0]!.id,
    engineId:run.rows[0]!.scoring_engine_version_id,
  };
}

function reservationInput(
  fixture: Fixture,
  metrics = ['accuracy', 'faithfulness'],
): ReserveJudgeInvocationInput {
  return {
    benchmarkRunId:fixture.runId,
    modelResponseId:fixture.responseId,
    scoreProfileId:fixture.profileId,
    scoringEngineVersionId:fixture.engineId,
    invocationKind:'PRIMARY',
    requestedMetricKeys:metrics,
    requestSnapshot:{
      system:'judge-system',
      prompt:{ requiredMetrics:metrics },
      maxOutputTokens:8192,
      temperature:0,
    },
    providerKey:'gemini',
    modelId:'judge-v1',
  };
}

async function commitFixtureResponse(invocationId: string) {
  return commitJudgeResponse({
    invocationId,
    response:{
      text:'{"scores":[{"metricKey":"accuracy","value":1,"label":"PASS","rationale":"정확함"}]}',
      raw:{ id:'raw-1', candidates:[{ finishReason:'STOP' }] },
      inputTokens:13,
      outputTokens:21,
      finishReason:'STOP',
      requestId:'provider-request-1',
      modelId:'judge-v1',
      modelSnapshot:'judge-v1-2026-07',
      latencyMs:34,
    },
  });
}

test('reserves once, defers a live request, and replaces only a stale request with a monotonic attempt', async () => {
  const fixture = await createFixture();
  const input = reservationInput(fixture);

  const first = await reserveOrResumeJudgeInvocation({
    ...input,
    staleAfterMs:60_000,
  });
  expect(first).toMatchObject({
    created:true,
    nextAction:'CALL_PROVIDER',
    invocation:{ state:'REQUESTED', attempt:1 },
  });

  const liveDuplicate = await reserveOrResumeJudgeInvocation({
    ...input,
    requestedMetricKeys:['faithfulness', 'accuracy'],
    staleAfterMs:60_000,
  });
  expect(liveDuplicate).toMatchObject({
    created:false,
    nextAction:'WAIT_FOR_REQUEST',
    invocation:{ id:first.invocation.id, attempt:1 },
  });

  await expect(reserveOrResumeJudgeInvocation({
    ...input,
    providerKey:'different-provider',
    staleAfterMs:0,
  })).rejects.toMatchObject({ code:'JUDGE_INVOCATION_CONTEXT_MISMATCH' });

  const staleReplacement = await reserveOrResumeJudgeInvocation({
    ...input,
    staleAfterMs:0,
  });
  expect(staleReplacement).toMatchObject({
    created:true,
    nextAction:'CALL_PROVIDER',
    invocation:{ state:'REQUESTED', attempt:2 },
  });

  const attempts = await db.query<{
    attempt:number;
    state:string;
    error_code:string | null;
    error_stage:string | null;
  }>(
    `select attempt,state,error_code,error_stage
     from judge_invocations
     where model_response_id=$1
     order by attempt`,
    [fixture.responseId],
  );
  expect(attempts.rows).toEqual([
    {
      attempt:1,
      state:'FAILED',
      error_code:'REQUEST_OUTCOME_UNKNOWN',
      error_stage:'RECOVERY',
    },
    {
      attempt:2,
      state:'REQUESTED',
      error_code:null,
      error_stage:null,
    },
  ]);
});

test('resumes from committed provider and parse checkpoints without requesting the provider again', async () => {
  const fixture = await createFixture();
  const input = reservationInput(fixture);
  const reserved = await reserveOrResumeJudgeInvocation(input);

  await commitFixtureResponse(reserved.invocation.id);
  const afterResponse = await reserveOrResumeJudgeInvocation({
    ...input,
    staleAfterMs:0,
  });
  expect(afterResponse).toMatchObject({
    created:false,
    nextAction:'PARSE_STORED_RESPONSE',
    invocation:{
      id:reserved.invocation.id,
      state:'RESPONSE_RECEIVED',
      providerRequestId:'provider-request-1',
      responseModelId:'judge-v1',
      responseModelSnapshot:'judge-v1-2026-07',
      finishReason:'STOP',
      inputTokens:13,
      outputTokens:21,
      latencyMs:34,
      rawResponse:{ id:'raw-1', candidates:[{ finishReason:'STOP' }] },
    },
  });

  await commitJudgeParse({
    invocationId:reserved.invocation.id,
    parsedResponse:{
      scores:[
        {
          metricKey:'accuracy',
          value:1,
          label:'PASS',
          rationale:'정확함',
          evidence:[],
        },
        {
          metricKey:'Faithfulness',
          value:1,
          label:'WRONG_KEY',
          rationale:'대소문자가 다른 키',
          evidence:[],
        },
      ],
    },
    resolvedMetricKeys:['accuracy'],
    missingMetricKeys:['faithfulness'],
  });
  const afterParse = await reserveOrResumeJudgeInvocation(input);
  expect(afterParse).toMatchObject({
    created:false,
    nextAction:'PERSIST_PARSED_SCORES',
    invocation:{
      id:reserved.invocation.id,
      state:'PARSED',
      resolvedMetricKeys:['accuracy'],
      missingMetricKeys:['faithfulness'],
    },
  });
});

test('does not deadlock a resume against a transition that already owns the invocation row', async () => {
  const fixture = await createFixture();
  const input = reservationInput(fixture, ['accuracy']);
  const reserved = await reserveOrResumeJudgeInvocation(input);
  await commitFixtureResponse(reserved.invocation.id);
  await commitJudgeParse({
    invocationId:reserved.invocation.id,
    parsedResponse:{
      scores:[{
        metricKey:'accuracy',
        value:1,
        label:'PASS',
        rationale:'정확함',
        evidence:[],
      }],
    },
    resolvedMetricKeys:['accuracy'],
    missingMetricKeys:[],
  });

  const transitionClient = await db.connect();
  let transactionOpen = false;
  try {
    await transitionClient.query('begin');
    transactionOpen = true;
    await transitionClient.query(
      'select id from judge_invocations where id=$1 for update',
      [reserved.invocation.id],
    );

    const resume = reserveOrResumeJudgeInvocation(input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(transitionClient.query(
      'select id from model_responses where id=$1 for share',
      [fixture.responseId],
    )).resolves.toMatchObject({ rowCount:1 });
    await transitionClient.query('rollback');
    transactionOpen = false;

    await expect(resume).resolves.toMatchObject({
      created:false,
      nextAction:'PERSIST_PARSED_SCORES',
      invocation:{ id:reserved.invocation.id },
    });
  } finally {
    if (transactionOpen) await transitionClient.query('rollback');
    transitionClient.release();
  }
});

test('persists only the exact resolved metric set atomically and resumes a persisted invocation as complete', async () => {
  const fixture = await createFixture();
  const input = reservationInput(fixture);
  const reserved = await reserveOrResumeJudgeInvocation(input);
  await commitFixtureResponse(reserved.invocation.id);
  await commitJudgeParse({
    invocationId:reserved.invocation.id,
    parsedResponse:{
      scores:[{
        metricKey:'accuracy',
        value:0.75,
        label:'PARTIAL',
        rationale:'일부 정확함',
        evidence:[{ claim:'핵심 개념 일부 충족' }],
      }],
    },
    resolvedMetricKeys:['accuracy'],
    missingMetricKeys:['faithfulness'],
  });

  await expect(persistJudgeScores({
    invocationId:reserved.invocation.id,
    scores:[{
      metricKey:'Accuracy',
      value:0.75,
      label:'PARTIAL',
      rationale:'잘못된 키',
      evidence:[],
    }],
  })).rejects.toMatchObject({ code:'JUDGE_SCORE_METRIC_SET_MISMATCH' });
  const beforeSuccess = await db.query<{ state:string; scores:string }>(
    `select invocation.state,
       count(score.id)::text scores
     from judge_invocations invocation
     left join scores score on score.judge_invocation_id=invocation.id
     where invocation.id=$1
     group by invocation.id`,
    [reserved.invocation.id],
  );
  expect(beforeSuccess.rows[0]).toEqual({ state:'PARSED', scores:'0' });

  const persisted = await persistJudgeScores({
    invocationId:reserved.invocation.id,
    scores:[{
      metricKey:'accuracy',
      value:0.75,
      label:'PARTIAL',
      rationale:'일부 정확함',
      evidence:[{ claim:'핵심 개념 일부 충족' }],
    }],
  });
  expect(persisted).toMatchObject({
    insertedScores:1,
    invocation:{ state:'PERSISTED' },
  });

  const stored = await db.query<{
    state:string;
    metric_key:string;
    provenance:string;
    judge_invocation_id:string;
    event_type:string;
    payload:Record<string, unknown>;
  }>(
    `select invocation.state,score.metric_key,score.provenance,
       score.judge_invocation_id,event.event_type,event.payload
     from judge_invocations invocation
     join scores score on score.judge_invocation_id=invocation.id
     join job_events event
       on event.aggregate_type='benchmark_run'
      and event.aggregate_id=invocation.benchmark_run_id
      and event.event_type='JUDGE_SCORES_PERSISTED'
      and event.payload->>'invocationId'=invocation.id::text
     where invocation.id=$1`,
    [reserved.invocation.id],
  );
  expect(stored.rows[0]).toMatchObject({
    state:'PERSISTED',
    metric_key:'accuracy',
    provenance:'JUDGE_INVOCATION_VERIFIED',
    judge_invocation_id:reserved.invocation.id,
    event_type:'JUDGE_SCORES_PERSISTED',
    payload:{
      invocationId:reserved.invocation.id,
      metricKeys:['accuracy'],
      missingMetricKeys:['faithfulness'],
      scoreCount:1,
    },
  });
  expect(JSON.stringify(stored.rows[0]!.payload)).not.toContain('일부 정확함');

  const resumed = await reserveOrResumeJudgeInvocation(input);
  expect(resumed).toMatchObject({
    created:false,
    nextAction:'COMPLETE',
    invocation:{ id:reserved.invocation.id, state:'PERSISTED' },
  });
});

test('keeps a single-metric fallback logically distinct from its primary invocation', async () => {
  const fixture = await createFixture();
  const primaryInput = reservationInput(fixture, ['accuracy']);
  const primary = await reserveOrResumeJudgeInvocation(primaryInput);
  await commitFixtureResponse(primary.invocation.id);
  await commitJudgeParse({
    invocationId:primary.invocation.id,
    parsedResponse:{ scores:[] },
    resolvedMetricKeys:[],
    missingMetricKeys:['accuracy'],
  });
  await persistJudgeScores({
    invocationId:primary.invocation.id,
    scores:[],
  });

  const fallback = await reserveOrResumeJudgeInvocation({
    ...primaryInput,
    invocationKind:'FALLBACK',
    parentInvocationId:primary.invocation.id,
  });
  expect(fallback).toMatchObject({
    created:true,
    nextAction:'CALL_PROVIDER',
    invocation:{
      invocationKind:'FALLBACK',
      parentInvocationId:primary.invocation.id,
      requestedMetricKeys:['accuracy'],
      attempt:1,
    },
  });
  expect(fallback.invocation.logicalKey).not.toBe(
    primary.invocation.logicalKey,
  );
});

test('records an invocation failure and a compact benchmark event before a monotonic retry', async () => {
  const fixture = await createFixture();
  const input = reservationInput(fixture, ['accuracy']);
  const reserved = await reserveOrResumeJudgeInvocation(input);
  await commitFixtureResponse(reserved.invocation.id);

  const failed = await failJudgeInvocationAndRecordRun({
    invocationId:reserved.invocation.id,
    errorCode:'JUDGE_PARSE_FAILED',
    errorMessage:'응답 JSON 구조가 올바르지 않습니다.',
    errorStage:'PARSE',
  });
  expect(failed).toMatchObject({
    state:'FAILED',
    errorCode:'JUDGE_PARSE_FAILED',
    errorStage:'PARSE',
  });

  const event = await db.query<{
    event_type:string;
    payload:Record<string, unknown>;
  }>(
    `select event_type,payload
     from job_events
     where aggregate_type='benchmark_run'
       and aggregate_id=$1
       and event_type='JUDGE_INVOCATION_FAILED'
       and payload->>'invocationId'=$2
     order by id desc limit 1`,
    [fixture.runId, reserved.invocation.id],
  );
  expect(event.rows[0]).toMatchObject({
    event_type:'JUDGE_INVOCATION_FAILED',
    payload:{
      invocationId:reserved.invocation.id,
      attempt:1,
      code:'JUDGE_PARSE_FAILED',
      stage:'PARSE',
    },
  });
  expect(JSON.stringify(event.rows[0]!.payload)).not.toContain('raw-1');
  expect(JSON.stringify(event.rows[0]!.payload)).not.toContain('scores');

  const retry = await reserveOrResumeJudgeInvocation(input);
  expect(retry).toMatchObject({
    created:true,
    nextAction:'CALL_PROVIDER',
    invocation:{ attempt:2, state:'REQUESTED' },
  });
});
