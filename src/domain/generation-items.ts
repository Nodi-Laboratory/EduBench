export type GenerationItemState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type GenerationItemSummaryInput = {
  ordinal: number;
  state: GenerationItemState;
  retryable: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};

export type GenerationItemError = {
  ordinal: number;
  code: string;
  message: string;
  retryable: boolean;
};

export function summarizeGenerationItems(items: GenerationItemSummaryInput[]) {
  const counts = {
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
  };
  const errors: GenerationItemError[] = [];

  for (const item of items) {
    if (item.state === 'COMPLETED') counts.completed += 1;
    else if (item.state === 'FAILED') counts.failed += 1;
    else if (item.state === 'RUNNING') counts.running += 1;
    else counts.pending += 1;

    if (item.state === 'FAILED') {
      errors.push({
        ordinal: item.ordinal,
        code: item.errorCode ?? 'GENERATION_ITEM_FAILED',
        message: item.errorMessage ?? '문항 생성에 실패했습니다.',
        retryable: item.retryable,
      });
    }
  }

  errors.sort((left, right) => left.ordinal - right.ordinal);
  return {
    total: items.length,
    ...counts,
    allCompleted: items.length > 0 && counts.completed === items.length,
    errors,
  };
}
