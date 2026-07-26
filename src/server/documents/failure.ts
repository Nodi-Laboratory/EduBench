import { ProviderError } from '@/server/providers/types';

export class DocumentPageParseExhaustedError extends Error {
  readonly retryable = false;

  constructor(
    public readonly pageNumber: number,
    cause: ProviderError,
  ) {
    super(`DOCUMENT_PARSE_PAGE_${pageNumber}: ${cause.message}`, { cause });
    this.name = 'DocumentPageParseExhaustedError';
  }
}

export type DocumentFailureClassification = {
  code: string;
  retryable: boolean;
  provider?: {
    kind: ProviderError['kind'];
    status: number | null;
    requestId: string | null;
    retryAfterMs: number | null;
  };
};

function providerErrorInChain(error: unknown): ProviderError | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ProviderError) return current;
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

function stableCode(error: unknown, provider: ProviderError | null) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(message);
  if (match) return match[1]!;
  return provider
    ? `DOCUMENT_PROVIDER_${provider.kind}`
    : 'DOCUMENT_PIPELINE_FAILED';
}

const deterministicLocalFailures = new Set([
  'DOCUMENT_PAGE_COUNT_INVALID',
  'DOCUMENT_PAGE_COUNT_FAILED',
  'DOCUMENT_PAGE_COUNT_TIMEOUT',
  'DOCUMENT_RASTERIZATION_FAILED',
  'DOCUMENT_RASTERIZATION_TIMEOUT',
  'DOCUMENT_RASTERIZATION_EMPTY',
  'DOCUMENT_RASTERIZATION_MISSING_PAGES',
  'DOCUMENT_RASTERIZATION_UNEXPECTED_PAGES',
  'DOCUMENT_EMPTY',
  'SOURCE_NOT_FOUND',
  'UPSTAGE_NOT_CONFIGURED',
  'EMBEDDING_NOT_CONFIGURED',
  'GOOGLE_API_KEY_NOT_CONFIGURED',
]);

export function classifyDocumentFailure(error: unknown): DocumentFailureClassification {
  const provider = providerErrorInChain(error);
  const code = stableCode(error, provider);
  const providerDetails = provider
    ? {
        kind:provider.kind,
        status:provider.status,
        requestId:provider.requestId,
        retryAfterMs:provider.retryAfterMs,
      }
    : undefined;
  if (error instanceof DocumentPageParseExhaustedError) {
    return {
      code,
      retryable:false,
      ...(providerDetails ? { provider:providerDetails } : {}),
    };
  }
  if (provider) {
    return {
      code,
      retryable:provider.retryable,
      provider:providerDetails,
    };
  }
  if (deterministicLocalFailures.has(code)) return { code, retryable: false };
  return { code, retryable: true };
}
