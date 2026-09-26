import { db } from '@/server/db/pool';
import { createProviderForModel } from '@/server/providers/registry';
import { isMockProviders, type ProviderEnv } from '@/server/providers/credentials';
import { commandRun } from './service';

/**
 * Lists the providers a run still needs a user-supplied key for. Keys only
 * live in memory, so after a restart a RUNNING or SCORING run can be left
 * without them until the user resumes it from the browser.
 */
export async function missingRunProviderKeys(
  runId: string,
  env: ProviderEnv,
  phase: 'execution' | 'scoring',
): Promise<string[]> {
  if (isMockProviders()) return [];
  const run = await db.query<{
    retrieval_modes: string[];
    judge_provider: string | null;
    judge_model: string | null;
  }>(
    `select retrieval_modes,
            score_profile_snapshot->>'judgeProvider' judge_provider,
            score_profile_snapshot->>'judgeModel' judge_model
       from benchmark_runs where id=$1`,
    [runId],
  );
  const row = run.rows[0];
  if (!row) return [];
  const missing = new Set<string>();
  if (phase === 'execution') {
    const models = await db.query<{ provider_key: string; model_id: string }>(
      'select provider_key, model_id from run_models where benchmark_run_id=$1',
      [runId],
    );
    for (const model of models.rows) {
      if (!createProviderForModel(model.provider_key, model.model_id, env)) missing.add(model.provider_key);
    }
    if (row.retrieval_modes.includes('VECTOR') && !env.GOOGLE_API_KEY) missing.add('gemini');
  } else if (
    row.judge_provider
    && row.judge_model
    && !createProviderForModel(row.judge_provider, row.judge_model, env)
  ) {
    missing.add(row.judge_provider);
  }
  return [...missing];
}

export async function pauseRunForMissingProviderKeys(runId: string, missing: string[]): Promise<void> {
  await commandRun(runId, 'PAUSE');
  await db.query(
    `insert into job_events(aggregate_type, aggregate_id, event_type, payload)
     values ('benchmark_run', $1, 'RUN_PROVIDER_KEYS_REQUIRED', $2::jsonb)`,
    [runId, JSON.stringify({
      providers:missing,
      message:'API 키가 서버 메모리에 없어 실행을 일시정지했습니다. 설정 화면에서 키를 확인한 뒤 재개하세요.',
    })],
  );
}
