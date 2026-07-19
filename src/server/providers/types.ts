export type FetchLike = typeof fetch;

export type GenerationRequest = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
  stopSequences?: string[];
};

export type NormalizedGeneration = {
  text: string;
  raw: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  requestId: string | null;
  modelId: string;
  modelSnapshot: string | null;
  latencyMs: number;
};

export interface ModelProvider {
  readonly key: string;
  readonly modelId: string;
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<NormalizedGeneration>;
}

export type ProviderErrorKind =
  | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK' | 'INVALID_REQUEST'
  | 'CONTENT_FILTER' | 'PROVIDER_5XX' | 'PARSE' | 'UNKNOWN';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(input: {
    kind: ProviderErrorKind;
    message: string;
    retryable: boolean;
    status?: number | null;
    requestId?: string | null;
    retryAfterMs?: number | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ProviderError';
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.status = input.status ?? null;
    this.requestId = input.requestId ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

