import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai-compatible';
import { OpenAIProvider } from './openai';
import type { ModelProvider } from './types';
import { MockProvider } from './mock';

type Env = Record<string, string | undefined>;

export function createProviderRegistry(env: Env = process.env): Map<string, ModelProvider> {
  const keys = ['gemini', 'claude', 'openai', 'upstage', 'exaone', 'midm'] as const;
  if (env.MOCK_PROVIDERS?.toLowerCase() === 'true') {
    return new Map(keys.map((key) => [key, new MockProvider(key)]));
  }
  const providers = new Map<string, ModelProvider>();
  if (env.GOOGLE_API_KEY && env.GEMINI_GENERATION_MODEL) providers.set('gemini', new GeminiProvider({ apiKey: env.GOOGLE_API_KEY, modelId: env.GEMINI_GENERATION_MODEL, baseUrl: env.GEMINI_BASE_URL }));
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL) providers.set('claude', new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, modelId: env.ANTHROPIC_MODEL, baseUrl: env.ANTHROPIC_BASE_URL }));
  if (env.OPENAI_API_KEY && env.OPENAI_MODEL) providers.set('openai', new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, modelId: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL }));
  if (env.UPSTAGE_API_KEY && env.UPSTAGE_MODEL) providers.set('upstage', new OpenAICompatibleProvider({ providerKey: 'upstage', apiKey: env.UPSTAGE_API_KEY, modelId: env.UPSTAGE_MODEL, baseUrl: env.UPSTAGE_BASE_URL ?? 'https://api.upstage.ai/v1' }));
  if (env.EXAONE_API_KEY && env.EXAONE_MODEL && env.EXAONE_BASE_URL) providers.set('exaone', new OpenAICompatibleProvider({ providerKey: 'exaone', apiKey: env.EXAONE_API_KEY, modelId: env.EXAONE_MODEL, baseUrl: env.EXAONE_BASE_URL }));
  if (env.MIDM_API_KEY && env.MIDM_MODEL && env.MIDM_BASE_URL) providers.set('midm', new OpenAICompatibleProvider({ providerKey: 'midm', apiKey: env.MIDM_API_KEY, modelId: env.MIDM_MODEL, baseUrl: env.MIDM_BASE_URL }));
  return providers;
}
