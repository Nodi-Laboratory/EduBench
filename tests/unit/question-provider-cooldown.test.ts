import { expect, test, vi } from 'vitest';
import {
  callGenerationEmbeddingWithCooldown,
  callGenerationProviderWithCooldown,
  GenerationProviderRateLimitError,
} from '@/server/questions/generator';
import { ActiveBenchmarkProviderCooldownError } from '@/server/runs/provider-cooldown';
import { ProviderError, type ModelProvider } from '@/server/providers/types';

test('stops later generation provider calls after the first 429 registers a global cooldown', async () => {
  const cooldown = {
    providerKey:'gemini',
    blockedUntil:new Date('2026-07-28T01:00:00.000Z'),
    rateLimitDimension:'RPM' as const,
    rateLimitScope:null,
    retryAfterMs:60_000,
    sourceRunId:null,
    sourceRunItemId:null,
    sourcePhase:'QUESTION_GENERATION' as const,
    sourceModelId:'gemini-3.5-flash',
    requestId:'generation-429',
    lastErrorMessage:'rate limited',
    hitCount:1,
    activatedAt:new Date('2026-07-28T00:00:00.000Z'),
    resumedAt:null,
    updatedAt:new Date('2026-07-28T00:00:00.000Z'),
  };
  const provider = {
    key:'gemini',
    modelId:'gemini-3.5-flash',
    generate:vi.fn(async () => {
      throw new ProviderError({
        kind:'RATE_LIMIT', message:'Gemini 429', retryable:true, retryAfterMs:60_000,
      });
    }),
  } satisfies ModelProvider;
  const findActive = vi.fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(cooldown);
  const registerRateLimit = vi.fn().mockResolvedValue(cooldown);
  const input = {
    provider,
    request:{ system:'system', prompt:'prompt', maxOutputTokens:1024 },
    signal:new AbortController().signal,
  };
  const dependencies = { findActive, registerRateLimit };

  await expect(callGenerationProviderWithCooldown(input, dependencies))
    .rejects.toBeInstanceOf(GenerationProviderRateLimitError);
  await expect(callGenerationProviderWithCooldown(input, dependencies))
    .rejects.toBeInstanceOf(ActiveBenchmarkProviderCooldownError);

  expect(registerRateLimit).toHaveBeenCalledOnce();
  expect(provider.generate).toHaveBeenCalledOnce();
});

test('registers an embedding 429 once and leaves non-provider embedding errors unchanged', async () => {
  const cooldown = {
    providerKey:'gemini', blockedUntil:new Date('2026-07-28T01:00:00.000Z'),
    rateLimitDimension:'RPM' as const, rateLimitScope:null, retryAfterMs:60_000,
    sourceRunId:null, sourceRunItemId:null, sourcePhase:'QUESTION_GENERATION' as const,
    sourceModelId:'gemini-embedding-2', requestId:'embedding-429', lastErrorMessage:'rate limited',
    hitCount:1, activatedAt:new Date(), resumedAt:null, updatedAt:new Date(),
  };
  const registerRateLimit = vi.fn().mockResolvedValue(cooldown);
  const rateLimitedEmbed = vi.fn(async () => {
    throw new ProviderError({ kind:'RATE_LIMIT', message:'Gemini embedding 429', retryable:true });
  });

  await expect(callGenerationEmbeddingWithCooldown({
    modelId:'gemini-embedding-2',
    embed:rateLimitedEmbed,
  }, {
    findActive:vi.fn().mockResolvedValue(null),
    registerRateLimit,
  })).rejects.toMatchObject({ cooldown });
  expect(registerRateLimit).toHaveBeenCalledOnce();

  const blockedEmbed = vi.fn();
  await expect(callGenerationEmbeddingWithCooldown({
    modelId:'gemini-embedding-2',
    embed:blockedEmbed,
  }, {
    findActive:vi.fn().mockResolvedValue(cooldown),
    registerRateLimit,
  })).rejects.toBeInstanceOf(ActiveBenchmarkProviderCooldownError);
  expect(blockedEmbed).not.toHaveBeenCalled();

  const nonProviderError = new Error('test embedding failure');
  await expect(callGenerationEmbeddingWithCooldown({
    modelId:'gemini-embedding-2',
    embed:vi.fn(async () => { throw nonProviderError; }),
  }, {
    findActive:vi.fn().mockResolvedValue(null),
    registerRateLimit,
  })).rejects.toBe(nonProviderError);
  expect(registerRateLimit).toHaveBeenCalledOnce();
});
