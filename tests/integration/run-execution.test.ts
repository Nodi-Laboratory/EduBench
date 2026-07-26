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
  expect(stored.rows[0]).toEqual({ state:'COMPLETED', score_count:'9', judge_count:'7' });
  const exported = await exportResult(
    new Request(`http://localhost/api/results/${run.id}/export?format=json`),
    { params: Promise.resolve({ id: run.id }) },
  );
  expect(exported.status).toBe(200);
  const body = await exported.json();
  expect(body.run).toMatchObject({ state:'COMPLETED', dataset_content_hash: expect.any(String) });
  expect(body.items[0]).toMatchObject({ provider_request_id: expect.any(String), raw_response: expect.any(Object) });
  expect(Object.keys(body.items[0].scores)).toHaveLength(9);
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
    await expect(scoreRun(run.id)).rejects.toThrow('JUDGE_PROVIDER_FAILED');
  } finally {
    judgeSpy.mockRestore();
  }

  const stored = await db.query<{
    state: string;
    error_code: string;
    attempts: string;
    failure_events: string;
  }>(
    `select br.state,
       br.last_scoring_error->>'code' error_code,
       br.last_scoring_error->>'attempts' attempts,
       (select count(*) from job_events
        where aggregate_type='benchmark_run' and aggregate_id=br.id
          and event_type='RUN_SCORING_FAILED')::text failure_events
     from benchmark_runs br where br.id=$1`,
    [run.id],
  );
  expect(stored.rows[0]).toEqual({
    state: 'SCORING',
    error_code: 'JUDGE_PROVIDER_FAILED',
    attempts: '1',
    failure_events: '1',
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
