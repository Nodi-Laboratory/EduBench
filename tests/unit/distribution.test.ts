import { expect, test } from 'vitest';
import {
  DEFAULT_DATASET_TARGET,
  validateDatasetProfile,
  validateTargetDistribution,
} from '@/domain/distribution';

test('accepts the registered 500-question target profile', () => {
  const result = validateTargetDistribution(DEFAULT_DATASET_TARGET);
  expect(result.total).toBe(500);
  expect(result.capabilities).toEqual({
    coreConcept: 150,
    application: 120,
    crossUnit: 80,
    studentExplanation: 80,
    misconceptionCorrection: 70,
  });
});

test('rejects a target profile whose evidence modes do not total 500', () => {
  expect(() => validateTargetDistribution({
    ...DEFAULT_DATASET_TARGET,
    evidenceModes: { grounded: 399, closedBook: 75, insufficientEvidence: 25 },
  })).toThrow('DATASET_DISTRIBUTION_INVALID');
});

test('flags materially imbalanced multiple-choice answer positions', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    questionType: 'multipleChoice' as const,
    correctOption: index < 80 ? 'A' as const : 'B' as const,
  }));
  const result = validateDatasetProfile(items);
  expect(result.valid).toBe(false);
  expect(result.issues[0]?.code).toBe('ANSWER_POSITION_IMBALANCE');
});

