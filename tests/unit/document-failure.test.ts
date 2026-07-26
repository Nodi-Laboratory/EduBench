import { expect, test } from 'vitest';
import {
  classifyDocumentFailure,
  DocumentPageParseExhaustedError,
} from '@/server/documents/failure';
import { ProviderError } from '@/server/providers/types';

test('does not repeat a deterministic local raster page-range timeout', () => {
  expect(classifyDocumentFailure(new Error(
    'DOCUMENT_RASTERIZATION_TIMEOUT: page range 1-10 exceeded 120000ms',
  ))).toEqual({
    code: 'DOCUMENT_RASTERIZATION_TIMEOUT',
    retryable: false,
  });
});

test('keeps transient provider failures retryable through the page wrapper cause', () => {
  const provider = new ProviderError({
    kind: 'RATE_LIMIT',
    message: 'rate limited',
    retryable: true,
    status: 429,
  });
  const wrapped = new Error('DOCUMENT_PARSE_PAGE_4: rate limited', { cause: provider });
  expect(classifyDocumentFailure(wrapped)).toEqual({
    code: 'DOCUMENT_PARSE_PAGE_4',
    retryable: true,
    provider: {
      kind:'RATE_LIMIT',
      status:429,
      requestId:null,
      retryAfterMs:null,
    },
  });
});

test('does not restart the whole textbook after page-local provider retries are exhausted', () => {
  const provider = new ProviderError({
    kind:'RATE_LIMIT',
    message:'rate limited',
    retryable:true,
    status:429,
  });
  const exhausted = new DocumentPageParseExhaustedError(4, provider);

  expect(classifyDocumentFailure(exhausted)).toEqual({
    code:'DOCUMENT_PARSE_PAGE_4',
    retryable:false,
    provider:{
      kind:'RATE_LIMIT',
      status:429,
      requestId:null,
      retryAfterMs:null,
    },
  });
  expect(exhausted.cause).toBe(provider);
});

test('does not retry invalid provider requests or malformed local documents', () => {
  expect(classifyDocumentFailure(new ProviderError({
    kind: 'INVALID_REQUEST',
    message: 'invalid',
    retryable: false,
  })).retryable).toBe(false);
  expect(classifyDocumentFailure(new Error(
    'DOCUMENT_PAGE_COUNT_INVALID: no page count',
  )).retryable).toBe(false);
});

test.each([
  'EMBEDDING_NOT_CONFIGURED: GOOGLE_API_KEY가 필요합니다.',
  'DOCUMENT_EMPTY: 문서에서 청크를 만들 수 없습니다.',
  'DOCUMENT_RASTERIZATION_MISSING_PAGES: page range 1-3 missing pages 2',
  'DOCUMENT_RASTERIZATION_UNEXPECTED_PAGES: page range 1-3 produced pages 4',
])('does not retry deterministic configuration, content, or raster failures: %s', (message) => {
  expect(classifyDocumentFailure(new Error(message))).toEqual({
    code: message.split(':', 1)[0],
    retryable: false,
  });
});
