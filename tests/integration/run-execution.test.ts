import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import {
  beginScoringWhenExecutionFinished,
  claimRunItems,
  commandRun,
  createRun,
  finishPauseWhenDrained,
} from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import type {
  GenerationRequest,
  ModelProvider,
  NormalizedGeneration,
} from '@/server/providers/types';
import { ProviderError } from '@/server/providers/types';
import { MockProvider } from '@/server/providers/mock';
import { recordScoringFailure, scoreRun } from '@/server/scoring/service';
import {
  providerRateLimitCooldownMs,
  registerBenchmarkProviderRateLimit,
} from '@/server/runs/provider-cooldown';
import { GET as exportResult } from '@/app/api/results/[id]/export/route';
import { createRealPublishedDataset } from './helpers/real-dataset';
import { DomainError } from '@/domain/errors';

let datasetVersionId: string;
beforeAll(async () => { await migrate(); await seedDatabase(); datasetVersionId = await createRealPublishedDataset(1); });
afterAll(async () => { await db.end(); });

async function waitForScoringAdvisoryLock(runId: string): Promise<boolean> {
  const lockName = `edubench:score-run:${runId}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.query<{ held: boolean }>(
      `select exists(
         select 1 from pg_locks
         where locktype = 'advisory' and granted and objsubid = 1
           and classid = (((hashtextextended($1, 0) >> 32) & 4294967295)::oid)
           and objid = ((hashtextextended($1, 0) & 4294967295)::oid)
       ) held`,
      [lockName],
    );
    if (result.rows[0]?.held) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('rejects a provider whose model differs from the persisted run model before generation', async () => {
  const run = await createRun({
    title: `실행 모델 불일치 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini B', modelId: 'persisted-model-b', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-model-mismatch', 1, 30_000);
  let providerCalls = 0;
  const environmentModelA: ModelProvider = {
    key: 'gemini',
    modelId: 'environment-model-a',
    async generate() {
      providerCalls += 1;
      throw new Error('provider must not be called');
    },
  };

  await expect(executeRunItem(item!, 'worker-model-mismatch', environmentModelA))
    .rejects.toMatchObject({ code: 'RUN_MODEL_MISMATCH' });
  expect(providerCalls).toBe(0);
  const stored = await db.query<{ responses: string; state: string }>(
    `select count(mr.id)::text responses, max(ri.state)::text state
     from run_items ri left join model_responses mr on mr.run_item_id = ri.id
     where ri.id = $1`,
    [item!.id],
  );
  expect(stored.rows[0]).toEqual({ responses: '0', state: 'LEASED' });
});

