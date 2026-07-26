import { expect, test } from 'vitest';
import { exactMatch, judgeMetricBatches, normalizeJudgeEvidence, normalizeJudgeScoreValue, normalizeJudgeText, normalizeKoreanAnswer, selectJudgeScore, tokenCost } from '@/domain/scoring';
import { requiredMetricsForQuestion } from '@/domain/scoring';
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

test('normalizes string and object evidence returned by a judge model', () => {
  expect(normalizeJudgeEvidence(['교과서와 일치', { quote: '원문', ignored: true }, null])).toEqual([
    { claim: '교과서와 일치' },
    { quote: '원문' },
  ]);
});

test('adds prerequisite metrics only for prerequisite benchmark questions', () => {
  const quality = { benchmarkDesign: { benchmarkType: 'PREREQUISITE_RELATIONSHIP' } };
  const required = requiredMetricsForQuestion(['accuracy'], quality);
  expect(required).toContain('accuracy');
  expect(required).toContain('prerequisite_relation_accuracy');
  expect(required).toContain('reasoning_chain_completeness');
  expect(requiredMetricsForQuestion(['accuracy'], {})).toEqual(['exact_match', 'response_present', 'accuracy']);
});

test('starts with one efficient judge batch and rejects a mislabeled score', () => {
  expect(judgeMetricBatches(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c', 'd', 'e']]);
  expect(selectJudgeScore('accuracy', [{ metricKey:'정확성', value:0.8 }])).toBeNull();
  expect(selectJudgeScore('accuracy', [])).toBeNull();
  expect(normalizeJudgeScoreValue('0.8')).toBe(0.8);
  expect(normalizeJudgeScoreValue('not-a-score')).toBe('not-a-score');
  expect(normalizeJudgeText(undefined, '설명 없음')).toBe('설명 없음');
});
