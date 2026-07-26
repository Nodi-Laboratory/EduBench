import type { PoolClient } from 'pg';
import type { EventCursor } from '@/domain/event-cursor';
import {
  isCurrentScoringEngineSnapshot,
  isVerifiedScoringEngineSnapshot,
} from '@/domain/scoring-engine';
import {
  readActivityEventCursor,
} from '@/server/activity/event-stream';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';
import {
  getResultAnalytics,
  type ResultAnalytics,
} from '@/server/results/analytics';

type ResultRunDbRow = {
  id: string;
  public_id: string;
  title: string;
  state: string;
  dataset_version: string;
  score_version: string | null;
  total_items: number;
  completed_items: number;
  eligible_items: number;
  failed_items: number;
  parameters: { sample_data?: boolean; mock_providers?: boolean } | null;
  score_profile_snapshot_provenance: string;
  profile_replacement_required: boolean;
  scoring_engine_version_id: string | null;
  scoring_engine_snapshot: unknown;
  scoring_engine_snapshot_provenance: string;
};

type ResultModelDbRow = {
  blind_id: string;
  display_name: string;
  model_id: string;
  responses: string;
  exact_match: string | null;
  latency: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_krw: string | null;
};

type ResultMetricDbRow = {
  blind_id: string;
  metric_key: string;
  score: string | null;
  n: string;
};

type ResultCapabilityDbRow = {
  blind_id: string;
  purpose: string;
  score: string | null;
  n: string;
};

export type ResultDetails = {
  run: {
    id: string;
    publicId: string;
    title: string;
    state: string;
    datasetVersion: string;
    scoreVersion: string | null;
    totalItems: number;
    completedItems: number;
    eligibleItems: number;
    failedItems: number;
    parameters: { sample_data?: boolean; mock_providers?: boolean };
    scoreProfileSnapshotProvenance: string;
    profileReplacementRequired: boolean;
  };
  scoringEngine: {
    id: string | null;
    version: string | null;
    title: string | null;
    contentHash: string | null;
    snapshotProvenance: string;
    verified: boolean;
    currentVerified: boolean;
  };
  models: Array<{
    blindId: string;
    displayName: string;
    modelId: string;
    responses: string;
    exactMatch: string | null;
    latency: string | null;
    inputTokens: string | null;
    outputTokens: string | null;
    costKrw: string | null;
  }>;
  metricSummary: Array<{
    blindId: string;
    metricKey: string;
    score: string | null;
    sampleCount: string;
  }>;
  capabilities: Array<{
    blindId: string;
    purpose: string;
    score: string | null;
    sampleCount: string;
  }>;
  analytics: ResultAnalytics;
  eventCursor: EventCursor;
};

