import 'dotenv/config';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { migrate } from '@/server/db/migrate';
import { db } from '@/server/db/pool';
import { createRunProviderResolver } from '@/server/providers/registry';
import { processDocument, markDocumentFailed } from '@/server/documents/pipeline';
import { generateQuestions, markGenerationFailed } from '@/server/questions/generator';
import { classifyGenerationFailure } from '@/server/questions/failure';
import { claimJobs, completeJob, failJob, recoverExpiredLeases, withJobLeaseHeartbeat } from '@/server/jobs/queue';
import { scoreRun } from '@/server/scoring/service';
import { executeRunItem, providerErrorDetails } from '@/server/runs/executor';
import { DomainError } from '@/domain/errors';
import {
  beginScoringWhenExecutionFinished, claimRunItems, failRunItem, recoverExpiredRunItemLeases,
  finishCancellationWhenDrained, finishPauseWhenDrained, finishStopWhenDrained,
} from '@/server/runs/service';

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resolveRunProvider = createRunProviderResolver();
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

async function processBenchmarkRuns() {
  const runs = await db.query<{ id: string }>("select id from benchmark_runs where state = 'RUNNING' order by created_at limit 20");
  let processed = 0;
  for (const run of runs.rows) {
    const items = await claimRunItems(run.id, workerId, Number(process.env.WORKER_BATCH_SIZE ?? 8), 150_000);
    await Promise.all(items.map(async (item) => {
      const model = await db.query<{ provider_key: string; model_id:string }>(
        'select provider_key,model_id from run_models where id = $1',
        [item.run_model_id],
      );
      const providerKey = model.rows[0]?.provider_key ?? '';
      const modelId = model.rows[0]?.model_id ?? '';
      const provider = resolveRunProvider(providerKey, modelId);
      if (!provider) {
        await failRunItem(
          item.id,
          workerId,
          'PROVIDER_NOT_CONFIGURED',
          `${providerKey} / ${modelId} 모델을 위한 환경변수가 완전하지 않습니다.`,
        );
        return;
      }
      try { await executeRunItem(item, workerId, provider); }
      catch (error) {
        const detail = providerErrorDetails(error);
        await failRunItem(item.id, workerId, detail.code, detail.message);
      }
    }));
    processed += items.length;
    await beginScoringWhenExecutionFinished(run.id);
  }
  return processed;
}

async function processPersistentJobs() {
  const leaseMs = 10 * 60_000;
  const jobs = await claimJobs(workerId, 4, leaseMs, ['document.parse', 'question.generate']);
  await Promise.all(jobs.map(async (job) => {
    const lease = { jobId: job.id, workerId, attempt: job.attempts };
    try {
      const result = await withJobLeaseHeartbeat(lease, { leaseMs, heartbeatMs: job.kind === 'document.parse' ? 1_000 : undefined }, async (signal) => {
        if (job.kind === 'document.parse') return processDocument(String(job.payload.sourceId), { signal, jobId: job.id });
        if (job.kind === 'question.generate') {
          return generateQuestions(String(job.payload.batchId), {
            signal,
            lease,
          });
        }
        throw new Error(`UNKNOWN_JOB_KIND: ${job.kind}`);
      });
      await completeJob(lease, result);
    } catch (error) {
      let leaseLost = error instanceof DomainError && error.code === 'JOB_LEASE_MISMATCH';
      if (!leaseLost && job.kind === 'document.parse') await markDocumentFailed(String(job.payload.sourceId), error, job.id);
      if (!leaseLost && job.kind === 'question.generate') {
        try {
          await markGenerationFailed(String(job.payload.batchId), error, lease);
        } catch (reconciliationError) {
          if (reconciliationError instanceof DomainError && reconciliationError.code === 'JOB_LEASE_MISMATCH') {
            leaseLost = true;
          } else {
            console.error(`[EduBench worker] could not reconcile generation ${job.payload.batchId}`, reconciliationError);
          }
        }
      }
      const message = error instanceof Error ? error.message : '알 수 없는 작업 오류';
      try {
        if (!leaseLost) {
          const generationFailure = job.kind === 'question.generate'
            ? classifyGenerationFailure(error)
            : null;
          await failJob(lease, {
            code: generationFailure?.code ?? (message.split(':', 1)[0] || 'JOB_FAILED'),
            message,
            retryDelayMs: 5_000,
            retryable: generationFailure?.retryable,
          });
        }
      } catch (leaseError) {
        console.error(`[EduBench worker] could not record failure for job ${job.id}`, leaseError);
      }
    }
  }));
  return jobs.length;
}

async function processScoringRuns() {
  const runs = await db.query<{ id: string }>(
    `select id
     from benchmark_runs
     where state='SCORING'
       and (
         last_scoring_error->>'retryAt' is null
         or (last_scoring_error->>'retryAt')::timestamptz <= now()
       )
     order by updated_at
     limit 5`,
  );
  for (const run of runs.rows) {
    try {
      const result = await scoreRun(run.id);
      if (!result.claimed) continue;
    }
    catch (error) {
      console.error('[EduBench worker] scoring run failed', run.id, error);
    }
  }
  return runs.rowCount ?? 0;
}

async function processCancellations() {
  const runs = await db.query<{ id: string }>("select id from benchmark_runs where state = 'CANCELLING' order by updated_at limit 20");
  for (const run of runs.rows) await finishCancellationWhenDrained(run.id);
  return runs.rowCount ?? 0;
}

async function processRunControls() {
  const runs = await db.query<{ id: string; state: 'PAUSING' | 'STOPPING' }>(
    "select id,state from benchmark_runs where state in ('PAUSING','STOPPING') order by updated_at limit 20",
  );
  for (const run of runs.rows) {
    if (run.state === 'PAUSING') await finishPauseWhenDrained(run.id);
    else await finishStopWhenDrained(run.id);
  }
  return runs.rowCount ?? 0;
}

export async function main() {
  await migrate();
  let lastRecovery = 0;
  console.info(`[EduBench worker] started ${workerId}`);
  while (!stopping) {
    try {
      if (Date.now() - lastRecovery > 30_000) { await Promise.all([recoverExpiredRunItemLeases(), recoverExpiredLeases()]); lastRecovery = Date.now(); }
      const processed = (await processPersistentJobs()) + (await processBenchmarkRuns()) + (await processScoringRuns()) + (await processCancellations()) + (await processRunControls());
      if (!processed) await sleep(500);
    } catch (error) {
      console.error('[EduBench worker] loop recovered from error', error);
      await sleep(1_000);
    }
  }
  await db.end();
  console.info('[EduBench worker] stopped');
}

if (import.meta.url === new URL(`file://${process.argv[1]!.replace(/\\/g, '/')}`).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
