import { db } from '@/server/db/pool';

export const resultMetricLabels: Record<string, string> = {
  accuracy: '정확성',
  faithfulness: '교과서 충실성',
  completeness: '완결성',
  curriculum_alignment: '교육과정 정합성',
  student_fit: '학생 수준 적합성',
  misconception: '오개념 대응',
  hallucination: '환각 억제',
  exact_match: '완전 일치',
  response_present: '응답 존재',
  target_concept_correctness: '목표 개념 정확성',
  prerequisite_identification: '선수 개념 식별',
  prerequisite_relation_accuracy: '선수 관계 방향 정확성',
  prerequisite_application: '선수 개념 적용',
  reasoning_chain_completeness: '추론 사슬 완결성',
  textbook_grounding: '교과서 근거 충실성',
};

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
  value: number;
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
    if (!Number.isFinite(score.value)) continue;
    const byModel = groups.get(keyOf(score)) ?? new Map<string, number[]>();
    const values = byModel.get(score.blindId) ?? [];
    values.push(score.value);
    byModel.set(score.blindId, values);
    groups.set(keyOf(score), byModel);
  }
  return [...groups.entries()].map(([key, byModel]) => ({
    key,
    scores: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, average(values)!])),
    counts: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, values.length])),
  }));
}

export function buildResultAnalytics(input: { models: ResultModelInput[]; scores: ResultScoreInput[] }): ResultAnalytics {
  const validScores = input.scores.filter((score) => Number.isFinite(score.value));
  const metricRows = groupedRows(validScores, (score) => score.metricKey)
    .map((row) => ({ metricKey:row.key, label:resultMetricLabels[row.key] ?? row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const purposeRows = groupedRows(validScores.filter((score) => score.metricKey === 'accuracy'), (score) => score.purpose)
    .map((row) => ({ purpose:row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose, 'ko'));
  const questionMap = new Map<string, ResultAnalytics['questionRows'][number]>();
  for (const score of validScores.filter((entry) => entry.metricKey === 'accuracy')) {
    const row = questionMap.get(score.questionId) ?? {
      questionId:score.questionId, publicId:score.questionPublicId, questionText:score.questionText,
      purpose:score.purpose, scores:{},
    };
    row.scores[score.blindId] = score.value;
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
    const compositeValues = validScores
      .filter((score) => score.blindId === model.blindId && score.metricKey !== 'response_present')
      .map((score) => score.value);
    return { ...model, compositeScore:average(compositeValues), scoreCount:compositeValues.length };
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
  purpose: string; metric_key: string; value: string;
};

export async function getResultAnalytics(runId: string): Promise<ResultAnalytics> {
  const [models, scores] = await Promise.all([
    db.query<ModelDbRow>(
      `select rm.blind_id,rm.display_name,rm.model_id,count(mr.id)::text responses,
       avg(mr.latency_ms)::text avg_latency_ms,sum(mr.cost_krw)::text cost_krw
       from run_models rm left join run_items ri on ri.run_model_id=rm.id
       left join model_responses mr on mr.run_item_id=ri.id and not mr.ignored_after_cancel
       where rm.benchmark_run_id=$1 group by rm.id order by rm.blind_id`,
      [runId],
    ),
    db.query<ScoreDbRow>(
      `select rm.blind_id,q.id question_id,q.public_id,qr.question_text,q.purpose,s.metric_key,s.value::text
       from run_items ri join run_models rm on rm.id=ri.run_model_id
       join questions q on q.id=ri.question_id
       join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision
       join model_responses mr on mr.run_item_id=ri.id and not mr.ignored_after_cancel
       join scores s on s.model_response_id=mr.id
       where ri.benchmark_run_id=$1 order by q.public_id,rm.blind_id,s.metric_key`,
      [runId],
    ),
  ]);
  return buildResultAnalytics({
    models:models.rows.map((row) => ({
      blindId:row.blind_id, displayName:row.display_name, modelId:row.model_id,
      responses:Number(row.responses), avgLatencyMs:row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
      costKrw:row.cost_krw == null ? null : Number(row.cost_krw),
    })),
    scores:scores.rows.map((row) => ({
      blindId:row.blind_id, questionId:row.question_id, questionPublicId:row.public_id,
      questionText:row.question_text, purpose:row.purpose, metricKey:row.metric_key, value:Number(row.value),
    })),
  });
}
