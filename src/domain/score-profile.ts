export const algorithmicMetricKeys = ['exact_match', 'response_present'] as const;
export const legacyJudgeProvenanceSentinels = [
  'legacy-environment-default-unrecorded',
  'legacy-provider-unrecorded',
] as const;
export const verifiedScoreProfileSnapshotProvenance = 'AT_CREATION_VERIFIED' as const;
export const scoreProfileReplacementRequiredMessage =
  '채점 프로필 또는 생성 시점 스냅샷 출처가 검증되지 않았습니다. 새 채점 프로필 버전과 새 실행을 생성하십시오.';

export type ScoreProfileSnapshotProvenance =
  | 'LEGACY_BACKFILL_UNVERIFIED'
  | typeof verifiedScoreProfileSnapshotProvenance;

export type ScoreMetricWeights = Record<string, number>;

export type ScoreProfileDefinition = {
  version: string;
  title: string;
  metrics: string[];
  weights: ScoreMetricWeights;
  rubricPrompt: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
};

export type ScoreProfileSnapshot = ScoreProfileDefinition & {
  id: string;
  contentHash: string;
};

export function hasJudgeMetrics(metrics: string[]): boolean {
  return metrics.some(
    (metric) => !algorithmicMetricKeys.includes(metric as (typeof algorithmicMetricKeys)[number]),
  );
}

export function isJudgeProvenanceResolved(
  judgeProvider: string | null | undefined,
  judgeModel: string | null | undefined,
): boolean {
  if (judgeProvider == null && judgeModel == null) return true;
  if (judgeProvider == null || judgeModel == null) return false;
  const provider = judgeProvider.trim();
  const model = judgeModel.trim();
  if (!provider || !model) return false;
  const sentinels = new Set<string>(legacyJudgeProvenanceSentinels);
  return !sentinels.has(provider) && !sentinels.has(model);
}

export function isRunScoreProfileUsable(input: {
  judgeProvider:string | null | undefined;
  judgeModel:string | null | undefined;
  metrics:unknown;
  snapshotProvenance:string | null | undefined;
}): boolean {
  if (
    input.snapshotProvenance !== verifiedScoreProfileSnapshotProvenance
    || !isJudgeProvenanceResolved(input.judgeProvider, input.judgeModel)
  ) return false;
  if (!Array.isArray(input.metrics)) return false;
  const metrics = input.metrics.map(String);
  return !hasJudgeMetrics(metrics) || Boolean(input.judgeProvider?.trim() && input.judgeModel?.trim());
}
