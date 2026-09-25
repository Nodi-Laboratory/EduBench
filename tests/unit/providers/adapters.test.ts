import { describe, expect, test, vi } from 'vitest';
import { GeminiProvider } from '@/server/providers/gemini';
import { AnthropicProvider } from '@/server/providers/anthropic';
import { OpenAIProvider } from '@/server/providers/openai';
import { OpenAICompatibleProvider } from '@/server/providers/openai-compatible';
import type { FetchLike, GenerationRequest } from '@/server/providers/types';
import { createProviderForModel, createProviderRegistry } from '@/server/providers/registry';

const request: GenerationRequest = {
  system: '교과서 근거만 사용한다.',
  prompt: '원자의 뜻을 설명하라.',
  maxOutputTokens: 300,
  temperature: 0,
};

function fixtureFetch(body: unknown, headers: Record<string, string> = {}): FetchLike {
  return async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('provider response normalization', () => {
  test('normalizes Gemini generateContent', async () => {
    const provider = new GeminiProvider({ apiKey: 'secret', modelId: 'gemini-test', fetch: fixtureFetch({
      candidates: [{ content: { parts: [{ text: '원자는 기본 입자이다.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 9 },
    }, { 'x-request-id': 'gem-req' }) });
    await expect(provider.generate(request)).resolves.toMatchObject({
      text: '원자는 기본 입자이다.', inputTokens: 17, outputTokens: 9,
      finishReason: 'STOP', requestId: 'gem-req', modelId: 'gemini-test',
    });
  });

  test('normalizes Anthropic Messages', async () => {
    const provider = new AnthropicProvider({ apiKey: 'secret', modelId: 'claude-test', fetch: fixtureFetch({
      id: 'msg_1', model: 'claude-snapshot', content: [{ type: 'text', text: '원자는 기본 입자이다.' }],
      stop_reason: 'end_turn', usage: { input_tokens: 15, output_tokens: 8 },
    }, { 'request-id': 'ant-req' }) });
    await expect(provider.generate(request)).resolves.toMatchObject({
      text: '원자는 기본 입자이다.', inputTokens: 15, outputTokens: 8,
      finishReason: 'end_turn', requestId: 'ant-req', modelId: 'claude-snapshot',
    });
  });

  test('normalizes OpenAI Responses', async () => {
    const provider = new OpenAIProvider({ apiKey: 'secret', modelId: 'openai-test', fetch: fixtureFetch({
      id: 'resp_1', model: 'openai-snapshot',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '원자는 기본 입자이다.' }] }],
      status: 'completed', usage: { input_tokens: 14, output_tokens: 7 },
    }, { 'x-request-id': 'oai-req' }) });
    await expect(provider.generate(request)).resolves.toMatchObject({
      text: '원자는 기본 입자이다.', inputTokens: 14, outputTokens: 7,
      finishReason: 'completed', requestId: 'oai-req', modelId: 'openai-snapshot',
    });
  });

  test('rejects a Gemini safety-blocked response as content filtering', async () => {
    const provider = new GeminiProvider({
      apiKey:'secret',
      modelId:'gemini-test',
      fetch:fixtureFetch({
        promptFeedback:{ blockReason:'SAFETY' },
        usageMetadata:{ promptTokenCount:17 },
      }, { 'x-request-id':'gem-blocked' }),
    });
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind:'CONTENT_FILTER',
      retryable:false,
      status:200,
      requestId:'gem-blocked',
    });
  });

  test('classifies a Gemini MAX_TOKENS response as retryable', async () => {
    const provider = new GeminiProvider({
      apiKey:'secret',
      modelId:'gemini-test',
      fetch:fixtureFetch({
        candidates:[{ content:{ parts:[] }, finishReason:'MAX_TOKENS' }],
        usageMetadata:{ promptTokenCount:17, candidatesTokenCount:300 },
      }, { 'x-request-id':'gem-empty' }),
    });
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind:'PARSE',
      retryable:true,
      status:200,
      requestId:'gem-empty',
    });
  });

  test('rejects nonblank Gemini output without a completed finish reason', async () => {
    const provider = new GeminiProvider({
      apiKey:'secret',
      modelId:'gemini-test',
      fetch:fixtureFetch({
        candidates:[{ content:{ parts:[{ text:'아직 생성 중인 답변' }] } }],
      }, { 'x-request-id':'gem-unfinished' }),
    });
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind:'PARSE',
      retryable:false,
      status:200,
      requestId:'gem-unfinished',
    });
  });

  test('rejects an incomplete OpenAI response instead of storing an empty successful answer', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'secret',
      modelId: 'openai-test',
      fetch: fixtureFetch({
        id: 'resp_incomplete',
        model: 'openai-snapshot',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', content: [] }],
        usage: { input_tokens: 14, output_tokens: 300 },
      }, { 'x-request-id': 'oai-incomplete' }),
    });

    await expect(provider.generate(request)).rejects.toMatchObject({
      kind: 'PARSE',
      retryable: false,
      status: 200,
      requestId: 'oai-incomplete',
    });
  });

  test('rejects a completed OpenAI response without output text', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'secret',
      modelId: 'openai-test',
      fetch: fixtureFetch({
        id: 'resp_empty',
        model: 'openai-snapshot',
        status: 'completed',
        output: [{ type: 'message', content: [] }],
      }),
    });

    await expect(provider.generate(request)).rejects.toMatchObject({
      kind: 'PARSE',
      retryable: false,
      status: 200,
      requestId: 'resp_empty',
    });
  });

  test('normalizes OpenAI-compatible chat completions', async () => {
    const provider = new OpenAICompatibleProvider({ providerKey: 'upstage', apiKey: 'secret', baseUrl: 'https://example.test/v1', modelId: 'solar-test', fetch: fixtureFetch({
      id: 'chat_1', model: 'solar-snapshot', choices: [{ message: { content: '원자는 기본 입자이다.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 13, completion_tokens: 6 },
    }, { 'x-request-id': 'compat-req' }) });
    await expect(provider.generate(request)).resolves.toMatchObject({
      text: '원자는 기본 입자이다.', inputTokens: 13, outputTokens: 6,
      finishReason: 'stop', requestId: 'compat-req', modelId: 'solar-snapshot',
    });
  });
});

test('sends Gemini structured-output and thinking configuration', async () => {
  let sent: { generationConfig?: Record<string, unknown> } = {};
  const provider = new GeminiProvider({
    apiKey: 'secret', modelId: 'gemini-test',
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason:'STOP' }] }), { status: 200 });
    },
  });
  await provider.generate({ ...request, responseMimeType: 'application/json', responseJsonSchema: { type: 'object' }, thinkingLevel: 'LOW' });
  expect(sent.generationConfig).toMatchObject({
    responseMimeType: 'application/json', responseJsonSchema: { type: 'object' },
    thinkingConfig: { thinkingLevel: 'LOW' },
  });
});

