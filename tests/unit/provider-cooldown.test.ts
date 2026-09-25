import { expect, test, vi } from 'vitest';
import { ProviderError } from '@/server/providers/types';
import {
  providerCooldownDominatesObservation,
  providerRateLimitCooldownMs,
  registerBenchmarkProviderRateLimitWithClient,
} from '@/server/runs/provider-cooldown';

test('bounds a manually constructed provider retry delay before database use', () => {
  const error = new ProviderError({
    kind: 'RATE_LIMIT',
    message: 'excessive manual retry delay',
    retryable: true,
    retryAfterMs: Number.MAX_VALUE,
  });

  expect(providerRateLimitCooldownMs(error)).toBe(604_800_000);
});

test('keeps zero retry delay on the configured fallback path', () => {
  const error = new ProviderError({
    kind: 'RATE_LIMIT',
    message: 'zero retry delay',
    retryable: true,
    retryAfterMs: 0,
  });

  expect(providerRateLimitCooldownMs(error, {
    NODE_ENV: 'test',
    BENCHMARK_RATE_LIMIT_COOLDOWN_MS: '3456',
  })).toBe(3_456);
});

test('reuses only a cooldown that covers the same rate-limit observation', () => {
  const observedAt = Date.parse('2026-07-28T00:00:00.000Z');
  const active = {
    providerKey:'gemini',
    blockedUntil:new Date(observedAt + 60_000),
    rateLimitDimension:'RPM' as const,
    rateLimitScope:'embed-rpm',
    retryAfterMs:60_000,
    sourceRunId:'run',
    sourceRunItemId:'item-a',
    sourcePhase:'ANSWER_RETRIEVAL_EMBEDDING',
    sourceModelId:null,
    requestId:'request-a',
    lastErrorMessage:'rate limited',
    hitCount:1,
    activatedAt:new Date(observedAt),
    resumedAt:null,
    updatedAt:new Date(observedAt),
  };
  const sameRequest = new ProviderError({
    kind:'RATE_LIMIT',
    message:'rate limited',
    retryable:true,
    retryAfterMs:120_000,
    rateLimitDimension:'RPD',
    rateLimitScope:'daily',
    requestId:'request-a',
  });
  expect(providerCooldownDominatesObservation(
    active,
    sameRequest,
    observedAt,
  )).toBe(true);

  const longerGate = new ProviderError({
    kind:'RATE_LIMIT',
    message:'longer rate limit',
    retryable:true,
    retryAfterMs:120_000,
    rateLimitDimension:'RPM',
    rateLimitScope:'embed-rpm',
    requestId:'request-b',
  });
  expect(providerCooldownDominatesObservation(
    active,
    longerGate,
    observedAt,
  )).toBe(false);

  const stricterDimension = new ProviderError({
    kind:'RATE_LIMIT',
    message:'daily rate limit',
    retryable:true,
    retryAfterMs:30_000,
    rateLimitDimension:'RPD',
    rateLimitScope:'embed-rpd',
    requestId:'request-c',
  });
  expect(providerCooldownDominatesObservation(
    active,
    stricterDimension,
    observedAt,
  )).toBe(false);
});

test('keeps longest-gate error metadata and audits the latest shorter observation', async () => {
  const effectiveBlockedUntil = new Date('2026-07-28T00:00:00.000Z');
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    void params;
    if (sql.includes('returning *')) {
      return {
        rows: [{
          provider_key: 'gemini',
          blocked_until: effectiveBlockedUntil,
          rate_limit_dimension: 'RPD',
          rate_limit_scope: 'daily-quota',
          retry_after_ms: 90_000,
          source_run_id: 'effective-run',
          source_run_item_id: 'effective-item',
          source_phase: 'SCORING_JUDGE',
          source_model_id: 'effective-model',
          request_id: 'effective-request',
          last_error_message: 'effective longest-gate error',
          hit_count: 2,
          activated_at: new Date('2026-07-27T23:58:30.000Z'),
          resumed_at: null,
          updated_at: new Date('2026-07-27T23:59:00.000Z'),
        }],
      };
    }
    return { rows: [] };
  });
  const client = {
    query,
  } as unknown as Parameters<typeof registerBenchmarkProviderRateLimitWithClient>[0];
  const observedError = new ProviderError({
    kind: 'RATE_LIMIT',
    message: 'latest shorter-hit error',
    retryable: true,
    retryAfterMs: 1_000,
    rateLimitDimension: 'RPM',
    rateLimitScope: 'minute-quota',
    requestId: 'observed-request',
  });

  await registerBenchmarkProviderRateLimitWithClient(client, {
    providerKey: 'gemini',
    error: observedError,
    sourceRunId: 'observed-run',
    sourceRunItemId: 'observed-item',
    sourcePhase: 'MODEL_RESPONSE',
    sourceModelId: 'observed-model',
  });

  const upsertSql = query.mock.calls[0]?.[0] ?? '';
  expect(upsertSql.replace(/\s+/g, ' ')).toContain(
    'last_error_message=case when excluded.blocked_until>=benchmark_provider_cooldowns.blocked_until then excluded.last_error_message else benchmark_provider_cooldowns.last_error_message end',
  );

  const rateLimitedEventCall = query.mock.calls.find(
    ([sql]) => sql.includes("select 'benchmark_run',affected.id"),
  );
  const payload = JSON.parse(
    String(rateLimitedEventCall?.[1]?.[3]),
  ) as Record<string, unknown>;
  expect(payload).toMatchObject({
    rateLimitDimension: 'RPD',
    rateLimitScope: 'daily-quota',
    retryAfterMs: 90_000,
    requestId: 'effective-request',
    lastErrorMessage: 'effective longest-gate error',
    observedRunId: 'observed-run',
    observedRunItemId: 'observed-item',
    observedSourcePhase: 'MODEL_RESPONSE',
    observedSourceModelId: 'observed-model',
    observedRateLimitDimension: 'RPM',
    observedRateLimitScope: 'minute-quota',
    observedRetryAfterMs: 1_000,
    observedRequestId: 'observed-request',
    observedErrorMessage: 'latest shorter-hit error',
  });
});

test('records question-generation rate limits without requiring a benchmark run context', async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('returning *')) {
      return {
        rows:[{
          provider_key:'gemini', blocked_until:new Date('2026-07-28T00:01:00.000Z'),
          rate_limit_dimension:'RPM', rate_limit_scope:null, retry_after_ms:60_000,
          source_run_id:null, source_run_item_id:null, source_phase:'QUESTION_GENERATION',
          source_model_id:'gemini-3.5-flash', request_id:'generation-rate-limit',
          last_error_message:'rate limited', hit_count:1,
          activated_at:new Date('2026-07-28T00:00:00.000Z'), resumed_at:null,
          updated_at:new Date('2026-07-28T00:00:00.000Z'),
        }],
      };
    }
    return { rows:[] };
  });
  const client = { query } as unknown as Parameters<typeof registerBenchmarkProviderRateLimitWithClient>[0];

  await registerBenchmarkProviderRateLimitWithClient(client, {
    providerKey:'gemini',
    error:new ProviderError({ kind:'RATE_LIMIT', message:'rate limited', retryable:true, retryAfterMs:60_000 }),
    sourceRunId:null,
    sourcePhase:'QUESTION_GENERATION',
    sourceModelId:'gemini-3.5-flash',
  });

  expect(query.mock.calls.some(([sql]) => sql.includes("values('benchmark_run'"))).toBe(false);
});
