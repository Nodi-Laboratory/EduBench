import { rememberProviderKeys } from '@/server/providers/credentials';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  claimJobs,
  completeJob,
  enqueueJob,
} from '@/server/jobs/queue';
import { generateQuestions } from '@/server/questions/generator';
import { hashBenchmarkRetrievalSnapshot } from '@/domain/benchmark-retrieval';
import {
  ProviderError,
  type ModelProvider,
} from '@/server/providers/types';
import { executeRunItem } from '@/server/runs/executor';
import { resolveRunItemRetrieval } from '@/server/runs/retrieval';
import {
  registerBenchmarkProviderRateLimit,
} from '@/server/runs/provider-cooldown';
import {
  beginScoringWhenExecutionFinished,
  claimRunItems,
  commandRun,
  createRun,
  deferRunItemForProviderCooldown,
} from '@/server/runs/service';
import { scoreRun } from '@/server/scoring/service';
import { getResultAnalytics } from '@/server/results/analytics';
import { getResultDetails } from '@/server/results/details';
import { getRunItemDetails } from '@/server/runs/details';
import { resolveGenerationExecutionPins } from '@/server/settings/execution-pins';
import { GET as exportResult } from '@/app/api/results/[id]/export/route';
import { seedDatabase } from '../../scripts/seed';

const fixtureQuestionIds:string[] = [];

async function readResponseChunks(response:Response):Promise<string[]> {
  if (!response.body) throw new Error('내보내기 응답 본문이 없습니다.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks:string[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(decoder.decode(next.value, { stream:true }));
  }
  const remainder = decoder.decode();
  if (remainder) chunks.push(remainder);
  return chunks;
}

beforeAll(async () => {
  await migrate();
  await seedDatabase();
});

afterAll(async () => {
  if (fixtureQuestionIds.length) {
    await db.query(
      'delete from question_evidence where question_id=any($1::uuid[])',
      [fixtureQuestionIds],
    );
  }
  await db.end();
});

