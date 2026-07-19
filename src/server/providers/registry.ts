import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai-compatible';
import { OpenAIProvider } from './openai';
import type { ModelProvider } from './types';

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`필수 환경변수 ${key}가 설정되지 않았습니다.`);
  return value;
}

export function createProviderRegistry(env: Env = process.env): Map<string, ModelProvider> {
  return new Map<string, ModelProvider>([
    ['gemini', new GeminiProvider({ apiKey: required(env, 'GOOGLE_API_KEY'), modelId: required(env, 'GEMINI_GENERATION_MODEL') })],
    ['claude', new AnthropicProvider({ apiKey: required(env, 'ANTHROPIC_API_KEY'), modelId: required(env, 'ANTHROPIC_MODEL') })],
    ['openai', new OpenAIProvider({ apiKey: required(env, 'OPENAI_API_KEY'), modelId: required(env, 'OPENAI_MODEL') })],
    ['upstage', new OpenAICompatibleProvider({ providerKey: 'upstage', apiKey: required(env, 'UPSTAGE_API_KEY'), modelId: required(env, 'UPSTAGE_MODEL'), baseUrl: env.UPSTAGE_BASE_URL ?? 'https://api.upstage.ai/v1' })],
    ['exaone', new OpenAICompatibleProvider({ providerKey: 'exaone', apiKey: required(env, 'EXAONE_API_KEY'), modelId: required(env, 'EXAONE_MODEL'), baseUrl: required(env, 'EXAONE_BASE_URL') })],
    ['midm', new OpenAICompatibleProvider({ providerKey: 'midm', apiKey: required(env, 'MIDM_API_KEY'), modelId: required(env, 'MIDM_MODEL'), baseUrl: required(env, 'MIDM_BASE_URL') })],
  ]);
}
