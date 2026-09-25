import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import {
  ProviderError,
  type FetchLike,
  type GenerationRequest,
  type ModelProvider,
  type NormalizedGeneration,
} from './types';

type OpenAIResponse = {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class OpenAIProvider implements ModelProvider {
  readonly key = 'openai';
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; modelId: string; fetch?: FetchLike; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
    this.fetcher = config.fetch ?? fetch;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<NormalizedGeneration> {
    const started = performance.now();
    const response = await executeFetch(() => this.fetcher(`${this.baseUrl}/responses`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.modelId, instructions: request.system, input: request.prompt,
        max_output_tokens: request.maxOutputTokens, temperature: request.temperature,
      }),
    }));
    await assertProviderResponse(response, this.apiKey);
    const raw = await response.json() as OpenAIResponse;
    const requestId = requestIdFrom(response) ?? raw.id ?? null;
    const text = raw.output?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text').map((item) => item.text ?? '').join('') ?? '';
    if (raw.status && raw.status !== 'completed') {
      const reason = raw.incomplete_details?.reason ?? raw.status;
      throw new ProviderError({
        kind:'PARSE',
        message:`OPENAI_INCOMPLETE_RESPONSE: OpenAI 응답이 완료되지 않았습니다. status=${raw.status}, reason=${reason}`,
        retryable:false,
        status:response.status,
        requestId,
      });
    }
    if (!text.trim()) {
      throw new ProviderError({
        kind:'PARSE',
        message:'OPENAI_EMPTY_RESPONSE: OpenAI 응답에 저장 가능한 output_text가 없습니다.',
        retryable:false,
        status:response.status,
        requestId,
      });
    }
    return {
      text, raw,
      inputTokens: raw.usage?.input_tokens ?? null,
      outputTokens: raw.usage?.output_tokens ?? null,
      finishReason: raw.status ?? null,
      requestId,
      modelId: raw.model ?? this.modelId,
      modelSnapshot: raw.model ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

