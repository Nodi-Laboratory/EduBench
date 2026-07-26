import { DomainError } from '@/domain/errors';
import { ProviderError } from '@/server/providers/types';

const NON_RETRYABLE_CODES = new Set([
  'GENERATION_BATCH_NOT_FOUND',
  'GENERATION_SOURCE_SCOPE_INVALID',
  'GENERATION_TOC_SCOPE_EMPTY',
  'GENERATION_EVIDENCE_EMPTY',
  'GENERATION_EVIDENCE_SCOPE_VIOLATION',
  'GENERATION_EMBEDDING_NOT_CONFIGURED',
  'GENERATION_PROVIDER_NOT_CONFIGURED',
  'DIRECTION_PARSE_FAILED',
  'GENERATION_PARSE_FAILED',
  'GENERATION_FORMAT_MISMATCH',
]);

const RETRYABLE_CODES = new Set([
  'DIRECTION_INCOMPLETE_RESPONSE',
  'GENERATION_INCOMPLETE_RESPONSE',
  'GENERATION_ITEMS_UNAVAILABLE',
  'GENERATION_ITEMS_INCOMPLETE',
  'RATE_LIMIT',
  'TIMEOUT',
  'NETWORK',
  'PROVIDER_5XX',
]);

export type GenerationFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export class GenerationItemsIncompleteError extends DomainError {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, details?: Record<string, unknown>) {
    super('GENERATION_ITEMS_INCOMPLETE', message, details);
    this.retryable = retryable;
  }
}

export function classifyGenerationFailure(error: unknown): GenerationFailure {
  if (error instanceof ProviderError) {
    return {
      code: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }
  const message = error instanceof Error ? error.message : '알 수 없는 질문 생성 오류';
  const code = error instanceof DomainError
    ? error.code
    : message.split(':', 1)[0] || 'GENERATION_FAILED';
  const explicitRetryable = typeof error === 'object'
    && error !== null
    && 'retryable' in error
    && typeof error.retryable === 'boolean'
    ? error.retryable
    : null;
  return {
    code,
    message,
    retryable: explicitRetryable
      ?? (NON_RETRYABLE_CODES.has(code) ? false : RETRYABLE_CODES.has(code) ? true : true),
  };
}

export function isGenerationControlError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (error instanceof DomainError
    && (error.code === 'JOB_LEASE_MISMATCH' || error.code === 'GENERATION_ITEM_OWNERSHIP_LOST')) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}
