type MultipleChoiceProfile = {
  questionType: 'multipleChoice';
  correctOption: 'A' | 'B' | 'C' | 'D';
};

export function validateDatasetProfile(items: MultipleChoiceProfile[]): {
  valid: boolean;
  issues: Array<{ code: string; message: string }>;
} {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const item of items) counts[item.correctOption] += 1;
  const expected = items.length / 4;
  const tolerance = Math.max(2, expected * 0.2);
  const imbalanced = Object.values(counts).some((count) => Math.abs(count - expected) > tolerance);
  const issues = imbalanced
    ? [{ code: 'ANSWER_POSITION_IMBALANCE', message: `객관식 정답 위치가 불균형합니다: ${JSON.stringify(counts)}` }]
    : [];
  return { valid: issues.length === 0, issues };
}

