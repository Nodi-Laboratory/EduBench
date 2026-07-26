import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai-compatible';
import { OpenAIProvider } from './openai';
import type { ModelProvider } from './types';
import { MockProvider } from './mock';

type Env = Record<string, string | undefined>;
export const supportedProviderKeys = ['gemini', 'claude', 'openai', 'upstage', 'exaone', 'midm'] as const;
export type ProviderKey = (typeof supportedProviderKeys)[number];

export function isSupportedProviderKey(value: string): value is ProviderKey {
  return supportedProviderKeys.includes(value as ProviderKey);
}

export function createProviderForModel(
  providerKey: string,
  modelId: string,
  env: Env = process.env,
): ModelProvider | undefined {
  if (!isSupportedProviderKey(providerKey) || !modelId.trim()) return undefined;
  if (env.MOCK_PROVIDERS?.toLowerCase() === 'true') {
    return new MockProvider(providerKey, modelId);
  }
  if (providerKey === 'gemini' && env.GOOGLE_API_KEY)
    return new GeminiProvider({ apiKey:env.GOOGLE_API_KEY, modelId, baseUrl:env.GEMINI_BASE_URL });
  if (providerKey === 'claude' && env.ANTHROPIC_API_KEY)
    return new AnthropicProvider({ apiKey:env.ANTHROPIC_API_KEY, modelId, baseUrl:env.ANTHROPIC_BASE_URL });
  if (providerKey === 'openai' && env.OPENAI_API_KEY)
    return new OpenAIProvider({ apiKey:env.OPENAI_API_KEY, modelId, baseUrl:env.OPENAI_BASE_URL });
  if (providerKey === 'upstage' && env.UPSTAGE_API_KEY)
    return new OpenAICompatibleProvider({ providerKey, apiKey:env.UPSTAGE_API_KEY, modelId, baseUrl:env.UPSTAGE_BASE_URL ?? 'https://api.upstage.ai/v1' });
  if (providerKey === 'exaone' && env.EXAONE_API_KEY && env.EXAONE_BASE_URL)
    return new OpenAICompatibleProvider({ providerKey, apiKey:env.EXAONE_API_KEY, modelId, baseUrl:env.EXAONE_BASE_URL });
  if (providerKey === 'midm' && env.MIDM_API_KEY && env.MIDM_BASE_URL)
    return new OpenAICompatibleProvider({ providerKey, apiKey:env.MIDM_API_KEY, modelId, baseUrl:env.MIDM_BASE_URL });
  return undefined;
}

export function createRunProviderResolver(
  env: Env = process.env,
): (providerKey: string, modelId: string) => ModelProvider | undefined {
  const providers = new Map<string, ModelProvider>();
  return (providerKey, modelId) => {
    const cacheKey = JSON.stringify([providerKey, modelId]);
    const cached = providers.get(cacheKey);
    if (cached) return cached;
    const provider = createProviderForModel(providerKey, modelId, env);
    if (provider) providers.set(cacheKey, provider);
    return provider;
  };
}

export function createProviderRegistry(
  env: Env = process.env,
  modelOverrides: Partial<Record<ProviderKey, string>> = {},
): Map<string, ModelProvider> {
  const configuredModels: Record<ProviderKey, string | undefined> = {
    gemini:env.GEMINI_GENERATION_MODEL,
    claude:env.ANTHROPIC_MODEL,
    openai:env.OPENAI_MODEL,
    upstage:env.UPSTAGE_MODEL,
    exaone:env.EXAONE_MODEL,
    midm:env.MIDM_MODEL,
  };
  const providers = new Map<string, ModelProvider>();
  for (const key of supportedProviderKeys) {
    const modelId = modelOverrides[key] ?? configuredModels[key]
      ?? (env.MOCK_PROVIDERS?.toLowerCase() === 'true' ? `mock-${key}` : undefined);
    if (!modelId) continue;
    const provider = createProviderForModel(key, modelId, env);
    if (provider) providers.set(key, provider);
  }
  return providers;
}