async function generatedDataset(): Promise<string> {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const batchId = randomUUID();
  await db.query(
    `insert into source_files(
       id,sha256,original_name,storage_path,mime_type,byte_size,status
     ) values(
       $1,$2,'benchmark-retrieval.pdf','fixture','application/pdf',10,'READY'
     )`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model)
     values($1,$2,1,'test')`,
    [revisionId, sourceId],
  );
  for (const [index, content] of [
    '속도는 위치의 시간에 따른 변화이다.',
    '가속도는 속도의 시간에 따른 변화율이다.',
    '힘은 물체의 운동 상태를 변화시킨다.',
  ].entries()) {
    await db.query(
      `insert into source_chunks(
         source_file_id,source_revision_id,ordinal,content,page_start,unit
       ) values($1,$2,$3,$4,$3,'역학')`,
      [sourceId, revisionId, index + 1, content],
    );
  }
  await db.query(
    `insert into generation_batches(
       id,requested_count,conditions,source_scope,generation_model,prompt_version
     ) values($1,1,$2::jsonb,$3::jsonb,'mock-gemini','test')`,
    [
      batchId,
      JSON.stringify({
        subject:'과학',
        grade:'고등학교 1학년',
        units:['역학'],
        purpose:'선수관계 측정',
        questionType:'구조화 서술형',
        difficulty:'상',
        direction:'선수관계를 측정',
        chunkCount:3,
        executionMode:'sequential',
      }),
      JSON.stringify({
        sourceFileIds:[sourceId],
        sourceRevisionIds:[revisionId],
        tocEntryIds:[],
      }),
    ],
  );
  const job = await enqueueJob({
    kind:'question.generate',
    payload:{ batchId },
    idempotencyKey:`benchmark-retrieval:${batchId}`,
    maxAttempts:4,
    priority:1,
  });
  const workerId = `generation-${batchId}`;
  const claimed = await claimJobs(
    workerId,
    20,
    60_000,
    ['question.generate'],
  );
  const lease = claimed.find((candidate) => candidate.id === job.id);
  if (!lease) throw new Error('생성 작업을 claim하지 못했습니다.');
  const generated = await generateQuestions(batchId, {
    lease:{
      jobId:lease.id,
      workerId,
      attempt:lease.attempts,
    },
  });
  await completeJob(
    {
      jobId:lease.id,
      workerId,
      attempt:lease.attempts,
    },
    generated,
  );

  const question = await db.query<{ id:string }>(
    `update questions
        set status='APPROVED'
      where generation_batch_id=$1
      returning id`,
    [batchId],
  );
  const questionId = question.rows[0]!.id;
  fixtureQuestionIds.push(questionId);
  const datasetId = randomUUID();
  await db.query(
    `insert into dataset_versions(
       id,version,status,title,question_count,distribution,content_hash
     ) values($1,$2,'DRAFT','검색 조건 통합 테스트',1,$3::jsonb,$4)`,
    [
      datasetId,
      `retrieval-${randomUUID().slice(0, 8)}`,
      JSON.stringify({
        capabilities:{ '선수관계 측정':1 },
        responseFormats:{ '구조화 서술형':1 },
        evidenceModes:{ GROUNDED:1 },
      }),
      randomUUID().replaceAll('-', ''),
    ],
  );
  await db.query(
    `insert into dataset_questions(
       dataset_version_id,question_id,question_revision,ordinal
     ) values($1,$2,1,1)`,
    [datasetId, questionId],
  );
  await db.query(
    `update dataset_versions
        set status='PUBLISHED',published_at=now()
      where id=$1`,
    [datasetId],
  );
  return datasetId;
}

async function datasetRetrievalFixture(datasetVersionId:string):Promise<{
  generationBatchId:string;
  chunkIds:string[];
}> {
  const result = await db.query<{
    generation_batch_id:string;
    chunk_id:string;
  }>(
    `select question.generation_batch_id,chunk.id chunk_id
       from dataset_questions dataset_question
       join questions question on question.id=dataset_question.question_id
       join generation_batches batch on batch.id=question.generation_batch_id
       join source_chunks chunk
         on chunk.source_revision_id=any(
           array(
             select jsonb_array_elements_text(
               batch.source_scope->'sourceRevisionIds'
             )::uuid
           )
         )
      where dataset_question.dataset_version_id=$1
      order by chunk.ordinal`,
    [datasetVersionId],
  );
  return {
    generationBatchId:result.rows[0]!.generation_batch_id,
    chunkIds:result.rows.map((row) => row.chunk_id),
  };
}

async function prioritizeLastChunkInQuestionGraph(
  datasetVersionId:string,
):Promise<string[]> {
  const fixture = await datasetRetrievalFixture(datasetVersionId);
  const lastChunkId = fixture.chunkIds.at(-1)!;
  const revision = await db.query<{
    id:string;
    quality_scores:Record<string, unknown>;
  }>(
    `select revision.id,revision.quality_scores
       from dataset_questions dataset_question
       join question_revisions revision
         on revision.question_id=dataset_question.question_id
        and revision.revision=dataset_question.question_revision
      where dataset_question.dataset_version_id=$1`,
    [datasetVersionId],
  );
  const qualityScores = structuredClone(
    revision.rows[0]!.quality_scores,
  );
  const design = qualityScores.benchmarkDesign as {
    prerequisiteConcepts?:Array<Record<string, unknown>>;
    prerequisiteRelations?:Array<Record<string, unknown>>;
  };
  for (const concept of design.prerequisiteConcepts ?? []) {
    concept.evidenceChunkIds = [lastChunkId];
  }
  for (const relation of design.prerequisiteRelations ?? []) {
    relation.evidenceChunkIds = [lastChunkId];
  }
  await db.query(
    'update question_revisions set quality_scores=$2::jsonb where id=$1',
    [revision.rows[0]!.id, JSON.stringify(qualityScores)],
  );
  return fixture.chunkIds;
}

test('executes 일반, RAG, and Pike with distinct prompts and immutable retrieval audits', async () => {
  const datasetVersionId = await generatedDataset();
  const sourceChunkIds = await prioritizeLastChunkInQuestionGraph(
    datasetVersionId,
  );
  const run = await createRun({
    title:`세 검색 조건 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'질문에 답하라.',
    questionLimit:1,
    retrievalModes:['NONE', 'VECTOR', 'PIKE'],
    models:[{
      providerKey:'fake',
      displayName:'가상 모델',
      modelId:'fake-retrieval-v1',
      protocol:'openai-compatible',
      concurrency:3,
    }],
  });
  const generationPins = await db.query<{
    generation_retrieval_id:string | null;
    expected_retrieval_id:string | null;
  }>(
    `select item.generation_retrieval_id,
       (
         select retrieval.id
           from generation_retrievals retrieval
          where retrieval.generation_item_id=question.generation_item_id
          order by retrieval.attempt desc,retrieval.created_at desc
          limit 1
       ) expected_retrieval_id
       from run_items item
       join questions question on question.id=item.question_id
      where item.benchmark_run_id=$1`,
    [run.id],
  );
  expect(generationPins.rows).toHaveLength(3);
  expect(generationPins.rows.every((pin) =>
    pin.generation_retrieval_id !== null
    && pin.generation_retrieval_id === pin.expected_retrieval_id,
  )).toBe(true);
  await expect(db.query(
    `update run_items set generation_retrieval_id=null
      where benchmark_run_id=$1`,
    [run.id],
  )).rejects.toThrow(/generation retrieval pin is immutable/);
  await db.query(
    `update questions question
        set generation_batch_id=null,generation_item_id=null
       from run_items item
      where item.benchmark_run_id=$1
        and item.question_id=question.id`,
    [run.id],
  );
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const items = await claimRunItems(
    run.id,
    'retrieval-worker',
    3,
    30_000,
  );
  expect(items).toHaveLength(3);

  const prompts = new Map<string, string>();
  const provider:ModelProvider = {
    key:'fake',
    modelId:'fake-retrieval-v1',
    async generate() {
      return {
        text:'정답',
        raw:{ ok:true },
        inputTokens:10,
        outputTokens:2,
        finishReason:'stop',
        requestId:randomUUID(),
        modelId:'fake-retrieval-v1',
        modelSnapshot:null,
        latencyMs:1,
      };
    },
  };
  for (const item of items) {
    const capturingProvider:ModelProvider = {
      ...provider,
      async generate(request, signal) {
        prompts.set(item.retrieval_mode, request.prompt);
        return provider.generate(request, signal);
      },
    };
    await executeRunItem(item, 'retrieval-worker', capturingProvider);
  }

  expect(prompts.get('NONE')).toContain('모델 자체 지식만 사용');
  expect(prompts.get('NONE')).not.toContain('속도는 위치의 시간에 따른 변화');
  expect(prompts.get('VECTOR')).toContain('단순 벡터 검색으로 찾은 교과서 근거');
  expect(prompts.get('VECTOR')).toContain('속도는 위치의 시간에 따른 변화');
  expect(prompts.get('PIKE')).toContain(
    'Pike-inspired 생성 그래프 스냅샷에서 재사용·재정렬한 교과서 근거',
  );
  expect(prompts.get('PIKE')).not.toContain('그래프로 선택한');

  const audits = await db.query<{
    retrieval_mode:string;
    query_text:string | null;
    selected_count:number;
    graph_applied:boolean | null;
    selected_chunks:Array<{ chunkId:string }>;
    graph_trace:{ graphCitedChunkIds?:string[] };
  }>(
    `select retrieval.retrieval_mode,retrieval.query_text,
       jsonb_array_length(retrieval.selected_chunks) selected_count,
       (retrieval.graph_trace->>'graphApplied')::boolean graph_applied,
       retrieval.selected_chunks,retrieval.graph_trace
       from run_item_retrievals retrieval
       join run_items item on item.id=retrieval.run_item_id
      where item.benchmark_run_id=$1
      order by retrieval_mode`,
    [run.id],
  );
  expect(audits.rows).toEqual([
    expect.objectContaining({
      retrieval_mode:'NONE',
      query_text:null,
      selected_count:0,
      graph_applied:null,
    }),
    expect.objectContaining({
      retrieval_mode:'PIKE',
      query_text:expect.any(String),
      selected_count:3,
      graph_applied:true,
    }),
    expect.objectContaining({
      retrieval_mode:'VECTOR',
      query_text:expect.stringContaining('질문:'),
      selected_count:3,
      graph_applied:null,
    }),
  ]);
  const vectorAudit = audits.rows.find(
    (audit) => audit.retrieval_mode === 'VECTOR',
  )!;
  const pikeAudit = audits.rows.find(
    (audit) => audit.retrieval_mode === 'PIKE',
  )!;
  expect(vectorAudit.selected_chunks.map((chunk) => chunk.chunkId))
    .toEqual(sourceChunkIds);
  expect(pikeAudit.selected_chunks.map((chunk) => chunk.chunkId))
    .toEqual([
      sourceChunkIds.at(-1),
      ...sourceChunkIds.slice(0, -1),
    ]);
  expect(pikeAudit.graph_trace.graphCitedChunkIds)
    .toEqual([sourceChunkIds.at(-1)]);

  expect(await beginScoringWhenExecutionFinished(run.id)).toBe(true);
  await scoreRun(run.id);
  const analytics = await getResultAnalytics(run.id);
  expect(analytics.retrievalModes).toEqual(['NONE', 'VECTOR', 'PIKE']);
  expect(analytics.models.map((model) => model.seriesKey).sort()).toEqual([
    'M01::NONE',
    'M01::PIKE',
    'M01::VECTOR',
  ]);
  const details = await getResultDetails(run.id);
  expect(details?.models.map((model) => model.retrievalMode).sort()).toEqual([
    'NONE',
    'PIKE',
    'VECTOR',
  ]);
  const exported = await exportResult(
    new Request(
      `http://localhost/api/results/${run.id}/export?format=json&modes=NONE,PIKE`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  expect(exported.status).toBe(200);
  const exportBody = await exported.json();
  expect(exportBody.selectedRetrievalModes).toEqual(['NONE', 'PIKE']);
  expect(exportBody.items.map(
    (item:{ retrieval_mode:string }) => item.retrieval_mode,
  ).sort()).toEqual(['NONE', 'PIKE']);
  await db.query(
    `update run_items set state='TERMINAL_FAILED'
      where benchmark_run_id=$1 and retrieval_mode='VECTOR'`,
    [run.id],
  );
  await db.query(
    'update benchmark_runs set failed_items=1 where id=$1',
    [run.id],
  );
  const failureFiltered = await exportResult(
    new Request(
      `http://localhost/api/results/${run.id}/export?format=json&modes=NONE,PIKE`,
    ),
    { params:Promise.resolve({ id:run.id }) },
  );
  const failureFilteredBody = await failureFiltered.json();
  expect(failureFilteredBody.run).toMatchObject({
    failed_items:1,
    selected_failed_items:0,
  });
});

