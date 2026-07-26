import { z } from 'zod';

export type FetchLike = typeof fetch;

export const generationParametersSchema = z.object({
  maxOutputTokens: z.number().int().min(1).max(131_072).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  stopSequences: z.array(z.string().min(1).max(200)).max(16).optional(),
  thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  presencePenalty: z.number().finite().min(-2).max(2).optional(),
  frequencyPenalty: z.number().finite().min(-2).max(2).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  enableThinking: z.boolean().optional(),
  omitTemperature: z.boolean().optional(),
  omitTopP: z.boolean().optional(),
}).strict();

export type GenerationParameters = z.infer<typeof generationParametersSchema>;

export type GenerationRequest = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature?: number;
  stopSequences?: string[];
  responseMimeType?: 'application/json';
  responseJsonSchema?: Record<string, unknown>;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  enableThinking?: boolean;
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

