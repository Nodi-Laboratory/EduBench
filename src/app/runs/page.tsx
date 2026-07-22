import type { Metadata } from 'next';
import { RunWorkspace } from '@/components/runs/run-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '벤치마크 실행' };
export const dynamic = 'force-dynamic';

const modelEnv: Record<string, string> = {
  exaone: 'EXAONE_MODEL', gemini: 'GEMINI_GENERATION_MODEL', upstage: 'UPSTAGE_MODEL',
};

export default async function RunsPage() {
  const mockMode = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const [datasets, providers, scoreProfiles, runs] = await Promise.all([
    db.query<{ id: string; version: string; title: string; question_count: number }>(
      `select id, version, title, question_count from dataset_versions where status = 'PUBLISHED' order by published_at desc`,
    ),
    db.query<{ provider_key: string; display_name: string; protocol: string }>(
      'select provider_key, display_name, protocol from provider_configs order by display_name',
    ),
    db.query<{ id: string; version: string; title: string }>('select id, version, title from score_profiles order by created_at desc'),
    db.query<{ id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; created_at: string }>(
      `select id, public_id, title, state, total_items, completed_items, failed_items, created_at::text
       from benchmark_runs order by created_at desc limit 50`,
    ),
  ]);
  return <RunWorkspace
    datasets={datasets.rows}
    scoreProfiles={scoreProfiles.rows}
    providers={providers.rows.map((provider) => ({
      ...provider,
      modelId: mockMode ? `mock-${provider.provider_key}` : (process.env[modelEnv[provider.provider_key]!] ?? ''),
      envName: modelEnv[provider.provider_key]!,
      requestIntervalMs: provider.provider_key === 'exaone'
        ? Number(process.env.EXAONE_REQUEST_INTERVAL_MS ?? 30_000)
        : Number(process.env.DEFAULT_MODEL_REQUEST_INTERVAL_MS ?? 0),
    }))}
    initialRuns={runs.rows}
  />;
}
