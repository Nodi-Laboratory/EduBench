import path from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { db } from '@/server/db/pool';
import { hashPassword } from '@/server/auth/session';
import { claimJobs, completeJob } from '@/server/jobs/queue';
import { processDocument } from '@/server/documents/pipeline';
import { generateQuestions } from '@/server/questions/generator';
import { publishQuestionSet } from '@/server/question-sets/service';
import {
  beginScoringWhenExecutionFinished, claimRunItems, commandRun, createRun,
} from '@/server/runs/service';
import { executeRunItem } from '@/server/runs/executor';
import { scoreRun } from '@/server/scoring/service';
import { listResearchConfigProfiles } from '@/server/settings/research-profiles';
import { benchmarkGenerationParameters } from '@/domain/research-config';
import {
  PROVIDER_KEYS_HEADER, forgetProviderKeys, providerEnvFromKeys, rememberProviderKeys, type ProviderKeys,
} from '@/server/providers/credentials';
import { POST as uploadSource } from '@/app/api/sources/route';
import { POST as createGeneration } from '@/app/api/generation/route';
import { POST as reviewQuestion } from '@/app/api/questions/[id]/review/route';
import { DEMO_TEXTBOOKS, type DemoTextbook } from './demo-seed/textbooks';
import { DemoAnswerProvider, installFakeFetch, type FakeApiState } from './demo-seed/fake-apis';
import { buildDemoPdf } from './demo-seed/pdf';

/**
 * Demo seed: a demo account plus synthetic research data that goes through the
 * real pipeline (upload → parse → chunk/embed → generate → review → publish →
 * benchmark → judge). All external API calls are answered by local fakes in
 * ./demo-seed/fake-apis.ts, so no API key or network access is needed.
 * Set SEED_DEMO_DATA=false to create only the demo account.
 */

const isEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo1234';
// Placeholder values that only exist so the provider adapters can be built;
// the fake fetch answers every call before anything leaves the process.
const DEMO_KEYS: ProviderKeys = {
  gemini:'demo-seed-placeholder', upstage:'demo-seed-placeholder',
  openai:'demo-seed-placeholder', exaone:'demo-seed-placeholder',
  claude:'demo-seed-placeholder', midm:'demo-seed-placeholder',
};
const workerId = `demo-seed-${hostname()}-${process.pid}`;

function keyHeader(): Record<string, string> {
  return { [PROVIDER_KEYS_HEADER]: Buffer.from(JSON.stringify(DEMO_KEYS)).toString('base64url') };
}

async function ensureDemoUser() {
  const existing = await db.query('select 1 from users where username=$1', [DEMO_USERNAME]);
  if (existing.rowCount) return;
  await db.query(
    'insert into users(username, display_name, password_hash) values ($1, $2, $3) on conflict (username) do nothing',
    [DEMO_USERNAME, '데모 연구원', await hashPassword(DEMO_PASSWORD)],
  );
  console.log(`Created demo account ${DEMO_USERNAME} / ${DEMO_PASSWORD}`);
}

async function runJob(kind: 'document.parse' | 'question.generate', jobId: string, work: (lease: { jobId: string; workerId: string; attempt: number }) => Promise<Record<string, unknown>>) {
  const claimed = await claimJobs(workerId, 20, 10 * 60_000, [kind]);
  const job = claimed.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`DEMO_SEED: ${kind} 작업 ${jobId}을 claim하지 못했습니다.`);
  const lease = { jobId: job.id, workerId, attempt: job.attempts };
  const result = await work(lease);
  await completeJob(lease, result);
}

async function uploadTextbook(textbook: DemoTextbook, state: FakeApiState): Promise<string> {
  const pdf = buildDemoPdf(textbook.pages.map((page, index) => [
    `EduBench demo textbook (${textbook.key}) - synthetic content`,
    `Page ${index + 1}`,
  ]));
  const form = new FormData();
  form.set('file', new File([pdf as BlobPart], textbook.filename, { type:'application/pdf' }));
  form.set('subject', textbook.subject);
  form.set('grade', textbook.grade);
  const response = await uploadSource(new Request('http://localhost/api/sources', {
    method:'POST', headers:keyHeader(), body:form,
  }));
  const body = await response.json() as { id: string; jobId: string };
  if (!response.ok) throw new Error(`DEMO_SEED: 교재 업로드 실패 ${JSON.stringify(body)}`);
  state.textbook = textbook;
  await runJob('document.parse', body.jobId, (lease) => processDocument(body.id, { jobId: lease.jobId }));
  state.textbook = null;
  forgetProviderKeys(`source:${body.id}`);
  return body.id;
}

