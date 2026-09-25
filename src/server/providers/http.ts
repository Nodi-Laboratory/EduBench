import {
  ProviderError,
  type ProviderErrorKind,
  type ProviderRateLimitDimension,
} from './types';

type RateLimitMetadata = {
  retryAfterMs: number | null;
  rateLimitDimension: ProviderRateLimitDimension;
  rateLimitScope: string | null;
};

type QuotaMetadata = Omit<RateLimitMetadata, 'retryAfterMs'>;

/** Maximum provider-directed cooldown accepted from untrusted retry metadata. */
export const MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS = 604_800_000;

const rateLimitDimensionPriority: Record<ProviderRateLimitDimension, number> = {
  UNKNOWN: 0,
  RPM: 1,
  TPM: 2,
  RPD: 3,
};

const emptyRateLimitMetadata = (): RateLimitMetadata => ({
  retryAfterMs: null,
  rateLimitDimension: 'UNKNOWN',
  rateLimitScope: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 404 || status === 422) return 'INVALID_REQUEST';
  if (status >= 500) return 'PROVIDER_5XX';
  return 'UNKNOWN';
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds)
      ? Math.min(seconds * 1_000, MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS)
      : MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS;
  }
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? null
    : Math.min(
      Math.max(0, date - Date.now()),
      MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS,
    );
}

function protoDurationMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(value)) return null;
  const milliseconds = Number(value.slice(0, -1)) * 1_000;
  return Number.isFinite(milliseconds)
    ? Math.min(Math.ceil(milliseconds), MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS)
    : MAX_PROVIDER_RATE_LIMIT_COOLDOWN_MS;
}

function classifyRateLimitDimension(value: string): ProviderRateLimitDimension {
  if (/\brpd\b|per[\s._/-]*day|\bdaily\b/i.test(value)) return 'RPD';
  const perMinute = /per[\s._/-]*minute|\bminutely\b/i.test(value);
  if ((/\btpm\b/i.test(value) || /tokens?/i.test(value)) && perMinute) return 'TPM';
  if (/\brpm\b/i.test(value) || (/requests?/i.test(value) && perMinute)) return 'RPM';
  return 'UNKNOWN';
}

function preferredQuotaMetadata(current: QuotaMetadata, candidate: QuotaMetadata): QuotaMetadata {
  const currentPriority = rateLimitDimensionPriority[current.rateLimitDimension];
  const candidatePriority = rateLimitDimensionPriority[candidate.rateLimitDimension];
  if (candidatePriority > currentPriority) return candidate;
  if (
    candidatePriority === currentPriority
    && current.rateLimitScope === null
    && candidate.rateLimitScope !== null
  ) return candidate;
  return current;
}

function parseQuotaFailure(detail: Record<string, unknown>): QuotaMetadata {
  const violations = detail.violations;
  if (!Array.isArray(violations)) {
    return { rateLimitDimension: 'UNKNOWN', rateLimitScope: null };
  }

  let selected: QuotaMetadata = {
    rateLimitDimension: 'UNKNOWN',
    rateLimitScope: null,
  };
  for (const violation of violations) {
    if (!isRecord(violation)) continue;
    const values = [
      violation.quotaId,
      violation.quotaMetric,
      violation.description,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (values.length === 0) continue;

    const scope = values[0];
    const rateLimitDimension = classifyRateLimitDimension(values.join(' '));
    selected = preferredQuotaMetadata(selected, {
      rateLimitDimension,
      rateLimitScope: scope,
    });
  }

  return selected;
}

function parseRateLimitMetadata(raw: string): RateLimitMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRateLimitMetadata();
  }
  if (!isRecord(parsed) || !isRecord(parsed.error) || !Array.isArray(parsed.error.details)) {
    return emptyRateLimitMetadata();
  }

  let retryDelayMs: number | null = null;
  let quotaMetadata: QuotaMetadata = {
    rateLimitDimension: 'UNKNOWN',
    rateLimitScope: null,
  };
  for (const detail of parsed.error.details) {
    if (!isRecord(detail) || typeof detail['@type'] !== 'string') continue;
    if (detail['@type'].endsWith('google.rpc.RetryInfo')) {
      const parsedDelay = protoDurationMs(detail.retryDelay);
      if (parsedDelay !== null) {
        retryDelayMs = retryDelayMs === null ? parsedDelay : Math.max(retryDelayMs, parsedDelay);
      }
    }
    if (detail['@type'].endsWith('google.rpc.QuotaFailure')) {
      const parsedQuota = parseQuotaFailure(detail);
      quotaMetadata = preferredQuotaMetadata(quotaMetadata, parsedQuota);
    }
  }

  return {
    retryAfterMs: retryDelayMs,
    ...quotaMetadata,
  };
}

function longestRetryAfterMs(...values: Array<number | null>): number | null {
  const delays = values.filter((value): value is number => value !== null);
  return delays.length === 0 ? null : Math.max(...delays);
}

function sanitize(value: string, secret: string): string {
  const withoutSecret = secret ? value.replaceAll(secret, '[REDACTED]') : value;
  return withoutSecret
    .replace(
      /(authorization)["':= ]+(?:bearer\s+)?[^\s,"}]+/gi,
      '$1 [REDACTED]',
    )
    .replace(/(api[-_ ]?key)["':= ]+[^\s,"}]+/gi, '$1 [REDACTED]')
    .slice(0, 500);
}

export async function assertProviderResponse(response: Response, secret: string): Promise<void> {
  if (response.ok) return;
  const kind = errorKind(response.status);
  const responseBody = await response.text();
  const metadata = parseRateLimitMetadata(responseBody);
  const raw = sanitize(responseBody, secret);
  const requestId = response.headers.get('request-id')
    ?? response.headers.get('x-request-id')
    ?? response.headers.get('x-goog-request-id');
  throw new ProviderError({
    kind,
    message: `${kind}: 공급자 요청이 실패했습니다. ${raw}`,
    retryable: kind === 'RATE_LIMIT' || kind === 'PROVIDER_5XX',
    status: response.status,
    requestId,
    retryAfterMs: longestRetryAfterMs(retryAfterMs(response), metadata.retryAfterMs),
    rateLimitDimension: metadata.rateLimitDimension,
    rateLimitScope: metadata.rateLimitScope === null
      ? null
      : sanitize(metadata.rateLimitScope, secret),
  });
}

export function requestIdFrom(response: Response): string | null {
  return response.headers.get('request-id')
    ?? response.headers.get('x-request-id')
    ?? response.headers.get('x-goog-request-id');
}

export async function executeFetch(
  operation: () => Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new ProviderError({ kind: 'TIMEOUT', message: 'TIMEOUT: 공급자 요청 시간이 초과됐습니다.', retryable: true, cause: error });
    }
    throw new ProviderError({ kind: 'NETWORK', message: 'NETWORK: 공급자에 연결하지 못했습니다.', retryable: true, cause: error });
  }
}

