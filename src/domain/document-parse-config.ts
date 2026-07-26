export const DOCUMENT_PARSE_BASE64_ENCODING = ['table', 'figure', 'chart', 'equation'] as const;

export const DEFAULT_UPSTAGE_DOCUMENT_PARSE_CONCURRENCY_CAP = 2;
export const DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS = 8;

export function effectiveDocumentParseConcurrency(
  requested: number,
  configuredCap = process.env.UPSTAGE_DOCUMENT_PARSE_MAX_CONCURRENCY,
) {
  const parsedCap = Number(configuredCap);
  const cap = Number.isInteger(parsedCap) && parsedCap > 0
    ? parsedCap
    : DEFAULT_UPSTAGE_DOCUMENT_PARSE_CONCURRENCY_CAP;
  return Math.max(1, Math.min(requested, cap));
}