test('executes a leased item and preserves the normalized and raw provider response', async () => {
  const run = await createRun({
    title: `실행 저장 테스트 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'fake', displayName: '가상 모델', modelId: 'fake-v1', protocol: 'openai-compatible' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-test', 1, 30_000);
  const provider: ModelProvider = {
    key: 'fake', modelId: 'fake-v1',
    async generate() { return { text: '  정답입니다.  ', raw: { id: 'raw-1', choices: [1] }, inputTokens: 12, outputTokens: 4, finishReason: 'stop', requestId: 'req-1', modelId: 'fake-v1', modelSnapshot: 'fake-2026-07', latencyMs: 27 }; },
  };

  await executeRunItem(item!, 'worker-test', provider);
  const stored = await db.query<{ state: string; request_snapshot: { system: string; prompt: string; providerKey: string }; response_text: string; normalized_text: string; raw_response: { id: string }; input_tokens: number; latency_ms: number }>(
    `select ri.state,ri.request_snapshot, mr.response_text, mr.normalized_text, mr.raw_response, mr.input_tokens, mr.latency_ms
     from run_items ri join model_responses mr on mr.run_item_id = ri.id where ri.id = $1`, [item!.id],
  );
  expect(stored.rows[0]).toMatchObject({ state: 'SUCCEEDED', response_text: '  정답입니다.  ', normalized_text: '정답입니다.', raw_response: { id: 'raw-1' }, input_tokens: 12, latency_ms: 27 });
  expect(stored.rows[0]?.request_snapshot).toMatchObject({
    system: '교과서 근거에 따라 답하라.', providerKey: 'fake', prompt: expect.stringContaining('[질문]'),
  });
});

test('completes only after deterministic and blind judge metrics are persisted', async () => {
  const run = await createRun({
    title: `실제 채점 흐름 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-score-test', 1, 30_000);
  await executeRunItem(item!, 'worker-score-test', new MockProvider('gemini', 'gemini-test'));
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);

  const stored = await db.query<{ state: string; score_count: string; judge_count: string }>(
    `select br.state, count(s.id)::text score_count,
       count(s.id) filter (where s.judge_provider is not null)::text judge_count
     from benchmark_runs br join run_items ri on ri.benchmark_run_id = br.id
     join model_responses mr on mr.run_item_id = ri.id join scores s on s.model_response_id = mr.id
     where br.id = $1 group by br.id`, [run.id],
  );
  expect(stored.rows[0]).toEqual({ state:'COMPLETED', score_count:'8', judge_count:'7' });
  const retiredScores = await db.query<{ count:string }>(
    `select count(*)::text count
     from scores score
     join model_responses response on response.id=score.model_response_id
     join run_items item on item.id=response.run_item_id
     where item.benchmark_run_id=$1 and score.metric_key='exact_match'`,
    [run.id],
  );
  expect(retiredScores.rows[0]?.count).toBe('0');
  const exported = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params: Promise.resolve({ id: run.id }) },
  );
  expect(exported.status).toBe(200);
  const body = await exported.json();
  expect(body.run).toMatchObject({ state:'COMPLETED', dataset_content_hash: expect.any(String) });
  expect(body.items[0]).toMatchObject({ provider_request_id: expect.any(String), raw_response: expect.any(Object) });
  expect(Object.keys(body.items[0].scores)).toHaveLength(8);
  expect(body.items[0].scores).not.toHaveProperty('exact_match');
  const audit = await db.query<{
    invocation_kind:string;
    state:string;
    requested_metric_keys:string[];
    max_output_tokens:string;
    score_count:string;
    verified_score_count:string;
  }>(
    `select invocation.invocation_kind,invocation.state,
       invocation.requested_metric_keys,
       invocation.request_snapshot->>'maxOutputTokens' max_output_tokens,
       count(score.id)::text score_count,
       count(score.id) filter (
         where score.provenance='JUDGE_INVOCATION_VERIFIED'
           and score.judge_invocation_id=invocation.id
       )::text verified_score_count
     from judge_invocations invocation
     left join scores score on score.judge_invocation_id=invocation.id
     where invocation.benchmark_run_id=$1
     group by invocation.id`,
    [run.id],
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0]).toMatchObject({
    invocation_kind:'PRIMARY',
    state:'PERSISTED',
    requested_metric_keys:expect.arrayContaining([
      'accuracy',
      'faithfulness',
      'completeness',
    ]),
    max_output_tokens:'8192',
    score_count:'7',
    verified_score_count:'7',
  });
  const pdf = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=pdf`),
    { params: Promise.resolve({ id: run.id }) },
  );
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 4))).toBe('%PDF');
});

test('allows only one concurrent scorer to claim a run and emit its judge set and completion event', async () => {
  const run = await createRun({
    title: `채점 원자 소유권 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'candidate-model-b', protocol: 'gemini' }],
  });
  await commandRun(run.id, 'QUEUE'); await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-concurrent-score', 1, 30_000);
  await executeRunItem(item!, 'worker-concurrent-score', new MockProvider('gemini', 'candidate-model-b'));
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const blocker = await db.connect();
  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate');
  let blockerOpen = false;
  let firstScoring: ReturnType<typeof scoreRun> | null = null;
  try {
    await blocker.query('begin');
    blockerOpen = true;
    await blocker.query('lock table benchmark_runs in access exclusive mode');
    firstScoring = scoreRun(run.id);

    expect(await waitForScoringAdvisoryLock(run.id)).toBe(true);
    await expect(scoreRun(run.id)).resolves.toEqual({ scoredResponses: 0, claimed: false });

    await blocker.query('rollback');
    blockerOpen = false;
    await expect(firstScoring).resolves.toEqual({ scoredResponses: 1, claimed: true });
    const judgeCalls = judgeSpy.mock.calls.filter(([request]) => request.system.includes('EDUBENCH_JUDGE_JSON'));
    expect(judgeCalls).toHaveLength(1);
  } finally {
    if (blockerOpen) await blocker.query('rollback');
    blocker.release();
    if (firstScoring) await firstScoring.catch(() => undefined);
    judgeSpy.mockRestore();
  }

  const persisted = await db.query<{ judge_scores: string; completion_events: string }>(
    `select
       (select count(*) from scores s
        join model_responses mr on mr.id = s.model_response_id
        join run_items ri on ri.id = mr.run_item_id
        where ri.benchmark_run_id = $1 and s.judge_provider is not null)::text judge_scores,
       (select count(*) from job_events
        where aggregate_type = 'benchmark_run' and aggregate_id = $1
          and event_type = 'RUN_COMPLETED')::text completion_events`,
    [run.id],
  );
  expect(persisted.rows[0]).toEqual({ judge_scores: '7', completion_events: '1' });
});

test('does not regress a completed run when a stale scorer records a failure', async () => {
  const run = await createRun({
    title: `종료 상태 채점 실패 보호 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001', priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.', questionLimit: 1,
    models: [{ providerKey: 'gemini', displayName: 'Gemini', modelId: 'gemini-test', protocol: 'gemini' }],
  });
  await db.query("update benchmark_runs set state = 'COMPLETED', completed_at = now() where id = $1", [run.id]);

  await expect(recordScoringFailure(run.id, new Error('JUDGE_PARSE_FAILED: stale worker')))
    .resolves.toEqual({ attempts: 0, state: 'COMPLETED' });
  const stored = await db.query<{ state: string; last_scoring_error: unknown; failure_events: string }>(
    `select br.state, br.last_scoring_error,
       (select count(*) from job_events
        where aggregate_type = 'benchmark_run' and aggregate_id = br.id
          and event_type = 'RUN_SCORING_FAILED')::text failure_events
     from benchmark_runs br where br.id = $1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state: 'COMPLETED',
    last_scoring_error: null,
    failure_events: '0',
  });
});

