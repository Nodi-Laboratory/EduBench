import { expect, test } from 'vitest';
import { benchmarkTaskForOrdinal, prerequisiteScoringCriteria, prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';

test('rotates prerequisite task families instead of repeating one question pattern', () => {
  expect(Array.from({ length: 5 }, (_, index) => benchmarkTaskForOrdinal(index + 1))).toEqual([
    'dependency_application',
    'missing_prerequisite_diagnosis',
    'cross_unit_transfer',
    'relation_direction_discrimination',
    'prerequisite_chain_completion',
  ]);
});

test('defines atomic scoring criteria for prerequisite understanding', () => {
  expect(prerequisiteScoreMetrics).toEqual([
    'target_concept_correctness',
    'prerequisite_identification',
    'prerequisite_relation_accuracy',
    'prerequisite_application',
    'reasoning_chain_completeness',
    'textbook_grounding',
  ]);
  expect(prerequisiteScoringCriteria).toHaveLength(6);
  expect(prerequisiteScoringCriteria.map((item) => item.maxScore)).toEqual([1, 1, 1, 1, 1, 1]);
});
