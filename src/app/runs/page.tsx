import type { Metadata } from 'next';
import { RunWorkspace } from '@/components/runs/run-workspace';
import { db } from '@/server/db/pool';
import { benchmarkGenerationParameters } from '@/domain/research-config';
import { listResearchConfigProfiles } from '@/server/settings/research-profiles';

export const metadata: Metadata = { title: '벤치마크 실행' };
export const dynamic = 'force-dynamic';

// Non-secret server settings a provider needs besides the user's API key.
const providerEnv: Record<string, string[]> = {
  exaone:['EXAONE_BASE_URL'],
  midm:['MIDM_BASE_URL'],
};

export default async function RunsPage() {
  const mockMode = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const [datasets, scoreProfiles, runs, researchProfiles] = await Promise.all([
    db.query<{
      id: string;
      version: string;
      title: string;
      description: string | null;
      question_count: number;
      content_hash: string;
      published_at: string;
    }>(
      `select id,version,title,description,question_count,content_hash,
         published_at::text published_at
       from dataset_versions
       where status = 'PUBLISHED'
       order by published_at desc`,
    ),
    db.query<{ id:string; version:string; title:string; provenance_unresolved:boolean; retired_metric:boolean; judge_provider:string | null }>(
      `select id,version,title,judge_provider,
         not score_profile_definition_usable(metrics,judge_provider,judge_model)
           provenance_unresolved,
         metrics @> '["exact_match"]'::jsonb retired_metric
       from score_profiles
       order by created_at desc`,
    ),
    db.query<{ id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; created_at: string }>(
      `select id, public_id, title, state, total_items, completed_items, failed_items, created_at::text
       from benchmark_runs order by created_at desc limit 50`,
    ),
    listResearchConfigProfiles('benchmark_models'),
  ]);
  const activeId = researchProfiles.activeByKind.benchmark_models;
  const activeProfile = researchProfiles.items.find(
    (profile) => profile.id === activeId
      && profile.definition.kind === 'benchmark_models',
  );
  const modelDefinitions = activeProfile?.definition.kind === 'benchmark_models'
    ? activeProfile.definition.settings.models
    : [];
  return <RunWorkspace
    datasets={datasets.rows}
    scoreProfiles={scoreProfiles.rows}
    modelProfile={activeProfile ? {
      id:activeProfile.id,
      version:activeProfile.version,
      contentHash:activeProfile.contentHash,
    } : null}
    providers={modelDefinitions.map((model) => ({
      provider_key:model.providerKey,
      display_name:model.displayName,
      protocol:model.protocol,
      modelId:model.modelId,
      configured:(providerEnv[model.providerKey] ?? []).every(
        (key) => Boolean(process.env[key]),
      ),
      envNames:providerEnv[model.providerKey] ?? [],
      parameters:benchmarkGenerationParameters(model),
      concurrency:model.concurrency,
      requestIntervalMs:model.requestIntervalMs,
      requestTimeoutMs:model.requestTimeoutMs,
    }))}
    initialRuns={runs.rows}
    mockMode={mockMode}
  />;
}
