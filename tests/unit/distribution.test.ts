import { expect, test } from 'vitest';
import { validateDatasetProfile } from '@/domain/distribution';

test('flags materially imbalanced multiple-choice answer positions', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    questionType: 'multipleChoice' as const,
    correctOption: index < 80 ? 'A' as const : 'B' as const,
  }));
  const result = validateDatasetProfile(items);
  expect(result.valid).toBe(false);
  expect(result.issues[0]?.code).toBe('ANSWER_POSITION_IMBALANCE');
});