async function generate(sourceId: string, conditions: Record<string, unknown>): Promise<string> {
  const response = await createGeneration(new Request('http://localhost/api/generation', {
    method:'POST',
    headers:{ 'content-type':'application/json', ...keyHeader() },
    body:JSON.stringify({ sourceFileIds:[sourceId], tocEntryIds:[], crossUnit:false, executionMode:'sequential', ...conditions }),
  }));
  const body = await response.json() as { id: string; jobId?: string; job?: { id: string } };
  if (!response.ok) throw new Error(`DEMO_SEED: 생성 배치 실패 ${JSON.stringify(body)}`);
  const job = await db.query<{ id: string }>(
    "select id from jobs where kind='question.generate' and payload->>'batchId'=$1 order by created_at desc limit 1",
    [body.id],
  );
  await runJob('question.generate', job.rows[0]!.id, (lease) => generateQuestions(body.id, { lease }));
  forgetProviderKeys(`generation:${body.id}`);
  return body.id;
}

async function review(questionId: string, body: Record<string, unknown>) {
  const response = await reviewQuestion(
    new Request(`http://localhost/api/questions/${questionId}/review`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: questionId }) },
  );
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`DEMO_SEED: 검수 실패 ${JSON.stringify(result)}`);
  return result;
}

async function activeBenchmarkModels() {
  const profiles = await listResearchConfigProfiles('benchmark_models');
  const active = profiles.items.find((profile) => profile.id === profiles.activeByKind.benchmark_models);
  if (active?.definition.kind !== 'benchmark_models') throw new Error('DEMO_SEED: 활성 벤치마크 모델 프로필이 없습니다.');
  return active.definition.settings.models.filter((model) => model.enabled).map((model) => ({
    providerKey:model.providerKey,
    displayName:model.displayName,
    modelId:model.modelId,
    protocol:model.protocol,
    parameters:benchmarkGenerationParameters(model),
    concurrency:model.concurrency,
    requestIntervalMs:model.requestIntervalMs,
  }));
}