test('maps optional Gemini sampling parameters while omitted sampling values stay absent', async () => {
  let sent: { generationConfig?: Record<string, unknown> } = {};
  const provider = new GeminiProvider({
    apiKey: 'secret', modelId: 'gemini-test',
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason:'STOP' }] }), { status: 200 });
    },
  });

  await provider.generate({
    ...request,
    temperature: undefined,
    stopSequences: ['<END>'],
    thinkingLevel: 'HIGH',
    topP: undefined,
    presencePenalty: 0.25,
    frequencyPenalty: -0.5,
    seed: 17,
  });

  expect(sent.generationConfig).toEqual({
    maxOutputTokens: 300,
    stopSequences: ['<END>'],
    presencePenalty: 0.25,
    frequencyPenalty: -0.5,
    seed: 17,
    thinkingConfig: { thinkingLevel: 'HIGH' },
  });
});

test('maps persisted OpenAI-compatible sampling fields including EXAONE thinking', async () => {
  let sent: Record<string, unknown> = {};
  const provider = new OpenAICompatibleProvider({
    providerKey: 'exaone',
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
    modelId: 'exaone-test',
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200 });
    },
  });

  await provider.generate({
    ...request,
    maxOutputTokens: 16_384,
    temperature: 1,
    stopSequences: ['<END>'],
    topP: 0.95,
    presencePenalty: 0.1,
    frequencyPenalty: -0.2,
    seed: 23,
    enableThinking: true,
  });

  expect(sent).toMatchObject({
    model: 'exaone-test',
    max_tokens: 16_384,
    temperature: 1,
    stop: ['<END>'],
    top_p: 0.95,
    presence_penalty: 0.1,
    frequency_penalty: -0.2,
    seed: 23,
    chat_template_kwargs: {
      enable_thinking: true,
    },
  });
});

test('normalizes a provider error without exposing the API key', async () => {
  const provider = new OpenAIProvider({
    apiKey: 'top-secret-key', modelId: 'openai-test',
    fetch: async () => new Response(JSON.stringify({ error: { message: 'invalid key top-secret-key' } }), { status: 401 }),
  });
  await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'AUTH', retryable: false, status: 401 });
  await expect(provider.generate(request)).rejects.not.toHaveProperty('message', expect.stringContaining('top-secret-key'));
});

