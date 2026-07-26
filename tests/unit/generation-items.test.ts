import { expect, test } from 'vitest';
import { summarizeGenerationItems } from '@/domain/generation-items';
import { DomainError } from '@/domain/errors';
import { classifyGenerationFailure } from '@/server/questions/failure';
import { ProviderError } from '@/server/providers/types';

test('summarizes durable item states and exposes structured retry errors by ordinal', () => {
  expect(summarizeGenerationItems([
    { ordinal: 3, state: 'RUNNING', retryable: true, errorCode: null, errorMessage: null },
    { ordinal: 2, state: 'FAILED', retryable: true, errorCode: 'MODEL_TIMEOUT', errorMessage: '응답 제한 시간을 초과했습니다.' },
    { ordinal: 1, state: 'COMPLETED', retryable: true, errorCode: null, errorMessage: null },
    { ordinal: 4, state: 'PENDING', retryable: true, errorCode: null, errorMessage: null },
  ])).toEqual({
    total: 4,
    completed: 1,
    failed: 1,
    running: 1,
    pending: 1,
    allCompleted: false,
    errors: [{
      ordinal: 2,
      code: 'MODEL_TIMEOUT',
      message: '응답 제한 시간을 초과했습니다.',
      retryable: true,
    }],
  });
});

test('treats only an entirely completed item set as complete', () => {
  expect(summarizeGenerationItems([
    { ordinal: 1, state: 'COMPLETED', retryable: true, errorCode: null, errorMessage: null },
    { ordinal: 2, state: 'COMPLETED', retryable: true, errorCode: null, errorMessage: null },
  ])).toMatchObject({
    total: 2,
    completed: 2,
    failed: 0,
    running: 0,
    pending: 0,
    allCompleted: true,
    errors: [],
  });
  expect(summarizeGenerationItems([]).allCompleted).toBe(false);
});

test('preserves provider retryability and treats structural generation failures as terminal', () => {
  expect(classifyGenerationFailure(new ProviderError({
    kind: 'AUTH',
    message: '인증 실패',
    retryable: false,
  }))).toMatchObject({ code: 'AUTH', retryable: false });
  expect(classifyGenerationFailure(new ProviderError({
    kind: 'TIMEOUT',
    message: '응답 시간 초과',
    retryable: true,
  }))).toMatchObject({ code: 'TIMEOUT', retryable: true });
  expect(classifyGenerationFailure(
    new DomainError('GENERATION_FORMAT_MISMATCH', '구조화 스키마 불일치'),
  )).toMatchObject({ code: 'GENERATION_FORMAT_MISMATCH', retryable: false });
  expect(classifyGenerationFailure(
    new DomainError('GENERATION_INCOMPLETE_RESPONSE', '출력이 중단됨'),
  )).toMatchObject({ code: 'GENERATION_INCOMPLETE_RESPONSE', retryable: true });
});
