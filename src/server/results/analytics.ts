import type { PoolClient } from 'pg';
import { resultMetricLabels } from '@/domain/result-metrics';
import { db } from '@/server/db/pool';

export const prerequisiteMetricKeys = [
  'target_concept_correctness',
  'prerequisite_identification',
  'prerequisite_relation_accuracy',
  'prerequisite_application',
  'reasoning_chain_completeness',
  'textbook_grounding',
] as const;

export type ResultModelInput = {
  blindId: string;
  displayName: string;
  modelId: string;
  responses: number;
  avgLatencyMs: number | null;
  costKrw: number | null;
};

export type ResultScoreInput = {
  blindId: string;
  questionId: string;
  questionPublicId: string;
  questionText: string;
  purpose: string;
  metricKey: string;
  value: number | null;
};

export type ResultAnalytics = {
  models: Array<ResultModelInput & { compositeScore: number | null; scoreCount: number }>;
  metricRows: Array<{ metricKey: string; label: string; scores: Record<string, number>; counts: Record<string, number> }>;
  purposeRows: Array<{ purpose: string; scores: Record<string, number>; counts: Record<string, number> }>;
  prerequisiteRows: Array<{ metricKey: string; label: string; scores: Record<string, number>; counts: Record<string, number> }>;
  questionRows: Array<{ questionId: string; publicId: string; questionText: string; purpose: string; scores: Record<string, number> }>;
  distributions: Array<{ blindId: string; bins: [number, number, number, number, number] }>;
};

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1_000_000) / 1_000_000;
}

function groupedRows(
  scores: ResultScoreInput[],
  keyOf: (score: ResultScoreInput) => string,
): Array<{ key: string; scores: Record<string, number>; counts: Record<string, number> }> {
  const groups = new Map<string, Map<string, number[]>>();
  for (const score of scores) {
    const key = keyOf(score);
    const byModel = groups.get(key) ?? new Map<string, number[]>();
    groups.set(key, byModel);
    if (score.value == null || !Number.isFinite(score.value)) continue;
    const values = byModel.get(score.blindId) ?? [];
    values.push(score.value);
    byModel.set(score.blindId, values);
  }
  return [...groups.entries()].map(([key, byModel]) => ({
    key,
    scores: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, average(values)!])),
    counts: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, values.length])),
  }));
}

function metricWeight(metricKey: string, weights: Record<string, number>): number {
  if (Object.prototype.hasOwnProperty.call(weights, metricKey)) return weights[metricKey]!;
  return metricKey === 'response_present' ? 0 : 1;
}

