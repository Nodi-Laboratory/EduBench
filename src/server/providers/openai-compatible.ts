import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import type { FetchLike, GenerationRequest, ModelProvider, NormalizedGeneration } from './types';

type ChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly key: string;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(config: { providerKey: string; apiKey: string; baseUrl: string; modelId: string; fetch?: FetchLike }) {
    this.key = config.providerKey;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.modelId;
    this.fetcher = config.fetch ?? fetch;
  }

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<NormalizedGeneration> {
    const started = performance.now();
    const response = await executeFetch(() => this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.modelId,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
        max_tokens: request.maxOutputTokens, temperature: request.temperature,
        stop: request.stopSequences,
      }),
    }));
    await assertProviderResponse(response, this.apiKey);
    const raw = await response.json() as ChatResponse;
    const choice = raw.choices?.[0];
    return {
      text: choice?.message?.content ?? '', raw,
      inputTokens: raw.usage?.prompt_tokens ?? null,
      outputTokens: raw.usage?.completion_tokens ?? null,
      finishReason: choice?.finish_reason ?? null,
      requestId: requestIdFrom(response) ?? raw.id ?? null,
      modelId: raw.model ?? this.modelId,
      modelSnapshot: raw.model ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

