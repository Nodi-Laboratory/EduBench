import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '@/domain/errors';
import { transitionRun, type RunCommand, type RunState } from '@/domain/status';
import { withTransaction } from '@/server/db/transaction';

export type RunModelInput = {
  providerKey: string;
  displayName: string;
  modelId: string;
  modelSnapshot?: string;
  protocol: 'gemini' | 'anthropic' | 'openai-responses' | 'openai-compatible';
  parameters?: Record<string, unknown>;
  concurrency?: number;
  requestIntervalMs?: number;
};

export type CreateRunInput = {
  title: string;
  datasetVersionId: string;
  scoreProfileId: string;
  priceProfileVersion: string;
  systemPrompt: string;
  parameters?: Record<string, unknown>;
  models: RunModelInput[];
  questionLimit?: number;
  questionIds?: string[];
};

export type RunSummary = { id: string; publicId: string; state: RunState; totalItems: number };

export type RunItemRecord = {
  id: string;
  benchmark_run_id: string;
  run_model_id: string;
  question_id: string;
  question_revision: number;
  state: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
};

async function appendRunEvent(
  client: PoolClient,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await client.query(
    `insert into job_events(aggregate_type, aggregate_id, event_type, payload)
     values ('benchmark_run', $1, $2, $3::jsonb)`,
    [runId, eventType, JSON.stringify(payload)],
  );
}

export async function createRun(input: CreateRunInput): Promise<RunSummary> {
  if (!input.models.length) throw new DomainError('RUN_MODELS_REQUIRED', '실행할 모델을 하나 이상 선택해야 합니다.');
  if (new Set(input.models.map((model) => model.providerKey)).size !== input.models.length) {
    throw new DomainError('DUPLICATE_RUN_PROVIDER', '동일 제공자를 한 실행에 두 번 등록할 수 없습니다.');
  }
  return withTransaction(async (client) => {
    const dataset = await client.query<{ status: string }>(
      'select status from dataset_versions where id = $1', [input.datasetVersionId],
    );
    if (dataset.rows[0]?.status !== 'PUBLISHED') {
      throw new DomainError('DATASET_NOT_PUBLISHED', '게시된 데이터셋 버전만 실행할 수 있습니다.');
    }

    const questions = await client.query<{ question_id: string; question_revision: number }>(
      `select dq.question_id, dq.question_revision
       from dataset_questions dq
       where dq.dataset_version_id = $1
         and ($2::uuid[] is null or dq.question_id = any($2::uuid[]))
       order by dq.ordinal
       limit $3`,
      [input.datasetVersionId, input.questionIds?.length ? input.questionIds : null, input.questionLimit ?? 1000000],
    );
    if (!questions.rowCount) throw new DomainError('RUN_QUESTIONS_REQUIRED', '실행할 문항이 없습니다.');

    const runId = randomUUID();
    const publicId = `RUN-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${runId.slice(0, 6).toUpperCase()}`;
    const totalItems = questions.rows.length * input.models.length;
    await client.query(
      `insert into benchmark_runs(
         id, public_id, title, dataset_version_id, score_profile_id,
         price_profile_version, system_prompt, parameters, total_items
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [runId, publicId, input.title, input.datasetVersionId, input.scoreProfileId,
        input.priceProfileVersion, input.systemPrompt, JSON.stringify(input.parameters ?? {}), totalItems],
    );

    for (const [modelIndex, model] of input.models.entries()) {
      const modelId = randomUUID();
      await client.query(
        `insert into run_models(
           id, benchmark_run_id, provider_key, display_name, blind_id, model_id,
           model_snapshot, protocol, parameters, concurrency, request_interval_ms
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [modelId, runId, model.providerKey, model.displayName,
          `M${String(modelIndex + 1).padStart(2, '0')}`, model.modelId,
          model.modelSnapshot ?? null, model.protocol, JSON.stringify(model.parameters ?? {}),
          model.concurrency ?? 1, model.requestIntervalMs ?? 0],
      );
      for (const question of questions.rows) {
        await client.query(
          `insert into run_items(
             benchmark_run_id, run_model_id, question_id, question_revision, idempotency_key
           ) values ($1,$2,$3,$4,$5)`,
          [runId, modelId, question.question_id, question.question_revision,
            `${runId}:${model.providerKey}:${question.question_id}:${question.question_revision}`],
        );
      }
    }
    await appendRunEvent(client, runId, 'RUN_CREATED', { totalItems, models: input.models.length });
    return { id: runId, publicId, state: 'DRAFT', totalItems };
  });
}