test('returns an in-flight run item to pending when the worker shuts down', async () => {
  const run = await createRun({
    title:`실행 종료 복구 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'shutdown-candidate',
      protocol:'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const workerId = 'worker-execution-shutdown';
  const [item] = await claimRunItems(run.id, workerId, 1, 30_000);
  const controller = new AbortController();
  let providerCalls = 0;
  const provider:ModelProvider = {
    key:'gemini',
    modelId:'shutdown-candidate',
    generate:async (_request, signal) => {
      providerCalls += 1;
      return new Promise<NormalizedGeneration>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new ProviderError({
          kind:'NETWORK',
          message:'adapter converted abort to a retryable network error',
          retryable:true,
          cause:signal.reason,
        })), { once:true });
      });
    },
  };

  const execution = executeRunItem(
    item!,
    workerId,
    provider,
    { signal:controller.signal },
  );
  await vi.waitFor(async () => {
    const snapshot = await db.query<{ request_snapshot:unknown }>(
      'select request_snapshot from run_items where id=$1',
      [item!.id],
    );
    expect(snapshot.rows[0]?.request_snapshot).not.toBeNull();
  });
  controller.abort(new Error('WORKER_SHUTDOWN'));
  await expect(execution).resolves.toBeUndefined();
  expect(providerCalls).toBe(1);

  const released = await db.query<{ state:string; attempts:number }>(
    'select state,attempts from run_items where id=$1',
    [item!.id],
  );
  expect(released.rows[0]).toEqual({ state:'PENDING', attempts:0 });
});

test('records a scoring failure while the scorer still owns the run lock', async () => {
  const run = await createRun({
    title: `채점 실패 원자 기록 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '교과서 근거에 따라 답하라.',
    questionLimit: 1,
    models: [{
      providerKey: 'gemini',
      displayName: 'Gemini',
      modelId: 'candidate-model-failure',
      protocol: 'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-score-failure', 1, 30_000);
  await executeRunItem(
    item!,
    'worker-score-failure',
    new MockProvider('gemini', 'candidate-model-failure'),
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
    .mockRejectedValueOnce(new Error('JUDGE_PROVIDER_FAILED: fixture failure'));
  try {
    await expect(scoreRun(run.id)).resolves.toEqual({
      scoredResponses:0,
      claimed:true,
    });
  } finally {
    judgeSpy.mockRestore();
  }

  const stored = await db.query<{
    state: string;
    error_code: string;
    attempts: string;
    retry_events: string;
  }>(
    `select br.state,
       br.last_scoring_error->>'code' error_code,
       br.last_scoring_error->>'attempts' attempts,
       (select count(*) from job_events
        where aggregate_type='benchmark_run' and aggregate_id=br.id
          and event_type='RUN_SCORE_RESPONSE_RETRY_SCHEDULED')::text retry_events
     from benchmark_runs br where br.id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state: 'SCORING',
    error_code: 'JUDGE_PROVIDER_FAILED',
    attempts: '0',
    retry_events: '1',
  });
});

test('preserves a DomainError code and schedules a bounded scoring retry', async () => {
  const run = await createRun({
    title: `채점 백오프 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '답하라.',
    questionLimit: 1,
    models: [{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-test',
      protocol:'gemini',
    }],
  });
  await db.query("update benchmark_runs set state='SCORING' where id=$1", [run.id]);

  await expect(recordScoringFailure(
    run.id,
    new DomainError('JUDGE_METRIC_MISSING', '필수 지표가 없습니다.'),
  )).resolves.toMatchObject({ attempts:1, state:'SCORING' });

  const stored = await db.query<{
    code:string;
    retry_at:string;
    retry_delay_ms:string;
  }>(
    `select
       last_scoring_error->>'code' code,
       last_scoring_error->>'retryAt' retry_at,
       last_scoring_error->>'retryDelayMs' retry_delay_ms
     from benchmark_runs where id=$1`,
    [run.id],
  );
  expect(stored.rows[0]?.code).toBe('JUDGE_METRIC_MISSING');
  expect(Number(stored.rows[0]?.retry_delay_ms)).toBeGreaterThan(0);
  expect(new Date(stored.rows[0]!.retry_at).getTime()).toBeGreaterThan(Date.now());
});

test('aborts an in-flight Judge request on scoring pause without counting it as a run failure', async () => {
  const run = await createRun({
    title: `채점 호출 중단 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId: '20000000-0000-0000-0000-000000000001',
    priceProfileVersion: 'test-price-v1',
    systemPrompt: '답하라.',
    questionLimit: 1,
    models: [{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'candidate-model-control',
      protocol:'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-score-control', 1, 30_000);
  await executeRunItem(
    item!,
    'worker-score-control',
    new MockProvider('gemini', 'candidate-model-control'),
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
    .mockImplementationOnce(async (
      _request:GenerationRequest,
      signal?:AbortSignal,
    ): Promise<NormalizedGeneration> => new Promise<NormalizedGeneration>((_, reject) => {
      signal?.addEventListener('abort', () => {
        reject(signal.reason);
      }, { once:true });
    }));
  try {
    const scoring = scoreRun(run.id);
    expect(await waitForScoringAdvisoryLock(run.id)).toBe(true);
    expect((await commandRun(run.id, 'PAUSE')).state).toBe('PAUSING');
    await expect(scoring).rejects.toMatchObject({
      code:'RUN_SCORING_CONTROL_REQUESTED',
    });
  } finally {
    judgeSpy.mockRestore();
  }

  expect(await finishPauseWhenDrained(run.id)).toBe(true);
  const paused = await db.query<{
    state:string;
    last_scoring_error:unknown;
    invocation_state:string;
    invocation_error_code:string;
  }>(
    `select br.state,br.last_scoring_error,
       ji.state invocation_state,ji.error_code invocation_error_code
     from benchmark_runs br
     join judge_invocations ji on ji.benchmark_run_id=br.id
     where br.id=$1
     order by ji.requested_at desc
     limit 1`,
    [run.id],
  );
  expect(paused.rows[0]).toMatchObject({
    state:'PAUSED',
    last_scoring_error:null,
    invocation_state:'FAILED',
    invocation_error_code:'RUN_SCORING_CONTROL_REQUESTED',
  });
  expect((await commandRun(run.id, 'RESUME')).state).toBe('SCORING');
});

test('aborts an in-flight Judge on worker shutdown without failing the run', async () => {
  const run = await createRun({
    title:`채점 종료 복구 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'judge-shutdown-candidate',
      protocol:'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-judge-shutdown', 1, 30_000);
  await executeRunItem(
    item!,
    'worker-judge-shutdown',
    new MockProvider('gemini', 'judge-shutdown-candidate'),
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  const controller = new AbortController();
  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
    .mockImplementationOnce(async (
      _request:GenerationRequest,
      signal?:AbortSignal,
    ): Promise<NormalizedGeneration> => new Promise<NormalizedGeneration>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once:true });
    }));
  try {
    const scoring = scoreRun(run.id, controller.signal);
    expect(await waitForScoringAdvisoryLock(run.id)).toBe(true);
    controller.abort(new Error('WORKER_SHUTDOWN'));
    await expect(scoring).resolves.toEqual({ scoredResponses:0, claimed:true });
  } finally {
    judgeSpy.mockRestore();
  }

  const stored = await db.query<{ state:string; last_scoring_error:unknown }>(
    'select state,last_scoring_error from benchmark_runs where id=$1',
    [run.id],
  );
  expect(stored.rows[0]).toEqual({ state:'SCORING', last_scoring_error:null });
});

test('reports a missing scoring run instead of treating it as a duplicate claimant', async () => {
  await expect(scoreRun(randomUUID())).rejects.toMatchObject({ code:'RUN_NOT_FOUND' });
});

test('a first rate limit releases the item and blocks only that provider across runs until automatic resume', async () => {
  const providerKey = `quota-${randomUUID().slice(0, 8)}`;
  const unaffectedProviderKey = `quota-other-${randomUUID().slice(0, 8)}`;
  const createActiveRun = async (
    title:string,
    selectedProviderKey:string,
    modelId:string,
  ) => {
    const run = await createRun({
      title,
      datasetVersionId,
      scoreProfileId:'20000000-0000-0000-0000-000000000001',
      priceProfileVersion:'test-price-v1',
      systemPrompt:'답하라.',
      questionLimit:1,
      models:[{
        providerKey:selectedProviderKey,
        displayName:selectedProviderKey,
        modelId,
        protocol:'openai-compatible',
      }],
    });
    await commandRun(run.id, 'QUEUE');
    await commandRun(run.id, 'START');
    return run;
  };
  const sourceRun = await createActiveRun(
    `quota source ${randomUUID().slice(0, 8)}`,
    providerKey,
    'quota-source-model',
  );
  const blockedPeerRun = await createActiveRun(
    `quota peer ${randomUUID().slice(0, 8)}`,
    providerKey,
    'quota-peer-model',
  );
  const unaffectedRun = await createActiveRun(
    `quota unaffected ${randomUUID().slice(0, 8)}`,
    unaffectedProviderKey,
    'quota-unaffected-model',
  );
  const workerId = `quota-worker-${randomUUID().slice(0, 8)}`;
  const [sourceItem] = await claimRunItems(sourceRun.id, workerId, 1, 30_000);
  let providerCalls = 0;
  const provider:ModelProvider = {
    key:providerKey,
    modelId:'quota-source-model',
    generate:async () => {
      providerCalls += 1;
      throw new ProviderError({
        kind:'RATE_LIMIT',
        message:'RATE_LIMIT: requests per minute exhausted',
        retryable:true,
        status:429,
        requestId:'quota-request-1',
        retryAfterMs:60_000,
        rateLimitDimension:'RPM',
        rateLimitScope:'generate_content_requests_per_minute',
      });
    },
  };

  try {
    await expect(
      executeRunItem(sourceItem!, workerId, provider),
    ).resolves.toBeUndefined();
    expect(providerCalls).toBe(1);

    const deferred = await db.query<{
      state:string;
      attempts:number;
      available_at:Date;
      error_code:string | null;
      failed_items:number;
      blocked_until:Date;
      rate_limit_dimension:string;
      rate_limit_scope:string | null;
      retry_after_ms:number;
      hit_count:number;
    }>(
      `select item.state,item.attempts,item.available_at,item.error_code,
         run.failed_items,cooldown.blocked_until,
         cooldown.rate_limit_dimension,cooldown.rate_limit_scope,
         cooldown.retry_after_ms,cooldown.hit_count
       from run_items item
       join benchmark_runs run on run.id=item.benchmark_run_id
       join benchmark_provider_cooldowns cooldown
         on cooldown.provider_key=$2
       where item.id=$1`,
      [sourceItem!.id, providerKey],
    );
    expect(deferred.rows[0]).toMatchObject({
      state:'RETRY_WAIT',
      attempts:0,
      error_code:'RATE_LIMIT_PAUSED',
      failed_items:0,
      rate_limit_dimension:'RPM',
      rate_limit_scope:'generate_content_requests_per_minute',
      retry_after_ms:60_000,
      hit_count:1,
    });
    expect(deferred.rows[0]?.available_at.getTime()).toBe(
      deferred.rows[0]?.blocked_until.getTime(),
    );

    expect(
      await claimRunItems(blockedPeerRun.id, 'quota-peer-worker', 1, 30_000),
    ).toEqual([]);
    expect(
      await claimRunItems(unaffectedRun.id, 'quota-other-worker', 1, 30_000),
    ).toHaveLength(1);

    await db.query(
      `update benchmark_provider_cooldowns
          set blocked_until=now()-interval '1 second'
        where provider_key=$1`,
      [providerKey],
    );
    await db.query(
      `update run_items
          set available_at=now()-interval '1 second'
        where id=$1`,
      [sourceItem!.id],
    );
    const resumed = await claimRunItems(
      sourceRun.id,
      'quota-resume-worker',
      1,
      30_000,
    );
    expect(resumed).toHaveLength(1);
    expect(
      await claimRunItems(
        blockedPeerRun.id,
        'quota-peer-resume-worker',
        1,
        30_000,
      ),
    ).toHaveLength(1);
    await executeRunItem(resumed[0]!, 'quota-resume-worker', {
      key:providerKey,
      modelId:'quota-source-model',
      generate:async () => ({
        text:'resumed',
        raw:{ resumed:true },
        inputTokens:1,
        outputTokens:1,
        finishReason:'stop',
        requestId:'quota-resumed-request',
        modelId:'quota-source-model',
        modelSnapshot:null,
        latencyMs:1,
      }),
    });
    const succeeded = await db.query<{
      state:string;
      error_code:string | null;
      error_message:string | null;
    }>(
      'select state,error_code,error_message from run_items where id=$1',
      [sourceItem!.id],
    );
    expect(succeeded.rows[0]).toEqual({
      state:'SUCCEEDED',
      error_code:null,
      error_message:null,
    });

    const events = await db.query<{
      event_type:string;
      payload:Record<string, unknown>;
    }>(
      `select event_type,payload
         from job_events
        where aggregate_type='benchmark_run' and aggregate_id=$1
          and event_type in (
            'RUN_PROVIDER_RATE_LIMITED',
            'PROVIDER_COOLDOWN_ACTIVATED',
            'RUN_ITEM_RETRY_SCHEDULED',
            'PROVIDER_COOLDOWN_RESUMED'
          )
        order by id`,
      [sourceRun.id],
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      'RUN_PROVIDER_RATE_LIMITED',
      'PROVIDER_COOLDOWN_ACTIVATED',
      'RUN_ITEM_RETRY_SCHEDULED',
      'PROVIDER_COOLDOWN_RESUMED',
    ]);
    expect(events.rows[0]?.payload).toMatchObject({
      providerKey,
      rateLimitDimension:'RPM',
      retryAfterMs:60_000,
      affectedScope:'PROVIDER_GLOBAL',
      sourceRunId:sourceRun.id,
      automaticResume:true,
    });
    expect(events.rows[3]?.payload).toMatchObject({
      providerKey,
      rateLimitDimension:'RPM',
      automaticResume:true,
    });
    const peerEvent = await db.query<{
      payload:Record<string, unknown>;
    }>(
      `select payload from job_events
        where aggregate_type='benchmark_run' and aggregate_id=$1
          and event_type='RUN_PROVIDER_RATE_LIMITED'
        order by id desc limit 1`,
      [blockedPeerRun.id],
    );
    expect(peerEvent.rows[0]?.payload).toMatchObject({
      providerKey,
      rateLimitDimension:'RPM',
      affectedScope:'PROVIDER_GLOBAL',
      sourceRunId:sourceRun.id,
      automaticResume:true,
    });
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [providerKey],
    );
  }
});