test('registers all six providers from environment configuration', () => {
  const registry = createProviderRegistry({
    GOOGLE_API_KEY: 'g', GEMINI_GENERATION_MODEL: 'gemini-model',
    ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-model',
    OPENAI_API_KEY: 'o', OPENAI_MODEL: 'openai-model',
    UPSTAGE_API_KEY: 'u', UPSTAGE_MODEL: 'solar-model', UPSTAGE_BASE_URL: 'https://upstage.test/v1',
    EXAONE_API_KEY: 'e', EXAONE_MODEL: 'exaone-model', EXAONE_BASE_URL: 'https://exaone.test/v1',
    MIDM_API_KEY: 'm', MIDM_MODEL: 'midm-model', MIDM_BASE_URL: 'https://midm.test/v1',
  });
  expect([...registry.keys()]).toEqual(['gemini', 'claude', 'openai', 'upstage', 'exaone', 'midm']);
});

test('uses normalized provider base URL overrides from environment configuration', async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    const body = url.includes('/responses')
      ? {
        status:'completed',
        output:[{ type:'message', content:[{ type:'output_text', text:'ok' }] }],
      }
      : url.includes('/messages')
        ? { content:[{ type:'text', text:'ok' }] }
        : url.includes('/chat/completions')
          ? { choices:[{ message:{ content:'ok' }, finish_reason:'stop' }] }
          : { candidates:[{ content:{ parts:[{ text:'ok' }] }, finishReason:'STOP' }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const registry = createProviderRegistry({
      GOOGLE_API_KEY: 'g', GEMINI_GENERATION_MODEL: 'gemini-model', GEMINI_BASE_URL: 'https://gemini.test/',
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-model', ANTHROPIC_BASE_URL: 'https://anthropic.test/v1/',
      OPENAI_API_KEY: 'o', OPENAI_MODEL: 'openai-model', OPENAI_BASE_URL: 'https://openai.test/v1/',
      UPSTAGE_API_KEY: 'u', UPSTAGE_MODEL: 'solar-model', UPSTAGE_BASE_URL: 'https://upstage.test/v1/',
    });
    for (const provider of registry.values()) await provider.generate(request);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(requestedUrls).toEqual([
    'https://gemini.test/v1beta/models/gemini-model:generateContent?key=g',
    'https://anthropic.test/v1/messages',
    'https://openai.test/v1/responses',
    'https://upstage.test/v1/chat/completions',
  ]);
});

test('registers only fully configured providers and supports explicit mock mode', () => {
  expect([...createProviderRegistry({ OPENAI_API_KEY: 'o', OPENAI_MODEL: 'openai-model' }).keys()]).toEqual(['openai']);
  const mocked = createProviderRegistry({ MOCK_PROVIDERS: 'true' });
  expect([...mocked.keys()]).toEqual(['gemini', 'claude', 'openai', 'upstage', 'exaone', 'midm']);
  expect(mocked.get('gemini')?.modelId).toBe('mock-gemini');
});

test('constructs a provider with the exact requested model instead of the environment default', () => {
  const env = {
    GOOGLE_API_KEY: 'g',
    GEMINI_GENERATION_MODEL: 'environment-default',
    MOCK_PROVIDERS: 'false',
  };
  expect(createProviderForModel('gemini', 'judge-exact-v7', env)?.modelId).toBe('judge-exact-v7');
  expect(createProviderForModel('gemini', 'judge-exact-v7', { MOCK_PROVIDERS:'true' })?.modelId).toBe('judge-exact-v7');
});

test('resolves and caches run providers by the exact persisted provider and model pair', async () => {
  const registryModule = await import('@/server/providers/registry') as typeof import('@/server/providers/registry') & {
    createRunProviderResolver?: (
      env: Record<string, string | undefined>,
    ) => (providerKey: string, modelId: string) => import('@/server/providers/types').ModelProvider | undefined;
  };
  const createResolver = registryModule.createRunProviderResolver;

  expect(createResolver).toEqual(expect.any(Function));
  if (!createResolver) return;

  const resolve = createResolver({
    MOCK_PROVIDERS: 'true',
    GEMINI_GENERATION_MODEL: 'environment-model-a',
  });
  const persistedModelB = resolve('gemini', 'persisted-model-b');

  expect(persistedModelB?.modelId).toBe('persisted-model-b');
  expect(resolve('gemini', 'persisted-model-b')).toBe(persistedModelB);
  expect(resolve('gemini', 'environment-model-a')).not.toBe(persistedModelB);
});
