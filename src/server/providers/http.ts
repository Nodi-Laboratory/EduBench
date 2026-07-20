import { ProviderError, type ProviderErrorKind } from './types';

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
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function sanitize(value: string, secret: string): string {
  const withoutSecret = secret ? value.replaceAll(secret, '[REDACTED]') : value;
  return withoutSecret.replace(/(api[-_ ]?key|authorization)["':= ]+[^\s,"}]+/gi, '$1 [REDACTED]').slice(0, 500);
}

export async function assertProviderResponse(response: Response, secret: string): Promise<void> {
  if (response.ok) return;
  const kind = errorKind(response.status);
  const raw = sanitize(await response.text(), secret);
  const requestId = response.headers.get('request-id')
    ?? response.headers.get('x-request-id')
    ?? response.headers.get('x-goog-request-id');
  throw new ProviderError({
    kind,
    message: `${kind}: 공급자 요청이 실패했습니다. ${raw}`,
    retryable: kind === 'RATE_LIMIT' || kind === 'PROVIDER_5XX',
    status: response.status,
    requestId,
    retryAfterMs: retryAfterMs(response),
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