test('provider cooldown delay prefers explicit metadata and otherwise uses dimension fallbacks with overrides', () => {
  const previousDefault = process.env.BENCHMARK_RATE_LIMIT_COOLDOWN_MS;
  const previousRpd = process.env.BENCHMARK_RATE_LIMIT_RPD_COOLDOWN_MS;
  process.env.BENCHMARK_RATE_LIMIT_COOLDOWN_MS = '3456';
  process.env.BENCHMARK_RATE_LIMIT_RPD_COOLDOWN_MS = '7890';
  try {
    expect(providerRateLimitCooldownMs(new ProviderError({
      kind:'RATE_LIMIT',
      message:'explicit daily retry info',
      retryable:true,
      retryAfterMs:2_000_000,
      rateLimitDimension:'RPD',
    }))).toBe(2_000_000);
    expect(providerRateLimitCooldownMs(new ProviderError({
      kind:'RATE_LIMIT',
      message:'daily fallback',
      retryable:true,
      rateLimitDimension:'RPD',
    }))).toBe(7_890);
    expect(providerRateLimitCooldownMs(new ProviderError({
      kind:'RATE_LIMIT',
      message:'zero is not a useful explicit pause',
      retryable:true,
      retryAfterMs:0,
      rateLimitDimension:'RPM',
    }))).toBe(3_456);
    expect(providerRateLimitCooldownMs(new ProviderError({
      kind:'RATE_LIMIT',
      message:'token fallback',
      retryable:true,
      rateLimitDimension:'TPM',
    }))).toBe(3_456);
    expect(providerRateLimitCooldownMs(new ProviderError({
      kind:'RATE_LIMIT',
      message:'unknown fallback',
      retryable:true,
    }))).toBe(3_456);
  } finally {
    if (previousDefault === undefined)
      delete process.env.BENCHMARK_RATE_LIMIT_COOLDOWN_MS;
    else process.env.BENCHMARK_RATE_LIMIT_COOLDOWN_MS = previousDefault;
    if (previousRpd === undefined)
      delete process.env.BENCHMARK_RATE_LIMIT_RPD_COOLDOWN_MS;
    else process.env.BENCHMARK_RATE_LIMIT_RPD_COOLDOWN_MS = previousRpd;
  }
});