test('uses verified production embeddings and cosine order for simple VECTOR retrieval', async () => {
  const datasetVersionId = await generatedDataset();
  const fixture = await datasetRetrievalFixture(datasetVersionId);
  const pins = await resolveGenerationExecutionPins(
    fixture.generationBatchId,
  );
  const dimensions = pins.embeddingRag.definition.settings.dimensions;
  const vectors = fixture.chunkIds.map((_chunkId, index) => {
    const vector = Array<number>(dimensions).fill(0);
    if (index === 0) vector[1] = 1;
    else if (index === 1) vector[0] = 1;
    else vector[0] = -1;
    return `[${vector.join(',')}]`;
  });
  for (const [index, chunkId] of fixture.chunkIds.entries()) {
    await db.query(
      'update source_chunks set embedding=$2::vector where id=$1',
      [chunkId, vectors[index]],
    );
  }
  const run = await createRun({
    title:`실벡터 검색 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'질문에 답하라.',
    retrievalModes:['VECTOR'],
    models:[
      {
        providerKey:'fake-a',
        displayName:'가상 모델 A',
        modelId:'fake-vector-order-a-v1',
        protocol:'openai-compatible',
      },
      {
        providerKey:'fake-b',
        displayName:'가상 모델 B',
        modelId:'fake-vector-order-b-v1',
        protocol:'openai-compatible',
      },
    ],
  });
  const items = await db.query<{ id:string }>(
    'select id from run_items where benchmark_run_id=$1 order by id',
    [run.id],
  );
  const queryVector = Array<number>(dimensions).fill(0);
  queryVector[0] = 1;
  const previousMock = process.env.MOCK_PROVIDERS;
  const previousKey = process.env.GOOGLE_API_KEY;
  process.env.MOCK_PROVIDERS = 'false';
  rememberProviderKeys(`run:${run.id}`, { gemini:'integration-test-key' });
  let fetchCalls = 0;
  let signalEmbeddingStarted!:() => void;
  const embeddingStarted = new Promise<void>((resolve) => {
    signalEmbeddingStarted = resolve;
  });
  let releaseEmbedding!:() => void;
  const embeddingRelease = new Promise<void>((resolve) => {
    releaseEmbedding = resolve;
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(
          JSON.stringify({ error:{ message:'temporary' } }),
          { status:503, headers:{ 'content-type':'application/json' } },
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        requests:Array<{ content:{ parts:Array<{ text:string }> } }>;
      };
      expect(body.requests[0]?.content.parts[0]?.text)
        .toContain('질문:');
      signalEmbeddingStarted();
      await embeddingRelease;
      return new Response(
        JSON.stringify({
          embeddings:[{ values:queryVector }],
        }),
        { status:200, headers:{ 'content-type':'application/json' } },
      );
    },
  );
  const poolBlockers:PoolClient[] = [];
  let retrievalPromise:
    | Promise<Awaited<ReturnType<typeof resolveRunItemRetrieval>>[]>
    | undefined;
  let poolProbe:Promise<unknown> | undefined;
  try {
    const poolSize = db.options.max ?? 10;
    for (let index = 0; index < poolSize - 1; index += 1) {
      poolBlockers.push(await db.connect());
    }
    retrievalPromise = Promise.all(
      items.rows.map((item) => resolveRunItemRetrieval(item.id)),
    );
    await embeddingStarted;
    poolProbe = db.query('select 1');
    const poolStayedAvailable = await Promise.race([
      poolProbe.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    releaseEmbedding();
    const retrievals = await retrievalPromise;
    await poolProbe;

    expect(poolStayedAvailable).toBe(true);
    expect(fetchCalls).toBe(2);
    for (const retrieval of retrievals) {
      expect(retrieval.selectedChunks.map((chunk) => chunk.chunkId))
        .toEqual([
        fixture.chunkIds[1],
        fixture.chunkIds[0],
        fixture.chunkIds[2],
        ]);
      expect(retrieval.candidateScope.queryVector)
        .toMatchObject({ dimensions, taskType:'RETRIEVAL_QUERY' });
      expect(hashBenchmarkRetrievalSnapshot(retrieval.configSnapshot))
        .toBe(retrieval.configHash);
    }
    expect(new Set(retrievals.map((retrieval) => retrieval.contextHash)))
      .toHaveLength(1);
    const sharedRetrievals = retrievals.filter(
      (retrieval) => retrieval.sharedFromRetrievalId !== null,
    );
    expect(sharedRetrievals).toHaveLength(1);
    const rootRetrieval = retrievals.find(
      (retrieval) => retrieval.sharedFromRetrievalId === null,
    )!;
    expect(sharedRetrievals[0]!.sharedFromRetrievalId)
      .toBe(rootRetrieval.id);
    expect(new Set(retrievals.map(
      (retrieval) => retrieval.sharedSnapshotKey,
    ))).toEqual(new Set([rootRetrieval.sharedSnapshotKey]));
    const receipts = await db.query<{
      id:string;
      shared_from_retrieval_id:string | null;
      candidate_scope:unknown;
      selected_chunks:unknown;
      graph_trace:unknown;
      config_snapshot:unknown;
      config_hash:string | null;
      rendered_context:string | null;
      context_hash:string | null;
    }>(
      `select id,shared_from_retrieval_id,candidate_scope,selected_chunks,
              graph_trace,config_snapshot,config_hash,rendered_context,
              context_hash
         from run_item_retrievals
        where run_item_id=any($1::uuid[])
        order by created_at,id`,
      [items.rows.map((item) => item.id)],
    );
    const lightweightReceipt = receipts.rows.find(
      (receipt) => receipt.shared_from_retrieval_id !== null,
    );
    expect(lightweightReceipt).toMatchObject({
      shared_from_retrieval_id:rootRetrieval.id,
      candidate_scope:null,
      selected_chunks:null,
      graph_trace:null,
      config_snapshot:null,
      config_hash:null,
      rendered_context:null,
      context_hash:null,
    });
    if (!lightweightReceipt) {
      throw new Error('공유 검색 영수증이 생성되지 않았습니다.');
    }
    const jsonExport = await exportResult(
      new Request(
        `http://localhost/api/results/${run.id}/export?format=json`,
      ),
      { params:Promise.resolve({ id:run.id }) },
    );
    const jsonChunks = await readResponseChunks(jsonExport);
    expect(jsonChunks.length).toBeGreaterThan(1);
    const jsonBody = JSON.parse(jsonChunks.join('')) as {
      items:Array<Record<string, unknown>>;
    };
    const exportedRoot = jsonBody.items.find(
      (item) => item.retrieval_audit_id === rootRetrieval.id,
    );
    const exportedReceipt = jsonBody.items.find(
      (item) => item.retrieval_audit_id === lightweightReceipt.id,
    );
    const canonicalAudit = {
      retrieval_mode:rootRetrieval.mode,
      retrieval_query:rootRetrieval.queryText,
      retrieval_embedding_model:rootRetrieval.embeddingModel,
      retrieval_embedding_profile_hash:rootRetrieval.embeddingProfileHash,
      retrieval_vector_space_id:rootRetrieval.vectorSpaceId,
      retrieval_candidate_scope:rootRetrieval.candidateScope,
      retrieval_selected_chunks:rootRetrieval.selectedChunks,
      retrieval_graph_trace:rootRetrieval.graphTrace,
      retrieval_config_snapshot:rootRetrieval.configSnapshot,
      retrieval_config_hash:rootRetrieval.configHash,
      retrieval_rendered_context:rootRetrieval.renderedContext,
      retrieval_context_hash:rootRetrieval.contextHash,
      retrieval_shared_snapshot_key:rootRetrieval.sharedSnapshotKey,
      retrieval_root_audit_id:rootRetrieval.id,
    };
    expect(exportedRoot).toMatchObject({
      ...canonicalAudit,
      retrieval_shared_from_retrieval_id:null,
    });
    expect(exportedReceipt).toMatchObject({
      ...canonicalAudit,
      retrieval_shared_from_retrieval_id:rootRetrieval.id,
    });

    const csvExport = await exportResult(
      new Request(
        `http://localhost/api/results/${run.id}/export?format=csv`,
      ),
      { params:Promise.resolve({ id:run.id }) },
    );
    const csvChunks = await readResponseChunks(csvExport);
    expect(csvChunks.length).toBeGreaterThan(1);
    const csvHeader = csvChunks.join('').slice(1).split('\r\n', 1)[0]!;
    expect(csvHeader.split(',')).toEqual(expect.arrayContaining([
      'retrieval_embedding_model',
      'retrieval_embedding_profile_hash',
      'retrieval_vector_space_id',
      'retrieval_config_snapshot',
      'retrieval_rendered_context',
      'retrieval_root_audit_id',
    ]));

    const receiptSource = await db.query<{
      benchmark_run_id:string;
      question_id:string;
      question_revision:number;
    }>(
      `select benchmark_run_id,question_id,question_revision
         from run_items
        where id=$1`,
      [items.rows[0]!.id],
    );
    const rootSnapshotKey = rootRetrieval.sharedSnapshotKey;
    if (!rootSnapshotKey) {
      throw new Error('공유 검색 스냅샷 키가 생성되지 않았습니다.');
    }
    const defensiveModel = await db.query<{ id:string }>(
      `insert into run_models(
         benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
       ) values($1,$2,'receipt claim 방어','M97','fake-claim-receipt','test')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        `fake-claim-receipt-${randomUUID()}`,
      ],
    );
    const defensiveItem = await db.query<{ id:string }>(
      `insert into run_items(
         benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values($1,$2,$3,$4,$5,'VECTOR')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        defensiveModel.rows[0]!.id,
        receiptSource.rows[0]!.question_id,
        receiptSource.rows[0]!.question_revision,
        `claim-receipt-defense:${randomUUID()}`,
      ],
    );
    await db.query(
      'alter table benchmark_retrieval_snapshot_claims disable trigger user',
    );
    try {
      await db.query(
        `update benchmark_retrieval_snapshot_claims
            set root_retrieval_id=$2
          where snapshot_key=$1`,
        [rootSnapshotKey, lightweightReceipt.id],
      );
    } finally {
      await db.query(
        'alter table benchmark_retrieval_snapshot_claims enable trigger user',
      );
    }
    const defensivelyCloned = await resolveRunItemRetrieval(
      defensiveItem.rows[0]!.id,
    );
    expect(defensivelyCloned.sharedFromRetrievalId).toBe(rootRetrieval.id);
    await db.query(
      `update benchmark_retrieval_snapshot_claims
          set root_retrieval_id=$2
        where snapshot_key=$1`,
      [rootSnapshotKey, rootRetrieval.id],
    );

    const extraModel = await db.query<{ id:string }>(
      `insert into run_models(
         benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
       ) values($1,$2,'직접 루트 제약 검증','M99','fake-direct-root','test')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        `fake-direct-root-${randomUUID()}`,
      ],
    );
    const extraItem = await db.query<{ id:string }>(
      `insert into run_items(
         benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values($1,$2,$3,$4,$5,'VECTOR')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        extraModel.rows[0]!.id,
        receiptSource.rows[0]!.question_id,
        receiptSource.rows[0]!.question_revision,
        `direct-root:${randomUUID()}`,
      ],
    );
    await expect(db.query(
      `insert into run_item_retrievals(
         run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key,
         shared_from_retrieval_id
       ) values(
         $1,'VECTOR',null,null,null,null,null,null,null,null,null,null,null,$2,$3
       )`,
      [extraItem.rows[0]!.id, 'f'.repeat(64), rootRetrieval.id],
    )).rejects.toThrow(/metadata must match its root/);
    await expect(db.query(
      `insert into run_item_retrievals(
         run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_from_retrieval_id
       ) values(
         $1,'VECTOR',null,null,null,null,null,null,null,null,null,null,null,$2
       )`,
      [extraItem.rows[0]!.id, lightweightReceipt.id],
    )).rejects.toThrow(/direct payload-bearing root/);

    const differentModeItem = await db.query<{ id:string }>(
      `insert into run_items(
         benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values($1,$2,$3,$4,$5,'PIKE')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        extraModel.rows[0]!.id,
        receiptSource.rows[0]!.question_id,
        receiptSource.rows[0]!.question_revision,
        `direct-root-mode:${randomUUID()}`,
      ],
    );
    await expect(db.query(
      `insert into run_item_retrievals(
         run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key,
         shared_from_retrieval_id
       ) values(
         $1,'PIKE',null,null,null,null,null,null,null,null,null,null,null,$2,$3
       )`,
      [differentModeItem.rows[0]!.id, rootSnapshotKey, rootRetrieval.id],
    )).rejects.toThrow(/metadata must match its root/);

    const differentIdentityModel = await db.query<{ id:string }>(
      `insert into run_models(
         benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
       ) values($1,$2,'루트 범위 제약 검증','M98','fake-root-scope','test')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        `fake-root-scope-${randomUUID()}`,
      ],
    );
    const differentIdentityItem = await db.query<{ id:string }>(
      `insert into run_items(
         benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values($1,$2,$3,$4 + 1,$5,'VECTOR')
       returning id`,
      [
        receiptSource.rows[0]!.benchmark_run_id,
        differentIdentityModel.rows[0]!.id,
        receiptSource.rows[0]!.question_id,
        receiptSource.rows[0]!.question_revision,
        `direct-root-identity:${randomUUID()}`,
      ],
    );
    await expect(db.query(
      `insert into run_item_retrievals(
         run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key,
         shared_from_retrieval_id
       ) values(
         $1,'VECTOR',null,null,null,null,null,null,null,null,null,null,null,$2,$3
       )`,
      [
        differentIdentityItem.rows[0]!.id,
        rootSnapshotKey,
        rootRetrieval.id,
      ],
    )).rejects.toThrow(/item identity must match its root/);

    const snapshotClaims = await db.query<{
      snapshot_key:string;
      state:string;
      owner_id:string | null;
      lease_expires_at:Date | null;
      root_retrieval_id:string | null;
      error_snapshot:unknown;
    }>(
      `select snapshot_key,state,owner_id,lease_expires_at,
         root_retrieval_id,error_snapshot
         from benchmark_retrieval_snapshot_claims
        where benchmark_run_id=$1
          and retrieval_mode='VECTOR'`,
      [run.id],
    );
    expect(snapshotClaims.rows).toEqual([{
      snapshot_key:rootRetrieval.sharedSnapshotKey,
      state:'READY',
      owner_id:null,
      lease_expires_at:null,
      root_retrieval_id:rootRetrieval.id,
      error_snapshot:null,
    }]);
  } finally {
    releaseEmbedding();
    for (const blocker of poolBlockers) blocker.release();
    await Promise.allSettled([
      ...(retrievalPromise ? [retrievalPromise] : []),
      ...(poolProbe ? [poolProbe] : []),
    ]);
    fetchSpy.mockRestore();
    if (previousMock === undefined) delete process.env.MOCK_PROVIDERS;
    else process.env.MOCK_PROVIDERS = previousMock;
    if (previousKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousKey;
  }
});

