import { assertProviderResponse, executeFetch, requestIdFrom } from './http';
import {
  ProviderError,
  type FetchLike,
  type GenerationRequest,
  type ModelProvider,
  type NormalizedGeneration,
} from './types';

type GeminiResponse = {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?:string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

const blockedFinishReasons = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

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
            topP: request.topP,
            presencePenalty: request.presencePenalty,
            frequencyPenalty: request.frequencyPenalty,
            seed: request.seed,
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
    const text = candidate?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('') ?? '';
    const finishReason = candidate?.finishReason ?? null;
    const requestId = requestIdFrom(response);
    const blockReason = raw.promptFeedback?.blockReason;
    if (
      blockReason
      || (finishReason && blockedFinishReasons.has(finishReason))
    ) {
      throw new ProviderError({
        kind:'CONTENT_FILTER',
        message:`CONTENT_FILTER: Gemini 응답이 차단되었습니다. reason=${blockReason ?? finishReason}`,
        retryable:false,
        status:response.status,
        requestId,
      });
    }
    if (
      !text.trim()
      || finishReason !== 'STOP'
    ) {
      throw new ProviderError({
        kind:'PARSE',
        message:`PARSE: Gemini 응답이 완료되지 않았거나 답변 텍스트가 없습니다. finishReason=${finishReason ?? 'UNKNOWN'}`,
        retryable:finishReason === 'MAX_TOKENS',
        status:response.status,
        requestId,
      });
    }
    return {
      text,
      raw,
      inputTokens: raw.usageMetadata?.promptTokenCount ?? null,
      outputTokens: raw.usageMetadata?.candidatesTokenCount ?? null,
      finishReason,
      requestId,
      modelId: this.modelId,
      modelSnapshot: raw.modelVersion ?? null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