async function scoreProfileId(): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select id from score_profiles
      where score_profile_definition_usable(metrics,judge_provider,judge_model)
        and not metrics @> '["exact_match"]'::jsonb
      order by created_at desc limit 1`,
  );
  if (!result.rows[0]) throw new Error('DEMO_SEED: 사용 가능한 채점 프로필이 없습니다.');
  return result.rows[0].id;
}

async function executeRun(runId: string) {
  await commandRun(runId, 'QUEUE');
  await commandRun(runId, 'START');
  for (let round = 0; round < 500; round += 1) {
    const items = await claimRunItems(runId, workerId, 50, 60_000);
    if (!items.length) {
      const pending = await db.query<{ count: number }>(
        "select count(*)::int count from run_items where benchmark_run_id=$1 and state not in ('SUCCEEDED','TERMINAL_FAILED','CANCELLED')",
        [runId],
      );
      if (!pending.rows[0]?.count) break;
      // Per-model request pacing is meant for real providers; move the last
      // start times back so the seed does not wait on it.
      await db.query(
        "update run_items set last_attempt_started_at = last_attempt_started_at - interval '1 hour' where benchmark_run_id=$1 and last_attempt_started_at is not null",
        [runId],
      );
      continue;
    }
    await Promise.all(items.map(async (item) => {
      const model = await db.query<{ provider_key: string; model_id: string }>(
        'select provider_key, model_id from run_models where id=$1',
        [item.run_model_id],
      );
      const row = model.rows[0]!;
      await executeRunItem(item, workerId, new DemoAnswerProvider(row.provider_key, row.model_id));
    }));
  }
  await beginScoringWhenExecutionFinished(runId);
  for (let round = 0; round < 200; round += 1) {
    const state = await db.query<{ state: string }>('select state from benchmark_runs where id=$1', [runId]);
    if (state.rows[0]?.state !== 'SCORING') break;
    await scoreRun(runId);
  }
}

async function demoDataExists(): Promise<boolean> {
  const result = await db.query(
    'select 1 from source_files where original_name = any($1::text[]) limit 1',
    [DEMO_TEXTBOOKS.map((textbook) => textbook.filename)],
  );
  return Boolean(result.rowCount);
}

export async function seedDemo(): Promise<void> {
  await ensureDemoUser();
  if (process.env.SEED_DEMO_DATA?.toLowerCase() === 'false') return;
  if (await demoDataExists()) {
    console.log('Demo research data already present; skipping.');
    return;
  }
  // The demo data is produced by the real (non-mock) code paths.
  process.env.MOCK_PROVIDERS = 'false';
  process.env.EXAONE_BASE_URL ||= 'https://api.friendli.ai/serverless/v1';
  process.env.MIDM_BASE_URL ||= 'https://midm.invalid/v1';
  const state: FakeApiState = { textbook:null };
  const restoreFetch = installFakeFetch(state);
  try {
    const [scienceBook, mathBook] = DEMO_TEXTBOOKS as [DemoTextbook, DemoTextbook];
    const scienceId = await uploadTextbook(scienceBook, state);
    const mathId = await uploadTextbook(mathBook, state);
    console.log('Parsed demo textbooks');

    const scienceBatch = await generate(scienceId, {
      subject:'과학', grade:'중학교 2학년', purpose:'핵심 개념 이해', questionType:'구조화 서술형',
      difficulty:'중', direction:'선수 개념을 먼저 적용해야 목표 개념을 설명할 수 있는 문항을 만든다.',
      chunkCount:6, requestedCount:6,
    });
    const mathBatch = await generate(mathId, {
      subject:'수학', grade:'중학교 2학년', purpose:'개념 적용·문제풀이', questionType:'단답형',
      difficulty:'중', direction:'풀이 과정에서 선수 개념의 적용 여부가 드러나는 문항을 만든다.',
      chunkCount:6, requestedCount:6,
    });
    console.log('Generated demo questions');

    const questions = await db.query<{ id: string; generation_batch_id: string }>(
      'select id, generation_batch_id from questions where generation_batch_id = any($1::uuid[]) order by generation_batch_id, public_id',
      [[scienceBatch, mathBatch]],
    );
    let setId: string | null = null;
    for (const batch of [scienceBatch, mathBatch]) {
      const batchQuestions = questions.rows.filter((question) => question.generation_batch_id === batch);
      for (const [index, question] of batchQuestions.entries()) {
        if (index === batchQuestions.length - 1) continue; // left for the review screen
        if (index === batchQuestions.length - 2 && batch === mathBatch) {
          await review(question.id, { action:'HOLD', note:'풀이 단계 표현을 한 번 더 확인한다.' });
          continue;
        }
        const result = await review(question.id, {
          action:'APPROVE',
          targetSet:setId
            ? { kind:'existing', id:setId }
            : { kind:'new', title:'[데모] 중2 과학·수학 선수관계 문항 세트', description:'합성 교재에서 생성한 데모 문항입니다.' },
        });
        setId ??= (result.questionSet as { id: string } | undefined)?.id
          ?? (await db.query<{ id: string }>("select id from question_sets order by created_at desc limit 1")).rows[0]!.id;
      }
    }
    const dataset = await publishQuestionSet(setId!, {
      version:'demo-v1',
      title:'[데모] 중2 과학·수학 선수관계 데이터셋',
      description:'EduBench 데모용 합성 교재에서 생성·검수한 문항입니다. 실제 평가 결과로 사용할 수 없습니다.',
    });
    const datasetVersionId = (dataset as { id?: string; datasetVersionId?: string }).datasetVersionId
      ?? (dataset as { id: string }).id;
    console.log('Published demo dataset');

    const models = await activeBenchmarkModels();
    const profileId = await scoreProfileId();
    const baseRun = {
      datasetVersionId,
      scoreProfileId:profileId,
      priceProfileVersion:'manual-2026-07',
      systemPrompt:'주어진 질문에 정확하고 완결되게 답하며, 제공된 근거가 있는 조건에서는 그 근거에 충실하게 답한다.',
      providerEnv:providerEnvFromKeys(DEMO_KEYS),
    };
    const run = await createRun({
      ...baseRun,
      title:'[데모] 과학·수학 선수관계 비교 실행',
      models,
      retrievalModes:['NONE', 'VECTOR', 'PIKE'],
    });
    rememberProviderKeys(`run:${run.id}`, DEMO_KEYS);
    await executeRun(run.id);
    forgetProviderKeys(`run:${run.id}`);
    await createRun({
      ...baseRun,
      title:'[데모] RAG 조건 재실행 초안',
      models:models.slice(0, 2),
      retrievalModes:['VECTOR'],
    });
    console.log('Completed demo benchmark run');
  } finally {
    restoreFetch();
  }
}

if (isEntrypoint) {
  seedDemo()
    .then(async () => {
      await db.end();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await db.end();
      process.exitCode = 1;
    });
}