const eventForCommand: Record<RunCommand, string> = {
  QUEUE: 'RUN_QUEUED', START: 'RUN_STARTED', PAUSE: 'RUN_PAUSED', RESUME: 'RUN_RESUMED',
  BEGIN_SCORING: 'RUN_SCORING_STARTED', CANCEL: 'RUN_CANCEL_REQUESTED',
  FINISH_CANCEL: 'RUN_CANCELLED', COMPLETE: 'RUN_COMPLETED', FAIL: 'RUN_FAILED',
};

export async function commandRun(runId: string, command: RunCommand): Promise<{ state: RunState }> {
  return withTransaction(async (client) => {
    const locked = await client.query<{ state: RunState }>(
      'select state from benchmark_runs where id = $1 for update', [runId],
    );
    const current = locked.rows[0]?.state;
    if (!current) throw new DomainError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다.');
    const state = transitionRun(current, command);
    await client.query(
      `update benchmark_runs set state = $2,
         pause_requested_at = case when $3 = 'PAUSE' then now() when $3 = 'RESUME' then null else pause_requested_at end,
         cancel_requested_at = case when $3 = 'CANCEL' then now() else cancel_requested_at end,
         started_at = case when $3 = 'START' then coalesce(started_at, now()) else started_at end,
         completed_at = case when $3 in ('COMPLETE','FINISH_CANCEL') then now() else completed_at end,
         updated_at = now()
       where id = $1`,
      [runId, state, command],
    );
    await appendRunEvent(client, runId, eventForCommand[command], { previousState: current, state });
    return { state };
  });
}

export async function claimRunItems(
  runId: string,
  workerId: string,
  limit: number,
  leaseMs: number,
): Promise<RunItemRecord[]> {
  if (limit < 1 || leaseMs < 1) throw new DomainError('INVALID_CLAIM_OPTIONS', 'limit와 leaseMs는 1 이상이어야 합니다.');
  return withTransaction(async (client) => {
    const result = await client.query<RunItemRecord>(
      `with candidates as (
         select ri.id from run_items ri
         join benchmark_runs br on br.id = ri.benchmark_run_id
         where ri.benchmark_run_id = $1 and br.state = 'RUNNING'
           and ri.state in ('PENDING','RETRY_WAIT') and ri.available_at <= now()
           and ri.attempts < ri.max_attempts
         order by ri.created_at, ri.id
         for update of ri skip locked limit $3
       )
       update run_items ri set state = 'LEASED', lease_owner = $2,
         lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
         attempts = ri.attempts + 1,
         started_at = coalesce(ri.started_at, now())
       from candidates c where ri.id = c.id
       returning ri.*`,
      [runId, workerId, limit, leaseMs],
    );
    if (result.rowCount) await appendRunEvent(client, runId, 'RUN_ITEMS_CLAIMED', { workerId, count: result.rowCount });
    return result.rows;
  });
}

export async function failRunItem(
  itemId: string,
  workerId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ benchmark_run_id: string }>(
      `update run_items set state = 'TERMINAL_FAILED', error_code = $3, error_message = $4,
         lease_owner = null, lease_expires_at = null, completed_at = now()
       where id = $1 and state = 'LEASED' and lease_owner = $2
       returning benchmark_run_id`,
      [itemId, workerId, errorCode, errorMessage],
    );
    const runId = result.rows[0]?.benchmark_run_id;
    if (!runId) throw new DomainError('RUN_ITEM_LEASE_MISMATCH', '해당 워커가 임대한 실행 항목이 아닙니다.');
    await client.query('update benchmark_runs set failed_items = failed_items + 1, updated_at = now() where id = $1', [runId]);
    await appendRunEvent(client, runId, 'RUN_ITEM_FAILED', { itemId, errorCode });
  });
}