test('lets a healthy waiter take over when only the retrieval owner is aborted', async () => {
  const datasetVersionId = await generatedDataset();
  const fixture = await datasetRetrievalFixture(datasetVersionId);
  const pins = await resolveGenerationExecutionPins(
    fixture.generationBatchId,
  );
  const dimensions = pins.embeddingRag.definition.settings.dimensions;
  const queryVector = Array<number>(dimensions).fill(0);
  queryVector[0] = 1;
  for (const [index, chunkId] of fixture.chunkIds.entries()) {
    const vector = Array<number>(dimensions).fill(0);
    vector[index === 0 ? 1 : 0] = index === 2 ? -1 : 1;
    await db.query(
      'update source_chunks set embedding=$2::vector where id=$1',
      [chunkId, `[${vector.join(',')}]`],
    );
  }
  const run = await createRun({
    title:`검색 소유권 인계 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'질문에 답하라.',
    retrievalModes:['VECTOR'],
    models:[
      {
        providerKey:'fake-owner',
        displayName:'중단 소유자',
        modelId:'fake-owner-v1',
        protocol:'openai-compatible',
      },
      {
        providerKey:'fake-waiter',
        displayName:'정상 대기자',
        modelId:'fake-waiter-v1',
        protocol:'openai-compatible',
      },
    ],
  });
  const items = await db.query<{ id:string }>(
    'select id from run_items where benchmark_run_id=$1 order by id',
    [run.id],
  );
  const previousMock = process.env.MOCK_PROVIDERS;
  const previousKey = process.env.GOOGLE_API_KEY;
  process.env.MOCK_PROVIDERS = 'false';
  rememberProviderKeys(`run:${run.id}`, { gemini:'integration-test-key' });
  const ownerController = new AbortController();
  let signalOwnerStarted!:() => void;
  const ownerStarted = new Promise<void>((resolve) => {
    signalOwnerStarted = resolve;
  });
  let fetchCalls = 0;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        signalOwnerStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal;
          const onAbort = () => reject(
            requestSignal?.reason
              ?? new DOMException('aborted', 'AbortError'),
          );
          if (requestSignal?.aborted) onAbort();
          else requestSignal?.addEventListener(
            'abort',
            onAbort,
            { once:true },
          );
        });
      }
      return new Response(
        JSON.stringify({
          embeddings:[{ values:queryVector }],
        }),
        { status:200, headers:{ 'content-type':'application/json' } },
      );
    },
  );
  try {
    const ownerResult = resolveRunItemRetrieval(
      items.rows[0]!.id,
      ownerController.signal,
    ).then(
      () => null,
      (error:unknown) => error,
    );
    await ownerStarted;
    const ownerClaim = await db.query<{
      snapshot_key:string;
      owner_id:string;
    }>(
      `select snapshot_key,owner_id
         from benchmark_retrieval_snapshot_claims
        where benchmark_run_id=$1 and retrieval_mode='VECTOR'`,
      [run.id],
    );
    ownerController.abort(new Error('owner worker stopped'));
    expect(await ownerResult).toMatchObject({
      message:'owner worker stopped',
    });
    const staleHeartbeat = await db.query(
      `update benchmark_retrieval_snapshot_claims
          set lease_expires_at=$3,updated_at=now()
        where snapshot_key=$1
          and state='COMPUTING'
          and owner_id=$2
          and lease_expires_at>now()`,
      [
        ownerClaim.rows[0]!.snapshot_key,
        ownerClaim.rows[0]!.owner_id,
        new Date(Date.now() + 150_000),
      ],
    );
    expect(staleHeartbeat.rowCount).toBe(0);
    const waiterResult = resolveRunItemRetrieval(items.rows[1]!.id);
    const retrieval = await waiterResult;
    expect(retrieval.mode).toBe('VECTOR');
    expect(fetchCalls).toBe(2);
    const claim = await db.query<{
      state:string;
      root_retrieval_id:string | null;
      error_snapshot:unknown;
    }>(
      `select state,root_retrieval_id,error_snapshot
         from benchmark_retrieval_snapshot_claims
        where benchmark_run_id=$1 and retrieval_mode='VECTOR'`,
      [run.id],
    );
    expect(claim.rows).toEqual([{
      state:'READY',
      root_retrieval_id:retrieval.id,
      error_snapshot:null,
    }]);
  } finally {
    fetchSpy.mockRestore();
    if (previousMock === undefined) delete process.env.MOCK_PROVIDERS;
    else process.env.MOCK_PROVIDERS = previousMock;
    if (previousKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousKey;
  }
});

test('treats Gemini embedding cooldown as a VECTOR run-item dependency', async () => {
  const datasetVersionId = await generatedDataset();
  const run = await createRun({
    title:`벡터 임베딩 대기 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'질문에 답하라.',
    questionLimit:1,
    retrievalModes:['VECTOR'],
    models:[{
      providerKey:'fake',
      displayName:'Gemini 외 모델',
      modelId:'fake-vector-candidate-v1',
      protocol:'openai-compatible',
      concurrency:1,
    }],
  });
  await commandRun(run.id, 'QUEUE');
  await commandRun(run.id, 'START');
  const [item] = await claimRunItems(
    run.id,
    'vector-cooldown-worker',
    1,
    30_000,
  );
  expect(item).toBeDefined();
  const cooldown = await registerBenchmarkProviderRateLimit({
    providerKey:'gemini',
    error:new ProviderError({
      kind:'RATE_LIMIT',
      message:'Gemini embedding RPM exhausted',
      retryable:true,
      status:429,
      requestId:'embedding-quota-1',
      retryAfterMs:60_000,
      rateLimitDimension:'RPM',
      rateLimitScope:'embed_content_requests_per_minute',
    }),
    sourceRunId:run.id,
    sourceRunItemId:item!.id,
    sourcePhase:'ANSWER_RETRIEVAL_EMBEDDING',
  });
  try {
    await expect(
      deferRunItemForProviderCooldown(
        item!.id,
        'vector-cooldown-worker',
        cooldown,
      ),
    ).resolves.toBe(true);
    await db.query(
      'update run_items set available_at=now() where id=$1',
      [item!.id],
    );
    expect(
      await claimRunItems(
        run.id,
        'vector-cooldown-blocked-worker',
        1,
        30_000,
      ),
    ).toEqual([]);
    const details = await getRunItemDetails(run.id, item!.id);
    expect(details?.item.request).toBeNull();
  } finally {
    await db.query(
      'delete from benchmark_provider_cooldowns where provider_key=$1',
      ['gemini'],
    );
  }
});

test('rejects RAG/Pike runs before execution when question retrieval provenance is missing', async () => {
  const datasetVersionId = await generatedDataset();
  await db.query(
    `update questions question
        set generation_item_id=null
       from dataset_questions dataset_question
      where dataset_question.dataset_version_id=$1
        and dataset_question.question_id=question.id`,
    [datasetVersionId],
  );

  await expect(createRun({
    title:`검색 계보 누락 ${randomUUID().slice(0, 8)}`,
    datasetVersionId,
    scoreProfileId:'20000000-0000-0000-0000-000000000001',
    priceProfileVersion:'test-price-v1',
    systemPrompt:'질문에 답하라.',
    questionLimit:1,
    retrievalModes:['VECTOR', 'PIKE'],
    models:[{
      providerKey:'fake',
      displayName:'가상 모델',
      modelId:'fake-provenance-v1',
      protocol:'openai-compatible',
    }],
  })).rejects.toMatchObject({
    code:'RUN_RETRIEVAL_PROVENANCE_REQUIRED',
  });
});
