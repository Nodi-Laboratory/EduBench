import { DomainError } from './errors';

export type DatasetTarget = {
  capabilities: {
    coreConcept: number;
    application: number;
    crossUnit: number;
    studentExplanation: number;
    misconceptionCorrection: number;
  };
  responseFormats: {
    multipleChoice: number;
    shortAnswer: number;
    structuredResponse: number;
    studentExplanation: number;
    correctionScope: number;
  };
  evidenceModes: {
    grounded: number;
    closedBook: number;
    insufficientEvidence: number;
  };
};

export const DEFAULT_DATASET_TARGET: DatasetTarget = {
  capabilities: {
    coreConcept: 150,
    application: 120,
    crossUnit: 80,
    studentExplanation: 80,
    misconceptionCorrection: 70,
  },
  responseFormats: {
    multipleChoice: 100,
    shortAnswer: 100,
    structuredResponse: 200,
    studentExplanation: 60,
    correctionScope: 40,
  },
  evidenceModes: {
    grounded: 400,
    closedBook: 75,
    insufficientEvidence: 25,
  },
};

function total(values: Record<string, number>, group: string): number {
  const entries = Object.entries(values);
  if (entries.some(([, value]) => !Number.isInteger(value) || value < 0)) {
    throw new DomainError('DATASET_DISTRIBUTION_INVALID', `${group} 분포에는 0 이상의 정수만 사용할 수 있습니다.`);
  }
  return entries.reduce((sum, [, value]) => sum + value, 0);
}

export function validateTargetDistribution(target: DatasetTarget): DatasetTarget & { total: number } {
  const totals = {
    capabilities: total(target.capabilities, '역량'),
    responseFormats: total(target.responseFormats, '응답 형식'),
    evidenceModes: total(target.evidenceModes, '근거 모드'),
  };
  if (new Set(Object.values(totals)).size !== 1 || totals.capabilities !== 500) {
    throw new DomainError('DATASET_DISTRIBUTION_INVALID', '각 분포의 합계는 모두 500이어야 합니다.', totals);
  }
  return { ...target, total: 500 };
}

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