test('a scoring rate limit preserves the scoring attempt budget and honors the greatest provider deadline', async () => {
  const run = await createRun({
    title:`scoring quota ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{
      providerKey:'openai',
      displayName:'OpenAI',
      modelId:'scoring-quota-candidate',
      protocol:'openai-responses',
    }],
  });
  await db.query(
    `update benchmark_runs set state='SCORING',last_scoring_error=null
      where id=$1`,
    [run.id],
  );
  const judge = await db.query<{
    provider_key:string;
    model_id:string;
  }>(
    `select score_profile_snapshot->>'judgeProvider' provider_key,
       score_profile_snapshot->>'judgeModel' model_id
     from benchmark_runs where id=$1`,
    [run.id],
  );
  const judgeProvider = judge.rows[0]!.provider_key;
  try {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
    await expect(recordScoringFailure(run.id, new ProviderError({
      kind:'RATE_LIMIT',
      message:'RATE_LIMIT: daily judge quota',
      retryable:true,
      status:429,
      requestId:'judge-quota-1',
      retryAfterMs:90_000,
      rateLimitDimension:'RPD',
      rateLimitScope:'judge_requests_per_day',
    }))).resolves.toEqual({ attempts:0, state:'SCORING' });
    const first = await db.query<{
      state:string;
      last_scoring_error:{
        attempts:number;
        retryAt:string;
        rateLimitDimension:string;
      };
      blocked_until:Date;
      hit_count:number;
    }>(
      `select run.state,run.last_scoring_error,
         cooldown.blocked_until,cooldown.hit_count
       from benchmark_runs run
       join benchmark_provider_cooldowns cooldown
         on cooldown.provider_key=$2
       where run.id=$1`,
      [run.id, judgeProvider],
    );
    expect(first.rows[0]).toMatchObject({
      state:'SCORING',
      last_scoring_error:{
        attempts:0,
        rateLimitDimension:'RPD',
      },
      hit_count:1,
    });
    expect(Date.parse(first.rows[0]!.last_scoring_error.retryAt)).toBe(
      first.rows[0]!.blocked_until.getTime(),
    );

    await expect(recordScoringFailure(run.id, new ProviderError({
      kind:'RATE_LIMIT',
      message:'RATE_LIMIT: shorter retry must not shrink the gate',
      retryable:true,
      status:429,
      retryAfterMs:1_000,
      rateLimitDimension:'RPM',
    }))).resolves.toEqual({ attempts:0, state:'SCORING' });
    const second = await db.query<{
      blocked_until:Date;
      hit_count:number;
      attempts:number;
      rate_limit_dimension:string;
      retry_after_ms:number;
      rate_limit_scope:string | null;
    }>(
      `select cooldown.blocked_until,cooldown.hit_count,
         cooldown.rate_limit_dimension,cooldown.retry_after_ms,
         cooldown.rate_limit_scope,
         (run.last_scoring_error->>'attempts')::int attempts
       from benchmark_runs run
       join benchmark_provider_cooldowns cooldown
         on cooldown.provider_key=$2
       where run.id=$1`,
      [run.id, judgeProvider],
    );
    expect(second.rows[0]).toMatchObject({
      hit_count:2,
      attempts:0,
      rate_limit_dimension:'RPD',
      retry_after_ms:90_000,
      rate_limit_scope:'judge_requests_per_day',
    });
    expect(second.rows[0]!.blocked_until.getTime()).toBe(
      first.rows[0]!.blocked_until.getTime(),
    );
    const effectiveEvent = await db.query<{
      payload:{
        rateLimitDimension:string;
        retryAfterMs:number;
        blockedUntil:string;
      };
    }>(
      `select payload from job_events
        where aggregate_type='benchmark_run' and aggregate_id=$1
          and event_type='RUN_PROVIDER_RATE_LIMITED'
        order by id desc limit 1`,
      [run.id],
    );
    expect(effectiveEvent.rows[0]?.payload).toMatchObject({
      rateLimitDimension:'RPD',
      retryAfterMs:90_000,
      blockedUntil:first.rows[0]!.blocked_until.toISOString(),
    });

    const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate');
    try {
      await expect(scoreRun(run.id)).resolves.toEqual({
        scoredResponses:0,
        claimed:false,
      });
      expect(judgeSpy).not.toHaveBeenCalled();
    } finally {
      judgeSpy.mockRestore();
    }
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
  }
});

test('a cooldown activated during scoring blocks the next judge provider call without spending an attempt', async () => {
  const twoQuestionDatasetVersionId = await createRealPublishedDataset(2);
  const run = await createRun({
    title:`scoring mid-run cooldown ${randomUUID().slice(0, 8)}`,
    datasetVersionId:twoQuestionDatasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:2,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'scoring-mid-run-candidate',
      protocol:'gemini',
      concurrency:2,
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const items = await claimRunItems(
    run.id,
    'worker-scoring-mid-run-cooldown',
    2,
    30_000,
  );
  expect(items).toHaveLength(2);
  for (const item of items) {
    await executeRunItem(
      item,
      'worker-scoring-mid-run-cooldown',
      new MockProvider('gemini', 'scoring-mid-run-candidate'),
    );
  }
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judge = await db.query<{
    provider_key:string;
    model_id:string;
  }>(
    `select score_profile_snapshot->>'judgeProvider' provider_key,
       score_profile_snapshot->>'judgeModel' model_id
     from benchmark_runs where id=$1`,
    [run.id],
  );
  const judgeProvider = judge.rows[0]!.provider_key;
  const judgeModel = judge.rows[0]!.model_id;
  const fallbackJudge = new MockProvider(
    judgeProvider,
    judgeModel,
  );
  const originalGenerate = fallbackJudge.generate.bind(fallbackJudge);
  let judgeCalls = 0;
  try {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
    const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
      .mockImplementation(async (request) => {
        if (request.system.includes('EDUBENCH_JUDGE_JSON')) {
          judgeCalls += 1;
          if (judgeCalls === 1) {
            await registerBenchmarkProviderRateLimit({
              providerKey:judgeProvider,
              error:new ProviderError({
                kind:'RATE_LIMIT',
                message:'RATE_LIMIT: concurrent scoring quota',
                retryable:true,
                status:429,
                requestId:'judge-mid-run-quota-1',
                retryAfterMs:60_000,
                rateLimitDimension:'RPM',
                rateLimitScope:'judge_requests_per_minute',
              }),
              sourceRunId:run.id,
              sourcePhase:'SCORING_JUDGE',
              sourceModelId:judgeModel,
            });
          }
        }
        return originalGenerate(request);
      });
    try {
      await expect(scoreRun(run.id)).resolves.toEqual({
        scoredResponses:0,
        claimed:false,
      });
      expect(judgeCalls).toBe(1);
      expect(judgeSpy).toHaveBeenCalledTimes(1);
    } finally {
      judgeSpy.mockRestore();
    }

    const stored = await db.query<{
      state:string;
      scoring_attempts:number;
    }>(
      `select state,
         coalesce((last_scoring_error->>'attempts')::int, 0) scoring_attempts
       from benchmark_runs where id=$1`,
      [run.id],
    );
    expect(stored.rows[0]).toEqual({
      state:'SCORING',
      scoring_attempts:0,
    });

    await db.query(
      `update benchmark_provider_cooldowns
          set blocked_until=now()-interval '1 second'
        where provider_key=$1`,
      [judgeProvider],
    );
    await expect(scoreRun(run.id)).resolves.toEqual({
      scoredResponses:2,
      claimed:true,
    });
    const resumed = await db.query<{
      state:string;
      failed_error_codes:string[];
    }>(
      `select run.state,
         (select array_agg(invocation.error_code order by invocation.attempt)
          from judge_invocations invocation
          where invocation.benchmark_run_id=run.id
            and invocation.state='FAILED') failed_error_codes
       from benchmark_runs run where run.id=$1`,
      [run.id],
    );
    expect(resumed.rows[0]).toEqual({
      state:'COMPLETED',
      failed_error_codes:['RATE_LIMIT'],
    });
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
  }
});

test('three scoring rate limits preserve invocation audit without terminally consuming the response budget', async () => {
  const run = await createRun({
    title:`scoring repeated quota ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'scoring-repeated-quota-candidate',
      protocol:'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(
    run.id,
    'worker-scoring-repeated-quota',
    1,
    30_000,
  );
  await executeRunItem(
    item!,
    'worker-scoring-repeated-quota',
    new MockProvider('gemini', 'scoring-repeated-quota-candidate'),
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judge = await db.query<{
    provider_key:string;
    model_id:string;
  }>(
    `select score_profile_snapshot->>'judgeProvider' provider_key,
       score_profile_snapshot->>'judgeModel' model_id
     from benchmark_runs where id=$1`,
    [run.id],
  );
  const judgeProvider = judge.rows[0]!.provider_key;
  const judgeModel = judge.rows[0]!.model_id;
  const judgeFallback = new MockProvider(judgeProvider, judgeModel);
  const originalJudgeGenerate = judgeFallback.generate.bind(judgeFallback);
  let judgeCalls = 0;
  try {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
    const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
      .mockImplementation(async (request) => {
        if (request.system.includes('EDUBENCH_JUDGE_JSON')) {
          judgeCalls += 1;
          if (judgeCalls <= 3) {
            throw new ProviderError({
              kind:'RATE_LIMIT',
              message:'judge quota exhausted without a prefixed error code',
              retryable:true,
              status:429,
              requestId:`judge-rate-limit-${judgeCalls}`,
              retryAfterMs:1_000,
              rateLimitDimension:'RPM',
              rateLimitScope:'judge_requests_per_minute',
            });
          }
        }
        return originalJudgeGenerate(request);
      });
    try {
      for (let failure = 0; failure < 3; failure += 1) {
        await expect(scoreRun(run.id)).rejects.toMatchObject({
          kind:'RATE_LIMIT',
        });
        await db.query(
          `update benchmark_provider_cooldowns
              set blocked_until=now()-interval '1 second'
            where provider_key=$1`,
          [judgeProvider],
        );
      }
      await expect(scoreRun(run.id)).resolves.toEqual({
        scoredResponses:1,
        claimed:true,
      });
    } finally {
      judgeSpy.mockRestore();
    }

    const stored = await db.query<{
      state:string;
      attempts:number[];
      invocation_states:string[];
      error_codes:Array<string | null>;
      judge_score_count:string;
      terminal_events:string;
    }>(
      `select run.state,
         (select array_agg(invocation.attempt order by invocation.attempt)
          from judge_invocations invocation
          where invocation.benchmark_run_id=run.id) attempts,
         (select array_agg(invocation.state order by invocation.attempt)
          from judge_invocations invocation
          where invocation.benchmark_run_id=run.id) invocation_states,
         (select array_agg(invocation.error_code order by invocation.attempt)
          from judge_invocations invocation
          where invocation.benchmark_run_id=run.id) error_codes,
         (select count(*) from scores score
          join model_responses response on response.id=score.model_response_id
          join run_items run_item on run_item.id=response.run_item_id
          where run_item.benchmark_run_id=run.id
            and score.judge_provider is not null)::text judge_score_count,
         (select count(*) from job_events event
          where event.aggregate_type='benchmark_run' and event.aggregate_id=run.id
            and event.event_type='RUN_SCORE_RESPONSE_TERMINAL_FAILED')::text terminal_events
       from benchmark_runs run where run.id=$1`,
      [run.id],
    );
    expect(judgeCalls).toBe(4);
    expect(stored.rows[0]).toEqual({
      state:'COMPLETED',
      attempts:[1,2,3,4],
      invocation_states:['FAILED','FAILED','FAILED','PERSISTED'],
      error_codes:['RATE_LIMIT','RATE_LIMIT','RATE_LIMIT',null],
      judge_score_count:'7',
      terminal_events:'0',
    });
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      [judgeProvider],
    );
  }
});

test('continues scoring later responses after a Judge parse failure', async () => {
  const twoQuestionDatasetVersionId = await createRealPublishedDataset(2);
  const run = await createRun({
    title:`Judge 응답 격리 ${randomUUID().slice(0, 8)}`,
    datasetVersionId:twoQuestionDatasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:2,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'judge-response-isolation',
      protocol:'gemini',
      concurrency:2,
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const items = await claimRunItems(run.id, 'worker-judge-isolation', 2, 30_000);
  expect(items).toHaveLength(2);
  for (const item of items) {
    await executeRunItem(
      item,
      'worker-judge-isolation',
      new MockProvider('gemini', 'judge-response-isolation'),
    );
  }
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judgeFallback = new MockProvider('gemini', 'gemini-judge');
  const originalJudgeGenerate = judgeFallback.generate.bind(judgeFallback);
  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate');
  let judgeCalls = 0;
  try {
    judgeSpy.mockImplementation(async (request) => {
      if (request.system.includes('EDUBENCH_JUDGE_JSON')) {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          return {
            text:'not valid Judge JSON',
            raw:{ malformed:true },
            inputTokens:1,
            outputTokens:1,
            finishReason:'stop',
            requestId:'judge-malformed-first-response',
            modelId:'gemini-judge',
            modelSnapshot:null,
            latencyMs:1,
          };
        }
      }
      return originalJudgeGenerate(request);
    });

    await expect(scoreRun(run.id)).resolves.toEqual({
      scoredResponses:1,
      claimed:true,
    });
  } finally {
    judgeSpy.mockRestore();
  }

  const stored = await db.query<{
    state:string;
    failed_invocations:string;
    persisted_responses:string;
    retry_events:string;
  }>(
    `select run.state,
       (select count(*) from judge_invocations invocation
        where invocation.benchmark_run_id=run.id and invocation.state='FAILED')::text
         failed_invocations,
       (select count(distinct score.model_response_id) from scores score
        join model_responses response on response.id=score.model_response_id
        join run_items item on item.id=response.run_item_id
        where item.benchmark_run_id=run.id
          and score.judge_provider is not null)::text persisted_responses,
       (select count(*) from job_events event
        where event.aggregate_type='benchmark_run' and event.aggregate_id=run.id
          and event.event_type='RUN_SCORE_RESPONSE_RETRY_SCHEDULED')::text retry_events
     from benchmark_runs run where run.id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state:'SCORING',
    failed_invocations:'1',
    persisted_responses:'1',
    retry_events:'1',
  });
});

test('completes with missing Judge metrics after three failed response attempts', async () => {
  const run = await createRun({
    title:`Judge terminal response ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'답하라.',
    questionLimit:1,
    models:[{
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'judge-terminal-response',
      protocol:'gemini',
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(run.id, 'worker-judge-terminal', 1, 30_000);
  await executeRunItem(
    item!,
    'worker-judge-terminal',
    new MockProvider('gemini', 'judge-terminal-response'),
  );
  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);

  const judgeFallback = new MockProvider('gemini', 'gemini-judge');
  const originalJudgeGenerate = judgeFallback.generate.bind(judgeFallback);
  const judgeSpy = vi.spyOn(MockProvider.prototype, 'generate')
    .mockImplementation(async (request) => {
      if (request.system.includes('EDUBENCH_JUDGE_JSON')) {
        return {
          text:'not valid Judge JSON',
          raw:{ malformed:true },
          inputTokens:1,
          outputTokens:1,
          finishReason:'stop',
          requestId:`judge-malformed-${randomUUID()}`,
          modelId:'gemini-judge',
          modelSnapshot:null,
          latencyMs:1,
        };
      }
      return originalJudgeGenerate(request);
    });
  try {
    await expect(scoreRun(run.id)).resolves.toEqual({ scoredResponses:0, claimed:true });
    await expect(scoreRun(run.id)).resolves.toEqual({ scoredResponses:0, claimed:true });
    await expect(scoreRun(run.id)).resolves.toEqual({ scoredResponses:0, claimed:true });
  } finally {
    judgeSpy.mockRestore();
  }

  const stored = await db.query<{
    state:string;
    attempts:number[];
    judge_score_count:string;
    retry_events:string;
    terminal_events:string;
  }>(
    `select run.state,
       (select array_agg(invocation.attempt order by invocation.attempt)
        from judge_invocations invocation
        where invocation.benchmark_run_id=run.id and invocation.state='FAILED') attempts,
       (select count(*) from scores score
        join model_responses response on response.id=score.model_response_id
        join run_items item on item.id=response.run_item_id
        where item.benchmark_run_id=run.id
          and score.judge_provider is not null)::text judge_score_count,
       (select count(*) from job_events event
        where event.aggregate_type='benchmark_run' and event.aggregate_id=run.id
          and event.event_type='RUN_SCORE_RESPONSE_RETRY_SCHEDULED')::text retry_events,
       (select count(*) from job_events event
        where event.aggregate_type='benchmark_run' and event.aggregate_id=run.id
          and event.event_type='RUN_SCORE_RESPONSE_TERMINAL_FAILED')::text terminal_events
     from benchmark_runs run where run.id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state:'COMPLETED',
    attempts:[1,2,3],
    judge_score_count:'0',
    retry_events:'2',
    terminal_events:'1',
  });
});
