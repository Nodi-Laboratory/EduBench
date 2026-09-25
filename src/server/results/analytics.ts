import type { PoolClient } from 'pg';
import {
  benchmarkRetrievalModes,
  type BenchmarkRetrievalMode,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
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
  retrievalMode?:StoredBenchmarkRetrievalMode;
  seriesKey?:string;
  displayName: string;
  modelId: string;
  responses: number;
  avgLatencyMs: number | null;
  costKrw: number | null;
};

export type ResultAggregateScoreInput = {
  blindId: string;
  retrievalMode?:StoredBenchmarkRetrievalMode;
  seriesKey?:string;
  questionId?: string;
  questionPublicId?: string;
  questionText?: string;
  purpose: string;
  metricKey: string;
  value: number | null;
};

export type ResultScoreInput = ResultAggregateScoreInput & {
  questionId: string;
  questionPublicId: string;
  questionText: string;
};

export type ResultAnalyticsView = {
  models: Array<ResultModelInput & {
    seriesKey:string;
    compositeScore:number | null;
    scoreCount:number;
  }>;
  metricRows: Array<{ metricKey: string; label: string; scores: Record<string, number>; counts: Record<string, number> }>;
  purposeRows: Array<{ purpose: string; scores: Record<string, number>; counts: Record<string, number> }>;
  prerequisiteRows: Array<{ metricKey: string; label: string; scores: Record<string, number>; counts: Record<string, number> }>;
  distributions: Array<{ blindId: string; bins: [number, number, number, number, number] }>;
};

export type ResultQuestionHeatmapPage = {
  page: number;
  pageSize: number;
  total: number;
  rows: Array<{
    questionId: string;
    publicId: string;
    questionText: string;
    purpose: string;
    scores: Record<string, number>;
  }>;
};

export const defaultResultHeatmapPageSize = 25;
export const maxResultHeatmapPageSize = 100;

export type ResultAnalytics = ResultAnalyticsView & {
  retrievalModes?:BenchmarkRetrievalMode[];
  purposeOptions?: string[];
  purposeViews?: Record<string, ResultAnalyticsView>;
};

export type BuiltResultAnalytics = ResultAnalyticsView & {
  retrievalModes:BenchmarkRetrievalMode[];
  purposeOptions: string[];
  purposeViews: Record<string, ResultAnalyticsView>;
};

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1_000_000) / 1_000_000;
}

function groupedRows(
  scores: ResultAggregateScoreInput[],
  keyOf: (score: ResultAggregateScoreInput) => string,
): Array<{ key: string; scores: Record<string, number>; counts: Record<string, number> }> {
  const groups = new Map<string, Map<string, number[]>>();
  for (const score of scores) {
    const key = keyOf(score);
    const byModel = groups.get(key) ?? new Map<string, number[]>();
    groups.set(key, byModel);
    if (score.value == null || !Number.isFinite(score.value)) continue;
    const seriesKey = resultSeriesKey(score);
    const values = byModel.get(seriesKey) ?? [];
    values.push(score.value);
    byModel.set(seriesKey, values);
  }
  return [...groups.entries()].map(([key, byModel]) => ({
    key,
    scores: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, average(values)!])),
    counts: Object.fromEntries([...byModel].map(([blindId, values]) => [blindId, values.length])),
  }));
}

function metricWeight(metricKey: string, weights: Record<string, number>): number {
  if (metricKey === 'exact_match') return 0;
  if (Object.prototype.hasOwnProperty.call(weights, metricKey)) return weights[metricKey]!;
  return metricKey === 'response_present' ? 0 : 1;
}

export function resultSeriesKey(input: {
  blindId:string;
  retrievalMode?:StoredBenchmarkRetrievalMode;
  seriesKey?:string;
}): string {
  return input.seriesKey
    ?? (input.retrievalMode
      ? `${input.blindId}::${input.retrievalMode}`
      : input.blindId);
}

