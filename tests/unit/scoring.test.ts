import { expect, test } from 'vitest';
import { exactMatch, normalizeKoreanAnswer, tokenCost } from '@/domain/scoring';
import { mcnemar, pairedBootstrap } from '@/domain/statistics';

test('normalizes Korean answers without destroying meaningful internal spacing', () => {
  expect(normalizeKoreanAnswer('  정답은   물의 순환입니다。\r\n')).toBe('정답은 물의 순환입니다');
  expect(exactMatch('②', ['2', '②'])).toBe(1);
  expect(exactMatch('광합성', ['호흡'])).toBe(0);
});

test('calculates a versioned token cost', () => {
  expect(tokenCost({ inputTokens: 1_000_000, outputTokens: 500_000, inputPerMillion: 2, outputPerMillion: 8 })).toBe(6);
});

test('paired bootstrap is deterministic with a seeded random source', () => {
  const random = (() => { let value = 42; return () => ((value = (value * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
  const result = pairedBootstrap([1, 1, 0, 1], [0, 1, 0, 0], { samples: 500, random });
  expect(result.difference).toBe(0.5); expect(result.low).toBeLessThanOrEqual(result.difference); expect(result.high).toBeGreaterThanOrEqual(result.difference);
});

test('McNemar reports discordant pairs and an exact two-sided p-value', () => {
  expect(mcnemar([1, 1, 0, 1], [0, 1, 1, 0])).toMatchObject({ aOnly: 2, bOnly: 1, n: 3, pValue: 1 });
});
