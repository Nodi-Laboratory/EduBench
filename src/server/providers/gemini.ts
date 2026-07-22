import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import type { FetchLike, GenerationRequest, ModelProvider, NormalizedGeneration } from './types';

type GeminiResponse = {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

export class GeminiProvider implements ModelProvider {
  readonly key = 'gemini';
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; modelId: string; fetch?: FetchLike; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
    this.fetcher = config.fetch ?? fetch;
    this.baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  }

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<NormalizedGeneration> {
    const started = performance.now();
    const response = await executeFetch(() => this.fetcher(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
            stopSequences: request.stopSequences,
            responseMimeType: request.responseMimeType,
            responseJsonSchema: request.responseJsonSchema,
            thinkingConfig: request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : undefined,
          },
        }),
      },
    ));
    await assertProviderResponse(response, this.apiKey);
    const raw = await response.json() as GeminiResponse;
    const candidate = raw.candidates?.[0];
    return {
      text: candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
      raw,
      inputTokens: raw.usageMetadata?.promptTokenCount ?? null,
      outputTokens: raw.usageMetadata?.candidatesTokenCount ?? null,
      finishReason: candidate?.finishReason ?? null,
      requestId: requestIdFrom(response),
      modelId: this.modelId,
      modelSnapshot: raw.modelVersion ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

