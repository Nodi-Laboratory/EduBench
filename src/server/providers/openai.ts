import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import type { FetchLike, GenerationRequest, ModelProvider, NormalizedGeneration } from './types';

type OpenAIResponse = {
  id?: string;
  model?: string;
  status?: string;
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
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
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
    const text = raw.output?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text').map((item) => item.text ?? '').join('') ?? '';
    return {
      text, raw,
      inputTokens: raw.usage?.input_tokens ?? null,
      outputTokens: raw.usage?.output_tokens ?? null,
      finishReason: raw.status ?? null,
      requestId: requestIdFrom(response) ?? raw.id ?? null,
      modelId: raw.model ?? this.modelId,
      modelSnapshot: raw.model ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

