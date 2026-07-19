export function normalizeKoreanAnswer(value: string): string {
  return value.normalize('NFC').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/u, '').trim().toLocaleLowerCase('ko-KR');
}

export function exactMatch(response: string, acceptedAnswers: string[]): 0 | 1 {
  const normalized = normalizeKoreanAnswer(response);
  return acceptedAnswers.some((answer) => normalizeKoreanAnswer(answer) === normalized) ? 1 : 0;
}

export function tokenCost(input: { inputTokens: number; outputTokens: number; inputPerMillion: number; outputPerMillion: number }): number {
  return (input.inputTokens * input.inputPerMillion + input.outputTokens * input.outputPerMillion) / 1_000_000;
}
