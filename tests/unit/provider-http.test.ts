import { expect, test } from 'vitest';
import { assertProviderResponse } from '@/server/providers/http';
import { ProviderError } from '@/server/providers/types';

async function captureProviderError(
  body: string,
  headers: Record<string, string> = {},
  secret = 'provider-secret',
): Promise<ProviderError> {
  try {
    await assertProviderResponse(new Response(body, {
      status: 429,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
    }), secret);
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('Expected assertProviderResponse to reject');
}

test('parses fractional Gemini RetryInfo and RPM scope from quotaId', async () => {
  const quotaId = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
  const error = await captureProviderError(JSON.stringify({
    error: {
      code: 429,
      message: 'Quota exceeded',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaId,
            quotaMetric: 'generativelanguage.googleapis.com/generate_requests',
            description: 'Request quota exhausted',
          }],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '1.25s',
        },
      ],
    },
  }));

  expect(error).toMatchObject({
    kind: 'RATE_LIMIT',
    retryAfterMs: 1_250,
    rateLimitDimension: 'RPM',
    rateLimitScope: quotaId,
  });
});

test.each([
  {
    field: 'description',
    violation: { description: 'Requests per day quota exceeded' },
    expectedDimension: 'RPD',
    expectedScope: 'Requests per day quota exceeded',
  },
  {
    field: 'quotaMetric',
    violation: {
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_input_tokens_per_minute',
    },
    expectedDimension: 'TPM',
    expectedScope: 'generativelanguage.googleapis.com/generate_content_input_tokens_per_minute',
  },
])('classifies Gemini rate dimension from $field', async ({
  violation,
  expectedDimension,
  expectedScope,
}) => {
  const error = await captureProviderError(JSON.stringify({
    error: {
      details: [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation],
      }],
    },
  }));

  expect(error.rateLimitDimension).toBe(expectedDimension);
  expect(error.rateLimitScope).toBe(expectedScope);
});

test('prefers daily quota metadata when Gemini reports multiple rate dimensions', async () => {
  const dailyQuotaId = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
  const error = await captureProviderError(JSON.stringify({
    error: {
      details: [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' },
          { quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' },
          { quotaId: dailyQuotaId },
        ],
      }],
    },
  }));

  expect(error.rateLimitDimension).toBe('RPD');
  expect(error.rateLimitScope).toBe(dailyQuotaId);
});

test.each([
  { headerDelay: '2', bodyDelay: '1.25s', expectedDelayMs: 2_000 },
  { headerDelay: '1', bodyDelay: '2.5s', expectedDelayMs: 2_500 },
])('uses the longer retry hint from header $headerDelay and body $bodyDelay', async ({
  headerDelay,
  bodyDelay,
  expectedDelayMs,
}) => {
  const error = await captureProviderError(JSON.stringify({
    error: {
      details: [{
        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
        retryDelay: bodyDelay,
      }],
    },
  }), { 'retry-after': headerDelay });

  expect(error.retryAfterMs).toBe(expectedDelayMs);
});

test('rejects exponent syntax in Retry-After delay-seconds', async () => {
  const error = await captureProviderError('{}', { 'retry-after': '1e300' });

  expect(error.retryAfterMs).toBeNull();
});

test.each([
  {
    source: 'Retry-After',
    headers: {
      'retry-after': '9999999999999999999',
    } as Record<string, string>,
    body: '{}',
  },
  {
    source: 'Gemini RetryInfo',
    headers: {} as Record<string, string>,
    body: JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '9999999999999999999s',
        }],
      },
    }),
  },
])('bounds an excessive $source hint to seven days', async ({ headers, body }) => {
  const error = await captureProviderError(body, headers);

  expect(error.retryAfterMs).toBe(604_800_000);
});

test('redacts a complete Bearer authorization value and an explicit provider secret', async () => {
  const secret = 'provider-secret';
  const error = await captureProviderError(
    `authorization: Bearer leaked-token; secret=${secret}`,
    {},
    secret,
  );

  expect(error.message).not.toContain('leaked-token');
  expect(error.message).not.toContain(secret);
  expect(error.message).toContain('authorization [REDACTED]');
});

test('ignores malformed Gemini details while keeping the error sanitized', async () => {
  const secret = 'top-secret-value';
  const error = await captureProviderError(JSON.stringify({
    error: {
      message: `${secret} authorization: bearer-value`,
      details: [
        null,
        'not-an-object',
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: 'eventually',
        },
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [null, { quotaId: 42, quotaMetric: {}, description: [] }],
        },
      ],
    },
  }), { 'retry-after': 'not-a-delay' }, secret);

  expect(error).toMatchObject({
    kind: 'RATE_LIMIT',
    retryAfterMs: null,
    rateLimitDimension: 'UNKNOWN',
    rateLimitScope: null,
  });
  expect(error.message).not.toContain(secret);
  expect(error.message).not.toContain('bearer-value');
  expect(error.message).toContain('[REDACTED]');
});

test('treats a non-JSON provider body as unknown rate-limit metadata', async () => {
  const error = await captureProviderError('gateway returned malformed JSON');

  expect(error).toMatchObject({
    kind: 'RATE_LIMIT',
    retryAfterMs: null,
    rateLimitDimension: 'UNKNOWN',
    rateLimitScope: null,
  });
});
