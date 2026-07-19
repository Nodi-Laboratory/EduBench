import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import type { FetchLike, GenerationRequest, ModelProvider, NormalizedGeneration } from './types';

type AnthropicResponse = {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class AnthropicProvider implements ModelProvider {
  readonly key = 'claude';
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; modelId: string; fetch?: FetchLike; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
    this.fetcher = config.fetch ?? fetch;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<NormalizedGeneration> {
    const started = performance.now();
    const response = await executeFetch(() => this.fetcher(`${this.baseUrl}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.modelId, system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: request.maxOutputTokens, temperature: request.temperature,
        stop_sequences: request.stopSequences,
      }),
    }));
    await assertProviderResponse(response, this.apiKey);
    const raw = await response.json() as AnthropicResponse;
    return {
      text: raw.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') ?? '',
      raw,
      inputTokens: raw.usage?.input_tokens ?? null,
      outputTokens: raw.usage?.output_tokens ?? null,
      finishReason: raw.stop_reason ?? null,
      requestId: requestIdFrom(response) ?? raw.id ?? null,
      modelId: raw.model ?? this.modelId,
      modelSnapshot: raw.model ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