export function buildResultAnalytics(input: {
  models: ResultModelInput[];
  scores: ResultScoreInput[];
  metricWeights?: Record<string, number>;
}): ResultAnalytics {
  const weights = input.metricWeights ?? {};
  const scoreRecords = input.scores.filter(
    (score) => score.value == null || Number.isFinite(score.value),
  );
  const validScores = input.scores.filter(
    (score): score is ResultScoreInput & { value:number } =>
      score.value != null && Number.isFinite(score.value),
  );
  const metricRows = groupedRows(scoreRecords, (score) => score.metricKey)
    .map((row) => ({ metricKey:row.key, label:resultMetricLabels[row.key] ?? row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const purposeRows = groupedRows(scoreRecords.filter((score) => score.metricKey === 'accuracy'), (score) => score.purpose)
    .map((row) => ({ purpose:row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose, 'ko'));
  const questionMap = new Map<string, ResultAnalytics['questionRows'][number]>();
  for (const score of scoreRecords.filter((entry) => entry.metricKey === 'accuracy')) {
    const row = questionMap.get(score.questionId) ?? {
      questionId:score.questionId, publicId:score.questionPublicId, questionText:score.questionText,
      purpose:score.purpose, scores:{},
    };
    if (score.value != null) row.scores[score.blindId] = score.value;
    questionMap.set(score.questionId, row);
  }
  const distributions = input.models.map((model) => {
    const bins: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const score of validScores.filter((entry) => entry.blindId === model.blindId && entry.metricKey === 'accuracy')) {
      bins[Math.min(4, Math.floor(Math.max(0, score.value) * 5))] += 1;
    }
    return { blindId:model.blindId, bins };
  });
  const models = input.models.map((model) => {
    const metricMeans = groupedRows(
      validScores.filter((score) => score.blindId === model.blindId),
      (score) => score.metricKey,
    ).flatMap((row) => {
      const value = row.scores[model.blindId];
      const weight = metricWeight(row.key, weights);
      return value == null || !Number.isFinite(weight) || weight <= 0
        ? []
        : [{ metricKey:row.key, value, weight }];
    });
    const denominator = metricMeans.reduce((sum, metric) => sum + metric.weight, 0);
    const compositeScore = denominator > 0
      ? Math.round((metricMeans.reduce((sum, metric) => sum + metric.value * metric.weight, 0) / denominator) * 1_000_000) / 1_000_000
      : null;
    const scoreCount = validScores.filter((score) => {
      if (score.blindId !== model.blindId) return false;
      const weight = metricWeight(score.metricKey, weights);
      return Number.isFinite(weight) && weight > 0;
    }).length;
    return { ...model, compositeScore, scoreCount };
  }).sort((a, b) => (b.compositeScore ?? -1) - (a.compositeScore ?? -1));
  return {
    models,
    metricRows,
    purposeRows,
    prerequisiteRows:metricRows.filter((row) => prerequisiteMetricKeys.includes(row.metricKey as typeof prerequisiteMetricKeys[number])),
    questionRows:[...questionMap.values()].sort((a, b) => a.publicId.localeCompare(b.publicId, undefined, { numeric:true })),
    distributions,
  };
}

type ModelDbRow = {
  blind_id: string; display_name: string; model_id: string; responses: string;
  avg_latency_ms: string | null; cost_krw: string | null;
};
type ScoreDbRow = {
  blind_id: string; question_id: string; public_id: string; question_text: string;
  purpose: string; metric_key: string; value: string | null;
};

type Queryable = Pick<PoolClient, 'query'>;

export async function getResultAnalytics(
  runId: string,
  queryable: Queryable = db,
): Promise<ResultAnalytics> {
  const models = await queryable.query<ModelDbRow>(
      `select rm.blind_id,rm.display_name,rm.model_id,count(mr.id)::text responses,
       avg(mr.latency_ms)::text avg_latency_ms,sum(mr.cost_krw)::text cost_krw
       from run_models rm left join run_items ri on ri.run_model_id=rm.id
       left join eligible_model_responses mr on mr.run_item_id=ri.id
       where rm.benchmark_run_id=$1 group by rm.id order by rm.blind_id`,
      [runId],
    );
  const scores = await queryable.query<ScoreDbRow>(
      `select rm.blind_id,q.id question_id,q.public_id,qr.question_text,q.purpose,s.metric_key,s.value::text
       from run_items ri join benchmark_runs br on br.id=ri.benchmark_run_id
       join run_models rm on rm.id=ri.run_model_id
       join questions q on q.id=ri.question_id
       join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision
       join eligible_model_responses mr on mr.run_item_id=ri.id
       join scores s on s.model_response_id=mr.id and s.score_profile_id=br.score_profile_id
       where ri.benchmark_run_id=$1 order by q.public_id,rm.blind_id,s.metric_key`,
      [runId],
    );
  const profile = await queryable.query<{ weights: Record<string, number> }>(
      `select coalesce(score_profile_snapshot->'weights','{}'::jsonb) weights
       from benchmark_runs where id=$1`,
      [runId],
    );
  return buildResultAnalytics({
    metricWeights:profile.rows[0]?.weights ?? {},
    models:models.rows.map((row) => ({
      blindId:row.blind_id, displayName:row.display_name, modelId:row.model_id,
      responses:Number(row.responses), avgLatencyMs:row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
      costKrw:row.cost_krw == null ? null : Number(row.cost_krw),
    })),
    scores:scores.rows.map((row) => ({
      blindId:row.blind_id, questionId:row.question_id, questionPublicId:row.public_id,
      questionText:row.question_text, purpose:row.purpose, metricKey:row.metric_key,
      value:row.value == null ? null : Number(row.value),
    })),
  });
}