export async function retryFailedRunItems(runId: string): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `update run_items set state = 'PENDING', attempts = 0, available_at = now(),
         error_code = null, error_message = null, completed_at = null
       where benchmark_run_id = $1 and state = 'TERMINAL_FAILED'`,
      [runId],
    );
    const count = result.rowCount ?? 0;
    if (count) {
      await client.query('update benchmark_runs set failed_items = greatest(failed_items - $2, 0), updated_at = now() where id = $1', [runId, count]);
      await appendRunEvent(client, runId, 'RUN_ITEMS_RETRIED', { count });
    }
    return count;
  });
}

export async function getRunEventsAfter(runId: string, afterId = 0, limit = 200) {
  const { db } = await import('@/server/db/pool');
  const result = await db.query<{ id: string; event_type: string; payload: Record<string, unknown>; created_at: Date }>(
    `select id::text, event_type, payload, created_at from job_events
     where aggregate_type = 'benchmark_run' and aggregate_id = $1 and id > $2
     order by id limit $3`,
    [runId, afterId, limit],
  );
  return result.rows;
}

export async function recoverExpiredRunItemLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const recovered = await client.query<{ benchmark_run_id: string; terminal: boolean }>(
      `update run_items set
         state = case when attempts >= max_attempts then 'TERMINAL_FAILED' else 'RETRY_WAIT' end,
         available_at = now(), lease_owner = null, lease_expires_at = null,
         error_code = 'LEASE_EXPIRED', error_message = '워커 임대가 만료되었습니다.'
       where state = 'LEASED' and lease_expires_at < now()
       returning benchmark_run_id, attempts >= max_attempts as terminal`,
    );
    const byRun = new Map<string, { count: number; terminal: number }>();
    for (const row of recovered.rows) {
      const current = byRun.get(row.benchmark_run_id) ?? { count: 0, terminal: 0 };
      current.count += 1; if (row.terminal) current.terminal += 1; byRun.set(row.benchmark_run_id, current);
    }
    for (const [runId, summary] of byRun) {
      if (summary.terminal) await client.query('update benchmark_runs set failed_items = failed_items + $2 where id = $1', [runId, summary.terminal]);
      await appendRunEvent(client, runId, 'RUN_ITEM_LEASES_RECOVERED', summary);
    }
    return recovered.rowCount ?? 0;
  });
}

export async function beginScoringWhenExecutionFinished(runId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query<{ total_items: number; completed_items: number; failed_items: number; state: RunState }>(
      'select total_items, completed_items, failed_items, state from benchmark_runs where id = $1 for update', [runId],
    );
    const run = result.rows[0];
    if (!run || run.state !== 'RUNNING' || run.completed_items + run.failed_items < run.total_items) return false;
    await client.query("update benchmark_runs set state = 'SCORING', updated_at = now() where id = $1", [runId]);
    await appendRunEvent(client, runId, 'RUN_SCORING_STARTED', { completedItems: run.completed_items, failedItems: run.failed_items });
    return true;
  });
}

export async function finishCancellationWhenDrained(runId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const run = await client.query<{ state: RunState }>('select state from benchmark_runs where id = $1 for update', [runId]);
    if (run.rows[0]?.state !== 'CANCELLING') return false;
    await client.query("update run_items set state = 'CANCELLED', completed_at = now() where benchmark_run_id = $1 and state in ('PENDING','RETRY_WAIT')", [runId]);
    const active = await client.query<{ count: string }>("select count(*) from run_items where benchmark_run_id = $1 and state = 'LEASED'", [runId]);
    if (Number(active.rows[0]?.count) > 0) return false;
    await client.query("update benchmark_runs set state = 'CANCELLED', completed_at = now(), updated_at = now() where id = $1", [runId]);
    await appendRunEvent(client, runId, 'RUN_CANCELLED');
    return true;
  });
}
