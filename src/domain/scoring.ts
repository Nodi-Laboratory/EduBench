export function normalizeKoreanAnswer(value: string): string {
  return value.normalize('NFC').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/u, '').trim().toLocaleLowerCase('ko-KR');
}

export function tokenCost(input: { inputTokens: number; outputTokens: number; inputPerMillion: number; outputPerMillion: number }): number {
  return (input.inputTokens * input.inputPerMillion + input.outputTokens * input.outputPerMillion) / 1_000_000;
}

export function requiredMetricsForQuestion(profileMetrics: string[], qualityScores: unknown): string[] {
  const quality = qualityScores && typeof qualityScores === 'object' ? qualityScores as Record<string, unknown> : {};
  const design = quality.benchmarkDesign && typeof quality.benchmarkDesign === 'object'
    ? quality.benchmarkDesign as Record<string, unknown> : null;
  const benchmarkMetrics = design?.benchmarkType === 'PREREQUISITE_RELATIONSHIP' ? prerequisiteScoreMetrics : [];
  return [...new Set([
    'response_present',
    ...profileMetrics.filter((metric) => metric !== 'exact_match'),
    ...benchmarkMetrics,
  ])];
}
import { prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';

export type JudgeEvidence = { claim?: string; quote?: string; chunkId?: string };

export function judgeMetricBatches(metrics: string[]): string[][] {
  return metrics.length ? [metrics] : [];
}

export function selectJudgeScore<T extends { metricKey: string }>(metric: string, scores: T[]): (T & { metricKey: string }) | null {
  return scores.find((score) => score.metricKey === metric) ?? null;
}

export function normalizeJudgeScoreValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

export function normalizeJudgeText(value: unknown, fallback: string): unknown {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeJudgeEvidence(value: unknown): JudgeEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): JudgeEvidence[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ claim: entry.trim() }] : [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const normalized: JudgeEvidence = {};
    if (typeof source.claim === 'string' && source.claim.trim()) normalized.claim = source.claim.trim();
    if (typeof source.quote === 'string' && source.quote.trim()) normalized.quote = source.quote.trim();
    if (typeof source.chunkId === 'string' && source.chunkId.trim()) normalized.chunkId = source.chunkId.trim();
    return Object.keys(normalized).length ? [normalized] : [];
  });
}