export async function readResultDetails(
  client: PoolClient,
  runId: string,
): Promise<ResultDetails | null> {
  const runResult = await client.query<ResultRunDbRow>(
    `select br.id,br.public_id,br.title,br.state,br.total_items,
       br.completed_items,br.failed_items,br.parameters,
       br.score_profile_snapshot_provenance,
       br.scoring_engine_version_id,br.scoring_engine_snapshot,
       br.scoring_engine_snapshot_provenance,
       not benchmark_run_score_profile_usable(
         br.score_profile_snapshot,br.score_profile_snapshot_provenance
       ) profile_replacement_required,
       (select count(*)::int
          from eligible_model_responses eligible
          join run_items eligible_item on eligible_item.id=eligible.run_item_id
         where eligible_item.benchmark_run_id=br.id) eligible_items,
       dv.version dataset_version,
       br.score_profile_snapshot->>'version' score_version
      from benchmark_runs br
      join dataset_versions dv on dv.id=br.dataset_version_id
     where br.id=$1`,
    [runId],
  );
  const run = runResult.rows[0];
  if (!run) return null;

  const modelsResult = await client.query<ResultModelDbRow>(
    `with response_stats as (
       select ri.run_model_id,count(mr.id)::text responses,
         avg(mr.latency_ms)::text latency,
         sum(mr.input_tokens)::text input_tokens,
         sum(mr.output_tokens)::text output_tokens,
         sum(mr.cost_krw)::text cost_krw
        from run_items ri
        left join eligible_model_responses mr on mr.run_item_id=ri.id
       where ri.benchmark_run_id=$1
       group by ri.run_model_id
     ), exact_stats as (
       select ri.run_model_id,avg(s.value)::text exact_match
        from run_items ri
        join benchmark_runs br on br.id=ri.benchmark_run_id
        join eligible_model_responses mr on mr.run_item_id=ri.id
        join scores s on s.model_response_id=mr.id
          and s.metric_key='exact_match'
          and s.score_profile_id=br.score_profile_id
       where ri.benchmark_run_id=$1
       group by ri.run_model_id
     )
     select rm.blind_id,rm.display_name,rm.model_id,
       coalesce(rs.responses,'0') responses,es.exact_match,rs.latency,
       rs.input_tokens,rs.output_tokens,rs.cost_krw
      from run_models rm
      left join response_stats rs on rs.run_model_id=rm.id
      left join exact_stats es on es.run_model_id=rm.id
     where rm.benchmark_run_id=$1
     order by rm.blind_id`,
    [runId],
  );
  const metricResult = await client.query<ResultMetricDbRow>(
    `select rm.blind_id,s.metric_key,avg(s.value)::text score,
       count(s.value)::text n
      from run_items ri
      join benchmark_runs br on br.id=ri.benchmark_run_id
      join run_models rm on rm.id=ri.run_model_id
      join eligible_model_responses mr on mr.run_item_id=ri.id
      join scores s on s.model_response_id=mr.id
        and s.score_profile_id=br.score_profile_id
     where ri.benchmark_run_id=$1
     group by rm.blind_id,s.metric_key
     order by rm.blind_id,s.metric_key`,
    [runId],
  );
  const capabilityResult = await client.query<ResultCapabilityDbRow>(
    `select rm.blind_id,q.purpose,avg(s.value)::text score,
       count(s.value)::text n
      from run_items ri
      join benchmark_runs br on br.id=ri.benchmark_run_id
      join run_models rm on rm.id=ri.run_model_id
      join questions q on q.id=ri.question_id
      join eligible_model_responses mr on mr.run_item_id=ri.id
      join scores s on s.model_response_id=mr.id
        and s.metric_key='accuracy'
        and s.score_profile_id=br.score_profile_id
     where ri.benchmark_run_id=$1
     group by rm.blind_id,q.purpose
     order by q.purpose,rm.blind_id`,
    [runId],
  );
  const analytics = await getResultAnalytics(runId, client);
  const eventCursor = await readActivityEventCursor(
    client,
    'benchmark_run',
    runId,
  );
  const engineSnapshot = (
    run.scoring_engine_snapshot
    && typeof run.scoring_engine_snapshot === 'object'
    && !Array.isArray(run.scoring_engine_snapshot)
  )
    ? run.scoring_engine_snapshot as Record<string, unknown>
    : null;
  const engineVerificationInput = {
    scoringEngineVersionId:run.scoring_engine_version_id,
    scoringEngineSnapshot:run.scoring_engine_snapshot,
    provenance:run.scoring_engine_snapshot_provenance,
  };

  return {
    run: {
      id: run.id,
      publicId: run.public_id,
      title: run.title,
      state: run.state,
      datasetVersion: run.dataset_version,
      scoreVersion: run.score_version,
      totalItems: run.total_items,
      completedItems: run.completed_items,
      eligibleItems: run.eligible_items,
      failedItems: run.failed_items,
      parameters: run.parameters ?? {},
      scoreProfileSnapshotProvenance: run.score_profile_snapshot_provenance,
      profileReplacementRequired: run.profile_replacement_required,
    },
    scoringEngine: {
      id:typeof engineSnapshot?.id === 'string'
        ? engineSnapshot.id
        : run.scoring_engine_version_id,
      version:typeof engineSnapshot?.version === 'string'
        ? engineSnapshot.version
        : null,
      title:typeof engineSnapshot?.title === 'string'
        ? engineSnapshot.title
        : null,
      contentHash:typeof engineSnapshot?.contentHash === 'string'
        ? engineSnapshot.contentHash
        : null,
      snapshotProvenance:run.scoring_engine_snapshot_provenance,
      verified:isVerifiedScoringEngineSnapshot(engineVerificationInput),
      currentVerified:isCurrentScoringEngineSnapshot(engineVerificationInput),
    },
    models: modelsResult.rows.map((model) => ({
      blindId: model.blind_id,
      displayName: model.display_name,
      modelId: model.model_id,
      responses: model.responses,
      exactMatch: model.exact_match,
      latency: model.latency,
      inputTokens: model.input_tokens,
      outputTokens: model.output_tokens,
      costKrw: model.cost_krw,
    })),
    metricSummary: metricResult.rows.map((row) => ({
      blindId: row.blind_id,
      metricKey: row.metric_key,
      score: row.score,
      sampleCount: row.n,
    })),
    capabilities: capabilityResult.rows.map((row) => ({
      blindId: row.blind_id,
      purpose: row.purpose,
      score: row.score,
      sampleCount: row.n,
    })),
    analytics,
    eventCursor,
  };
}

export async function getResultDetails(
  runId: string,
): Promise<ResultDetails | null> {
  return withReadOnlyRepeatableReadTransaction(
    (client) => readResultDetails(client, runId),
  );
}