type BuildResultAnalyticsInput = {
  models: ResultModelInput[];
  modelsByPurpose?: Record<string, ResultModelInput[]>;
  purposes?: string[];
  scores: ResultAggregateScoreInput[];
  metricWeights?: Record<string, number>;
};

function buildResultAnalyticsView(input: {
  models: ResultModelInput[];
  scores: ResultAggregateScoreInput[];
  metricWeights: Record<string, number>;
}): ResultAnalyticsView {
  const weights = input.metricWeights;
  const scoreRecords = input.scores.filter(
    (score) => (
      score.metricKey !== 'exact_match'
      && (score.value == null || Number.isFinite(score.value))
    ),
  );
  const validScores = scoreRecords.filter(
    (score): score is ResultAggregateScoreInput & { value:number } =>
      score.value != null && Number.isFinite(score.value),
  );
  const metricRows = groupedRows(scoreRecords, (score) => score.metricKey)
    .map((row) => ({ metricKey:row.key, label:resultMetricLabels[row.key] ?? row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const purposeRows = groupedRows(scoreRecords.filter((score) => score.metricKey === 'accuracy'), (score) => score.purpose)
    .map((row) => ({ purpose:row.key, scores:row.scores, counts:row.counts }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose, 'ko'));
  const distributions = input.models.map((model) => {
    const seriesKey = resultSeriesKey(model);
    const bins: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const score of validScores.filter((entry) => (
      resultSeriesKey(entry) === seriesKey
      && entry.metricKey === 'accuracy'
    ))) {
      bins[Math.min(4, Math.floor(Math.max(0, score.value) * 5))] += 1;
    }
    return { blindId:seriesKey, bins };
  });
  const models = input.models.map((model) => {
    const seriesKey = resultSeriesKey(model);
    const metricMeans = groupedRows(
      validScores.filter((score) => resultSeriesKey(score) === seriesKey),
      (score) => score.metricKey,
    ).flatMap((row) => {
      const value = row.scores[seriesKey];
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
      if (resultSeriesKey(score) !== seriesKey) return false;
      const weight = metricWeight(score.metricKey, weights);
      return Number.isFinite(weight) && weight > 0;
    }).length;
    return { ...model, seriesKey, compositeScore, scoreCount };
  }).sort((a, b) => (
    (b.compositeScore ?? -1) - (a.compositeScore ?? -1)
    || a.blindId.localeCompare(b.blindId, undefined, { numeric:true })
  ));
  return {
    models,
    metricRows,
    purposeRows,
    prerequisiteRows:metricRows.filter((row) => prerequisiteMetricKeys.includes(row.metricKey as typeof prerequisiteMetricKeys[number])),
    distributions,
  };
}

export function buildResultQuestionHeatmapPage(input: {
  scores: ResultScoreInput[];
  purpose?: string;
  retrievalModes?: StoredBenchmarkRetrievalMode[];
  blindIds?: string[];
  page?: number;
  pageSize?: number;
}): ResultQuestionHeatmapPage {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(
    maxResultHeatmapPageSize,
    Math.max(1, Math.floor(input.pageSize ?? defaultResultHeatmapPageSize)),
  );
  const retrievalModes = input.retrievalModes?.length
    ? new Set(input.retrievalModes)
    : null;
  const blindIds = input.blindIds?.length ? new Set(input.blindIds) : null;
  const questions = new Map<string, ResultQuestionHeatmapPage['rows'][number]>();
  for (const score of input.scores) {
    if (score.metricKey !== 'accuracy') continue;
    if (input.purpose && score.purpose !== input.purpose) continue;
    if (retrievalModes && (!score.retrievalMode || !retrievalModes.has(score.retrievalMode))) continue;
    if (blindIds && !blindIds.has(score.blindId)) continue;
    const row = questions.get(score.questionId) ?? {
      questionId:score.questionId,
      publicId:score.questionPublicId,
      questionText:score.questionText,
      purpose:score.purpose,
      scores:{},
    };
    if (score.value != null && Number.isFinite(score.value)) {
      row.scores[resultSeriesKey(score)] = score.value;
    }
    questions.set(score.questionId, row);
  }
  const rows = [...questions.values()]
    .sort((left, right) => (
      left.publicId.localeCompare(right.publicId, undefined, { numeric:true })
      || left.questionId.localeCompare(right.questionId)
    ));
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total:rows.length,
    rows:rows.slice(start, start + pageSize),
  };
}

export function buildResultAnalytics(
  input: BuildResultAnalyticsInput,
): BuiltResultAnalytics {
  const weights = input.metricWeights ?? {};
  const retrievalModes = benchmarkRetrievalModes.filter((mode) => (
    input.models.some((model) => model.retrievalMode === mode)
    || input.scores.some((score) => score.retrievalMode === mode)
  ));
  const purposeOptions = [...new Set([
    ...(input.purposes ?? []),
    ...input.scores.map((score) => score.purpose),
  ].filter((purpose) => purpose.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const purposeViews = Object.fromEntries(purposeOptions.map((purpose) => [
    purpose,
    buildResultAnalyticsView({
      models:input.modelsByPurpose?.[purpose] ?? input.models,
      scores:input.scores.filter((score) => score.purpose === purpose),
      metricWeights:weights,
    }),
  ]));
  return {
    ...buildResultAnalyticsView({
      models:input.models,
      scores:input.scores,
      metricWeights:weights,
    }),
    retrievalModes,
    purposeOptions,
    purposeViews,
  };
}

type ModelDbRow = {
  blind_id: string; display_name: string; model_id: string; responses: string;
  retrieval_mode:StoredBenchmarkRetrievalMode;
  avg_latency_ms: string | null; cost_krw: string | null;
};
type PurposeModelDbRow = ModelDbRow & { purpose: string };
type AnalyticsAggregateDbRow = {
  row_kind:'METRIC' | 'PURPOSE' | 'MODEL' | 'DISTRIBUTION';
  scope_purpose:string | null;
  blind_id: string;
  retrieval_mode:StoredBenchmarkRetrievalMode;
  row_key:string | null;
  average_value:string | null;
  score_count:string;
  composite_score:string | null;
  bin_0:string;
  bin_1:string;
  bin_2:string;
  bin_3:string;
  bin_4:string;
};

type Queryable = Pick<PoolClient, 'query'>;

type HeatmapDbRow = {
  total: string;
  question_id: string | null;
  public_id: string | null;
  question_text: string | null;
  purpose: string | null;
  blind_id: string | null;
  retrieval_mode: StoredBenchmarkRetrievalMode | null;
  value: string | null;
};

function numericRecordValue(value:string | null):number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildResultAnalyticsAggregateView(input: {
  models:ResultModelInput[];
  rows:AnalyticsAggregateDbRow[];
  scopePurpose:string | null;
}):ResultAnalyticsView {
  const scopeRows = input.rows.filter(
    (row) => row.scope_purpose === input.scopePurpose,
  );
  const modelAggregates = new Map(
    scopeRows
      .filter((row) => row.row_kind === 'MODEL')
      .map((row) => [resultSeriesKey({
        blindId:row.blind_id,
        retrievalMode:row.retrieval_mode,
      }), row]),
  );
  const distributionAggregates = new Map(
    scopeRows
      .filter((row) => row.row_kind === 'DISTRIBUTION')
      .map((row) => [resultSeriesKey({
        blindId:row.blind_id,
        retrievalMode:row.retrieval_mode,
      }), row]),
  );
  const groupedAggregateRows = (
    kind:'METRIC' | 'PURPOSE',
  ):Array<{
    key:string;
    scores:Record<string, number>;
    counts:Record<string, number>;
  }> => {
    const grouped = new Map<string, {
      scores:Record<string, number>;
      counts:Record<string, number>;
    }>();
    for (const row of scopeRows) {
      if (row.row_kind !== kind || row.row_key == null) continue;
      const aggregate = grouped.get(row.row_key) ?? {
        scores:{},
        counts:{},
      };
      grouped.set(row.row_key, aggregate);
      const value = numericRecordValue(row.average_value);
      const count = Number(row.score_count);
      if (value == null || !Number.isSafeInteger(count) || count <= 0) {
        continue;
      }
      const seriesKey = resultSeriesKey({
        blindId:row.blind_id,
        retrievalMode:row.retrieval_mode,
      });
      aggregate.scores[seriesKey] = value;
      aggregate.counts[seriesKey] = count;
    }
    return [...grouped].map(([key, aggregate]) => ({
      key,
      ...aggregate,
    }));
  };
  const metricRows = groupedAggregateRows('METRIC')
    .map((row) => ({
      metricKey:row.key,
      label:resultMetricLabels[row.key] ?? row.key,
      scores:row.scores,
      counts:row.counts,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, 'ko'));
  const purposeRows = groupedAggregateRows('PURPOSE')
    .map((row) => ({
      purpose:row.key,
      scores:row.scores,
      counts:row.counts,
    }))
    .sort((left, right) => left.purpose.localeCompare(right.purpose, 'ko'));
  const distributions = input.models.map((model) => {
    const seriesKey = resultSeriesKey(model);
    const aggregate = distributionAggregates.get(seriesKey);
    return {
      blindId:seriesKey,
      bins:aggregate
        ? [
          Number(aggregate.bin_0),
          Number(aggregate.bin_1),
          Number(aggregate.bin_2),
          Number(aggregate.bin_3),
          Number(aggregate.bin_4),
        ] as [number, number, number, number, number]
        : [0, 0, 0, 0, 0] as [number, number, number, number, number],
    };
  });
  const models = input.models.map((model) => {
    const seriesKey = resultSeriesKey(model);
    const aggregate = modelAggregates.get(seriesKey);
    return {
      ...model,
      seriesKey,
      compositeScore:numericRecordValue(
        aggregate?.composite_score ?? null,
      ),
      scoreCount:Number(aggregate?.score_count ?? 0),
    };
  }).sort((left, right) => (
    (right.compositeScore ?? -1) - (left.compositeScore ?? -1)
    || left.blindId.localeCompare(
      right.blindId,
      undefined,
      { numeric:true },
    )
  ));
  return {
    models,
    metricRows,
    purposeRows,
    prerequisiteRows:metricRows.filter((row) => (
      prerequisiteMetricKeys.includes(
        row.metricKey as typeof prerequisiteMetricKeys[number],
      )
    )),
    distributions,
  };
}

export async function getResultQuestionHeatmapPage(
  runId: string,
  input: {
    purpose?: string;
    retrievalModes?: StoredBenchmarkRetrievalMode[];
    blindIds?: string[];
    page?: number;
    pageSize?: number;
  } = {},
  queryable: Queryable = db,
): Promise<ResultQuestionHeatmapPage> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(
    maxResultHeatmapPageSize,
    Math.max(1, Math.floor(input.pageSize ?? defaultResultHeatmapPageSize)),
  );
  const purpose = input.purpose?.trim() || null;
  const retrievalModes = input.retrievalModes?.length
    ? input.retrievalModes
    : null;
  const blindIds = input.blindIds?.length ? input.blindIds : null;
  const result = await queryable.query<HeatmapDbRow>(
    `with filtered_items as (
       select ri.id,ri.question_id,ri.question_revision,ri.retrieval_mode,
              rm.blind_id,br.score_profile_id,mr.id response_id
         from run_items ri
         join benchmark_runs br on br.id=ri.benchmark_run_id
         join run_models rm on rm.id=ri.run_model_id
         left join lateral (
           select response.id
             from eligible_model_responses response
            where response.run_item_id=ri.id
            order by response.attempt desc,response.created_at desc,
                     response.id desc
            limit 1
         ) mr on true
        where ri.benchmark_run_id=$1
          and ($2::text is null or exists (
            select 1 from questions q where q.id=ri.question_id and q.purpose=$2
          ))
          and ($3::text[] is null or ri.retrieval_mode::text=any($3::text[]))
          and ($4::text[] is null or rm.blind_id=any($4::text[]))
     ), questions_in_scope as (
       select distinct fi.question_id,q.public_id,qr.question_text,q.purpose
         from filtered_items fi
         join questions q on q.id=fi.question_id
         join question_revisions qr
           on qr.question_id=fi.question_id and qr.revision=fi.question_revision
     ), question_total as (
       select count(*)::text total from questions_in_scope
     ), paged_questions as (
       select *
         from questions_in_scope
        order by public_id,question_id
        limit $5 offset $6
     )
     select question_total.total,pq.question_id,pq.public_id,pq.question_text,pq.purpose,
            fi.blind_id,fi.retrieval_mode,s.value::text
       from question_total
       left join paged_questions pq on true
       left join filtered_items fi on fi.question_id=pq.question_id
       left join scores s on s.model_response_id=fi.response_id
         and s.score_profile_id=fi.score_profile_id
         and s.metric_key='accuracy'
      order by pq.public_id,pq.question_id,fi.blind_id,fi.retrieval_mode`,
    [runId, purpose, retrievalModes, blindIds, pageSize, (page - 1) * pageSize],
  );
  const questions = new Map<string, ResultQuestionHeatmapPage['rows'][number]>();
  for (const row of result.rows) {
    if (
      row.question_id == null
      || row.public_id == null
      || row.question_text == null
      || row.purpose == null
    ) continue;
    const question = questions.get(row.question_id) ?? {
      questionId:row.question_id,
      publicId:row.public_id,
      questionText:row.question_text,
      purpose:row.purpose,
      scores:{},
    };
    const value = row.value == null ? null : Number(row.value);
    if (
      value != null
      && Number.isFinite(value)
      && row.blind_id != null
      && row.retrieval_mode != null
    ) {
      question.scores[resultSeriesKey({
        blindId:row.blind_id,
        retrievalMode:row.retrieval_mode,
      })] = value;
    }
    questions.set(row.question_id, question);
  }
  return {
    page,
    pageSize,
    total:Number(result.rows[0]?.total ?? 0),
    rows:[...questions.values()],
  };
}

export async function getResultAnalytics(
  runId: string,
  queryable: Queryable = db,
): Promise<BuiltResultAnalytics> {
  const models = await queryable.query<ModelDbRow>(
      `select rm.blind_id,rm.display_name,rm.model_id,ri.retrieval_mode,
       count(mr.id)::text responses,
       avg(mr.latency_ms)::text avg_latency_ms,sum(mr.cost_krw)::text cost_krw
       from run_items ri join run_models rm on rm.id=ri.run_model_id
       left join lateral (
         select response.id,response.latency_ms,response.cost_krw
           from eligible_model_responses response
          where response.run_item_id=ri.id
          order by response.attempt desc,response.created_at desc,
                   response.id desc
          limit 1
       ) mr on true
       where rm.benchmark_run_id=$1
       group by rm.id,ri.retrieval_mode
       order by rm.blind_id,ri.retrieval_mode`,
      [runId],
    );
  const purposeModels = await queryable.query<PurposeModelDbRow>(
      `with purposes as (
         select distinct q.purpose
         from run_items ri
         join questions q on q.id=ri.question_id
         where ri.benchmark_run_id=$1
       ), modes as (
         select distinct retrieval_mode
         from run_items
         where benchmark_run_id=$1
       ), purpose_stats as (
         select ri.run_model_id,ri.retrieval_mode,q.purpose,
           count(mr.id)::text responses,
           avg(mr.latency_ms)::text avg_latency_ms,
           sum(mr.cost_krw)::text cost_krw
         from run_items ri
         join questions q on q.id=ri.question_id
         left join lateral (
           select response.id,response.latency_ms,response.cost_krw
             from eligible_model_responses response
            where response.run_item_id=ri.id
            order by response.attempt desc,response.created_at desc,
                     response.id desc
            limit 1
         ) mr on true
         where ri.benchmark_run_id=$1
         group by ri.run_model_id,ri.retrieval_mode,q.purpose
       )
       select p.purpose,rm.blind_id,rm.display_name,rm.model_id,
         modes.retrieval_mode,
         coalesce(stats.responses,'0') responses,
         stats.avg_latency_ms,stats.cost_krw
       from purposes p
       cross join run_models rm
       cross join modes
       left join purpose_stats stats
         on stats.run_model_id=rm.id
        and stats.retrieval_mode=modes.retrieval_mode
        and stats.purpose=p.purpose
       where rm.benchmark_run_id=$1
       order by p.purpose,rm.blind_id,modes.retrieval_mode`,
      [runId],
    );
  const aggregates = await queryable.query<AnalyticsAggregateDbRow>(
    `with score_base as (
       select rm.blind_id,ri.retrieval_mode,q.purpose,s.metric_key,
              s.value,
              case
                when jsonb_typeof(
                  br.score_profile_snapshot->'weights'->s.metric_key
                )='number'
                  then (
                    br.score_profile_snapshot->'weights'->>s.metric_key
                  )::numeric
                when br.score_profile_snapshot->'weights' ? s.metric_key
                  then null
                when s.metric_key='response_present' then 0::numeric
                else 1::numeric
              end metric_weight
         from run_items ri
         join benchmark_runs br on br.id=ri.benchmark_run_id
         join run_models rm on rm.id=ri.run_model_id
         join questions q on q.id=ri.question_id
         join lateral (
           select response.id
             from eligible_model_responses response
            where response.run_item_id=ri.id
            order by response.attempt desc,response.created_at desc,
                     response.id desc
            limit 1
         ) mr on true
         join scores s
          on s.model_response_id=mr.id
          and s.score_profile_id=br.score_profile_id
          and s.metric_key<>'exact_match'
        where ri.benchmark_run_id=$1
          and (
            s.value is null
            or s.value::text not in ('NaN','Infinity','-Infinity')
          )
     ), scoped_scores as (
       select null::text scope_purpose,score.*
         from score_base score
       union all
       select score.purpose scope_purpose,score.*
         from score_base score
     ), metric_aggregates as (
       select scope_purpose,blind_id,retrieval_mode,metric_key,
              floor(avg(value)*1000000+0.5)/1000000 average_value,
              count(value) score_count,
              max(metric_weight) metric_weight
         from scoped_scores
        group by scope_purpose,blind_id,retrieval_mode,metric_key
     ), model_aggregates as (
       select scope_purpose,blind_id,retrieval_mode,
              case
                when coalesce(sum(metric_weight) filter (
                  where average_value is not null
                    and metric_weight > 0
                ),0) > 0
                  then floor((
                    sum(average_value*metric_weight) filter (
                      where average_value is not null
                        and metric_weight > 0
                    )
                    / sum(metric_weight) filter (
                      where average_value is not null
                        and metric_weight > 0
                    )
                  )*1000000+0.5)/1000000
                else null
              end composite_score,
              coalesce(sum(score_count) filter (
                where metric_weight > 0
              ),0) score_count
         from metric_aggregates
        group by scope_purpose,blind_id,retrieval_mode
     ), purpose_aggregates as (
       select purpose,blind_id,retrieval_mode,
              floor(avg(value)*1000000+0.5)/1000000 average_value,
              count(value) score_count
         from score_base
        where metric_key='accuracy'
        group by purpose,blind_id,retrieval_mode
     ), scoped_purpose_aggregates as (
       select null::text scope_purpose,purpose,blind_id,retrieval_mode,
              average_value,score_count
         from purpose_aggregates
       union all
       select purpose scope_purpose,purpose,blind_id,retrieval_mode,
              average_value,score_count
         from purpose_aggregates
     ), distributions as (
       select scope_purpose,blind_id,retrieval_mode,
              count(*) filter (
                where value is not null
                  and least(
                    4,
                    floor(greatest(0,value)*5)::integer
                  )=0
              ) bin_0,
              count(*) filter (
                where value is not null
                  and least(
                    4,
                    floor(greatest(0,value)*5)::integer
                  )=1
              ) bin_1,
              count(*) filter (
                where value is not null
                  and least(
                    4,
                    floor(greatest(0,value)*5)::integer
                  )=2
              ) bin_2,
              count(*) filter (
                where value is not null
                  and least(
                    4,
                    floor(greatest(0,value)*5)::integer
                  )=3
              ) bin_3,
              count(*) filter (
                where value is not null
                  and least(
                    4,
                    floor(greatest(0,value)*5)::integer
                  )=4
              ) bin_4
         from scoped_scores
        where metric_key='accuracy'
        group by scope_purpose,blind_id,retrieval_mode
     ), aggregate_rows as (
       select 'METRIC'::text row_kind,scope_purpose,blind_id,
              retrieval_mode,metric_key row_key,
              average_value::text average_value,
              score_count::text score_count,
              null::text composite_score,
              '0'::text bin_0,'0'::text bin_1,'0'::text bin_2,
              '0'::text bin_3,'0'::text bin_4
         from metric_aggregates
       union all
       select 'PURPOSE',scope_purpose,blind_id,retrieval_mode,purpose,
              average_value::text,score_count::text,null::text,
              '0','0','0','0','0'
         from scoped_purpose_aggregates
       union all
       select 'MODEL',scope_purpose,blind_id,retrieval_mode,null::text,
              null::text,score_count::text,composite_score::text,
              '0','0','0','0','0'
         from model_aggregates
       union all
       select 'DISTRIBUTION',scope_purpose,blind_id,retrieval_mode,
              null::text,null::text,'0',null::text,
              bin_0::text,bin_1::text,bin_2::text,bin_3::text,bin_4::text
         from distributions
     )
     select *
       from aggregate_rows
      order by scope_purpose nulls first,
               case row_kind
                 when 'METRIC' then 1
                 when 'PURPOSE' then 2
                 when 'MODEL' then 3
                 else 4
               end,
               row_key nulls last,blind_id,retrieval_mode`,
    [runId],
  );
  const mapModel = (row: ModelDbRow): ResultModelInput => ({
    blindId:row.blind_id,
    retrievalMode:row.retrieval_mode,
    displayName:row.display_name,
    modelId:row.model_id,
    responses:Number(row.responses),
    avgLatencyMs:row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
    costKrw:row.cost_krw == null ? null : Number(row.cost_krw),
  });
  const purposes = [...new Set(purposeModels.rows.map((row) => row.purpose))];
  const modelsByPurpose = Object.fromEntries(purposes.map((purpose) => [
    purpose,
    purposeModels.rows
      .filter((row) => row.purpose === purpose)
      .map(mapModel),
  ]));
  const mappedModels = models.rows.map(mapModel);
  const purposeOptions = purposes
    .filter((purpose) => purpose.trim().length > 0)
    .sort((left, right) => left.localeCompare(right, 'ko'));
  const purposeViews = Object.fromEntries(purposeOptions.map((purpose) => [
    purpose,
    buildResultAnalyticsAggregateView({
      models:modelsByPurpose[purpose] ?? mappedModels,
      rows:aggregates.rows,
      scopePurpose:purpose,
    }),
  ]));
  return {
    ...buildResultAnalyticsAggregateView({
      models:mappedModels,
      rows:aggregates.rows,
      scopePurpose:null,
    }),
    retrievalModes:benchmarkRetrievalModes.filter((mode) => (
      mappedModels.some((model) => model.retrievalMode === mode)
    )),
    purposeOptions,
    purposeViews,
  };
}
