import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '@/domain/errors';
import {
  summarizeGenerationItems,
  type GenerationItemState,
} from '@/domain/generation-items';
import { mapConcurrentOrdered } from '@/domain/parallel';
import { benchmarkTaskForOrdinal, prerequisiteScoringCriteria } from '@/domain/prerequisite-benchmark';
import { buildQuestionGenerationInstructions } from '@/domain/question-prompt';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { recordGenerationEventWithClient } from '@/server/generation/activity';
import {
  assertJobLeaseWithClient,
  type JobLease,
} from '@/server/jobs/queue';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';
import { createProviderForModel } from '@/server/providers/registry';
import type {
  GenerationRequest,
  ModelProvider,
  NormalizedGeneration,
} from '@/server/providers/types';
import {
  buildQuestionDirectionInstructions,
  parseQuestionDirectionResponse,
  questionDirectionJsonSchema,
  type QuestionDirection,
} from '@/server/questions/direction';
import {
  classifyGenerationFailure,
  GenerationItemsIncompleteError,
  isGenerationControlError,
} from '@/server/questions/failure';
import {
  generatedQuestionResponseJsonSchema,
  parseGeneratedQuestionResponse,
  validateGeneratedQuestionForType,
  type GeneratedQuestion,
} from '@/server/questions/response';
import {
  abandonSupersededGenerationProviderInvocations,
  beginGenerationProviderInvocation,
  completeGenerationProviderInvocation,
  failGenerationProviderInvocation,
  type GenerationProviderStage,
} from '@/server/questions/provider-invocations';
import { resolveGenerationExecutionPins } from '@/server/settings/execution-pins';

type Batch = {
  id: string;
  requested_count: number;
  conditions: Record<string, unknown>;
  source_scope: { sourceFileIds: string[]; sourceRevisionIds?: string[]; tocEntryIds?: string[] };
  generation_model:string;
};

type ClaimedGenerationItem = {
  id: string;
  ordinal: number;
  attempts: number;
};

type RetrievedChunk = {
  id: string;
  content: string;
  page_start: number | null;
  unit: string | null;
  source_file_id: string;
  source_revision_id: string;
  ordinal: number;
  retrieval_source: 'semantic' | 'neighbor' | 'scope_order';
  similarity: number | null;
  semantic_rank: number;
  anchor_chunk_id: string;
};

type QueryVectorAudit = {
  model: string;
  vectorSpaceId: string;
  taskType: string;
  prefixStrategy: string;
  dimensions: number;
  norm: number;
  sha256: string;
};

type GenerationItemHookContext = {
  batchId: string;
  itemId: string;
  ordinal: number;
  attempt: number;
};

export type GenerationTestHooks = {
  beforeItemAttempt?: (context: GenerationItemHookContext) => void | Promise<void>;
  afterRetrievalPersisted?: (context: GenerationItemHookContext) => void | Promise<void>;
  afterItemCommitted?: (context: GenerationItemHookContext) => void | Promise<void>;
};

export type GenerationOptions = {
  signal?: AbortSignal;
  lease: JobLease;
  testHooks?: GenerationTestHooks;
};

type ItemSummary = ReturnType<typeof summarizeGenerationItems>;

function providerRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function auditedGeneration(input: {
  batchId: string;
  item: ClaimedGenerationItem;
  stage: GenerationProviderStage;
  provider: ModelProvider;
  request: GenerationRequest;
  signal: AbortSignal;
}): Promise<NormalizedGeneration> {
  const invocationId = await beginGenerationProviderInvocation({
    batchId: input.batchId,
    itemId: input.item.id,
    itemAttempt: input.item.attempts,
    stage: input.stage,
    provider: input.provider.key,
    modelId: input.provider.modelId,
    request: input.request,
  });
  try {
    const response = await input.provider.generate(input.request, input.signal);
    await completeGenerationProviderInvocation(invocationId, response);
    return response;
  } catch (error) {
    try {
      await failGenerationProviderInvocation(invocationId, error);
    } catch (auditError) {
      console.error(
        'GENERATION_INVOCATION_FAILURE_AUDIT_FAILED',
        invocationId,
        auditError,
      );
    }
    throw error;
  }
}

async function assertLease(lease: JobLease) {
  await withTransaction((client) => assertJobLeaseWithClient(client, lease));
}

async function readItemSummaryWithClient(client: PoolClient, batchId: string): Promise<ItemSummary> {
  const result = await client.query<{
    ordinal: number;
    state: GenerationItemState;
    retryable: boolean;
    error_code: string | null;
    error_message: string | null;
  }>(
    `select ordinal,state,retryable,error_code,error_message
       from generation_items
      where generation_batch_id=$1
      order by ordinal`,
    [batchId],
  );
  return summarizeGenerationItems(result.rows.map((item) => ({
    ordinal: item.ordinal,
    state: item.state,
    retryable: item.retryable,
    errorCode: item.error_code,
    errorMessage: item.error_message,
  })));
}

function progressPatch(summary: ItemSummary, currentStage: number, error?: string) {
  const patch: Record<string, unknown> = {
    currentStage,
    completedQuestions: summary.completed,
    failedQuestions: summary.failed,
    runningQuestions: summary.running,
    pendingQuestions: summary.pending,
    itemErrors: summary.errors,
  };
  if (error) patch.error = error;
  return patch;
}

async function updateLockedBatchWithSummary(
  client: PoolClient,
  batchId: string,
  requestedState: 'RUNNING' | 'COMPLETED' | 'FAILED',
  currentStage: number,
  error?: string,
) {
  const batch = await client.query<{ state: string }>(
    'select state from generation_batches where id=$1 for update',
    [batchId],
  );
  if (!batch.rows[0]) {
    throw new DomainError('GENERATION_BATCH_NOT_FOUND', '생성 배치를 찾을 수 없습니다.');
  }
  const summary = await readItemSummaryWithClient(client, batchId);
  const state = summary.allCompleted
    ? 'COMPLETED'
    : batch.rows[0].state === 'COMPLETED'
      ? 'COMPLETED'
      : requestedState;
  if (batch.rows[0].state !== 'COMPLETED' || state === 'COMPLETED') {
    await client.query(
      `update generation_batches
          set state=$2,
              progress=(progress-'error'-'itemErrors') || $3::jsonb,
              updated_at=now()
        where id=$1`,
      [
        batchId,
        state,
        JSON.stringify(progressPatch(
          summary,
          state === 'COMPLETED' ? 9 : currentStage,
          state === 'COMPLETED' ? undefined : error,
        )),
      ],
    );
  }
  return summary;
}

async function logWithLease(
  batchId: string,
  lease: JobLease,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await recordGenerationEventWithClient(client, batchId, lease.jobId, eventType, payload);
  });
}

async function claimGenerationItems(
  batch: Batch,
  lease: JobLease,
): Promise<{ items: ClaimedGenerationItem[]; summary: ItemSummary }> {
  return withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await client.query('select id from generation_batches where id=$1 for update', [batch.id]);
    await client.query(
      `insert into generation_items(generation_batch_id,ordinal)
       select $1,ordinal
         from generate_series(1,$2::int) ordinal
       on conflict(generation_batch_id,ordinal) do nothing`,
      [batch.id, batch.requested_count],
    );
    const claimed = await client.query<ClaimedGenerationItem>(
      `with candidates as (
         select item.id
           from generation_items item
          where item.generation_batch_id=$1
            and (
              item.state='PENDING'
              or (item.state='FAILED' and item.retryable)
              or (
                item.state='RUNNING'
                and not exists (
                  select 1
                    from jobs prior_job
                   where prior_job.id=item.claimed_job_id
                     and prior_job.state='LEASED'
                     and prior_job.attempts=item.claimed_job_attempt
                     and prior_job.lease_expires_at>now()
                )
              )
            )
          order by item.ordinal
          for update of item skip locked
       )
       update generation_items item
          set state='RUNNING',
              attempts=item.attempts+1,
              retryable=true,
              claimed_job_id=$2,
              claimed_job_attempt=$3,
              error_code=null,
              error_message=null,
              started_at=now(),
              completed_at=null,
              updated_at=now()
         from candidates
        where item.id=candidates.id
        returning item.id,item.ordinal,item.attempts`,
      [batch.id, lease.jobId, lease.attempt],
    );
    await abandonSupersededGenerationProviderInvocations(client, {
      batchId: batch.id,
      itemIds: claimed.rows.map((item) => item.id),
    });
    const summary = await updateLockedBatchWithSummary(client, batch.id, 'RUNNING', 1);
    return {
      items: claimed.rows.sort((left, right) => left.ordinal - right.ordinal),
      summary,
    };
  });
}

async function assertItemOwnershipWithClient(
  client: PoolClient,
  item: ClaimedGenerationItem,
  lease: JobLease,
) {
  const owned = await client.query<{ state: GenerationItemState }>(
    `select state
       from generation_items
      where id=$1
        and state='RUNNING'
        and attempts=$2
        and claimed_job_id=$3
        and claimed_job_attempt=$4
      for update`,
    [item.id, item.attempts, lease.jobId, lease.attempt],
  );
  if (!owned.rowCount) {
    throw new DomainError(
      'GENERATION_ITEM_OWNERSHIP_LOST',
      `${item.ordinal}번 문항 실행 소유권이 변경되었습니다.`,
      { itemId: item.id, ordinal: item.ordinal, attempt: item.attempts },
    );
  }
}

async function persistDirection(
  batchId: string,
  item: ClaimedGenerationItem,
  direction: QuestionDirection,
  lease: JobLease,
) {
  await withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await assertItemOwnershipWithClient(client, item, lease);
    const updated = await client.query(
      `update generation_items
          set direction=$2::jsonb,updated_at=now()
        where id=$1
          and state='RUNNING'
          and attempts=$3
          and claimed_job_id=$4
          and claimed_job_attempt=$5`,
      [item.id, JSON.stringify(direction), item.attempts, lease.jobId, lease.attempt],
    );
    if (!updated.rowCount) {
      throw new DomainError(
        'GENERATION_ITEM_OWNERSHIP_LOST',
        `${item.ordinal}번 문항 방향성을 저장하지 못했습니다.`,
      );
    }
    await recordGenerationEventWithClient(
      client,
      batchId,
      lease.jobId,
      'QUESTION_DIRECTION_COMPLETED',
      {
        ordinal: item.ordinal,
        attempt: item.attempts,
        ...direction,
      },
    );
  });
}

async function persistRetrieval(
  input: {
    batch: Batch;
    item: ClaimedGenerationItem;
    lease: JobLease;
    embeddingModel: string | null;
    questionDirection: QuestionDirection;
    chunks: RetrievedChunk[];
    sourceRevisionIds: string[];
    tocEntryIds: string[];
    queryVectorAudit: QueryVectorAudit | null;
    retrievalTopK: number;
    neighborWindow: number;
    similarityMetric: string;
  },
) {
  await withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, input.lease);
    await assertItemOwnershipWithClient(client, input.item, input.lease);
    await client.query(
      `insert into generation_retrievals(
         generation_batch_id,generation_item_id,attempt,query_text,embedding_model,
         candidate_scope,selected_chunks
       ) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       on conflict(generation_item_id,attempt) where generation_item_id is not null do nothing`,
      [
        input.batch.id,
        input.item.id,
        input.item.attempts,
        input.questionDirection.searchQuery,
        input.embeddingModel,
        JSON.stringify({
          ordinal: input.item.ordinal,
          attempt: input.item.attempts,
          questionDirection: input.questionDirection,
          sourceFileIds: input.batch.source_scope.sourceFileIds,
          sourceRevisionIds: input.sourceRevisionIds,
          tocEntryIds: input.tocEntryIds,
          units: input.batch.conditions.units ?? [],
          queryVector: input.queryVectorAudit,
          retrievalConfig: {
            topK: input.retrievalTopK,
            neighborWindow: input.neighborWindow,
            similarityMetric: input.similarityMetric,
          },
        }),
        JSON.stringify(input.chunks.map((chunk, index) => ({
          chunkId: chunk.id,
          rank: index + 1,
          page: chunk.page_start,
          unit: chunk.unit,
          content: chunk.content,
          source: chunk.retrieval_source,
          similarity: chunk.similarity,
          semanticRank: chunk.semantic_rank,
          anchorChunkId: chunk.anchor_chunk_id,
          selectionReason: chunk.retrieval_source === 'neighbor'
            ? `${chunk.anchor_chunk_id} 청크 주변의 선수 맥락으로 확장됨`
            : chunk.retrieval_source === 'semantic'
              ? `질의 벡터와의 코사인 유사도 순위 ${chunk.semantic_rank}`
              : `임베딩이 없는 MOCK 실행에서 고정된 청크 순서 ${chunk.semantic_rank}`,
        }))),
      ],
    );
    await recordGenerationEventWithClient(
      client,
      input.batch.id,
      input.lease.jobId,
      'QUESTION_RETRIEVAL_COMPLETED',
      {
        ordinal: input.item.ordinal,
        attempt: input.item.attempts,
        queryText: input.questionDirection.searchQuery,
        chunkCount: input.chunks.length,
        selectedChunkIds: input.chunks.map((chunk) => chunk.id),
        chunks: input.chunks.map((chunk, index) => ({
          chunkId: chunk.id,
          rank: index + 1,
          page: chunk.page_start,
          unit: chunk.unit,
          source: chunk.retrieval_source,
          similarity: chunk.similarity,
          semanticRank: chunk.semantic_rank,
          anchorChunkId: chunk.anchor_chunk_id,
        })),
        queryVector: input.queryVectorAudit,
        retrievalConfig: {
          topK: input.retrievalTopK,
          neighborWindow: input.neighborWindow,
          similarityMetric: input.similarityMetric,
        },
      },
    );
  });
}

async function persistItemFailure(
  batchId: string,
  item: ClaimedGenerationItem,
  lease: JobLease,
  error: unknown,
) {
  const failure = classifyGenerationFailure(error);
  await withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await client.query('select id from generation_batches where id=$1 for update', [batchId]);
    await assertItemOwnershipWithClient(client, item, lease);
    await client.query(
      `update generation_items
          set state='FAILED',
              retryable=$2,
              error_code=$3,
              error_message=$4,
              completed_at=null,
              updated_at=now()
        where id=$1
          and state='RUNNING'
          and attempts=$5
          and claimed_job_id=$6
          and claimed_job_attempt=$7`,
      [
        item.id,
        failure.retryable,
        failure.code,
        failure.message,
        item.attempts,
        lease.jobId,
        lease.attempt,
      ],
    );
    const summary = await updateLockedBatchWithSummary(client, batchId, 'RUNNING', 7);
    await recordGenerationEventWithClient(
      client,
      batchId,
      lease.jobId,
      'QUESTION_GENERATION_FAILED',
      {
        ordinal: item.ordinal,
        attempt: item.attempts,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        completedQuestions: summary.completed,
        failedQuestions: summary.failed,
      },
    );
  });
}

async function persistCompletedQuestion(
  client: PoolClient,
  input: {
    batch: Batch;
    item: ClaimedGenerationItem;
    question: GeneratedQuestion;
    chunks: RetrievedChunk[];
    questionDirection: QuestionDirection;
    providerModelId: string;
    embeddingModelId:string;
    lease: JobLease;
  },
) {
  await assertJobLeaseWithClient(client, input.lease);
  await client.query('select id from generation_batches where id=$1 for update', [input.batch.id]);
  await assertItemOwnershipWithClient(client, input.item, input.lease);

  const questionId = randomUUID();
  const publicId = `Q-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${questionId.slice(0, 8).toUpperCase()}`;
  await client.query(
    `insert into questions(
       id,public_id,generation_batch_id,generation_item_id,status,subject,grade,unit,purpose,
       difficulty,question_type,evidence_mode,generator_provider,generator_model,embedding_model
     ) values(
       $1,$2,$3,$4,'IN_REVIEW',$5,$6,$7,$8,$9,$10,'GROUNDED','gemini',$11,$12
     )`,
    [
      questionId,
      publicId,
      input.batch.id,
      input.item.id,
      String(input.batch.conditions.subject ?? ''),
      String(input.batch.conditions.grade ?? ''),
      Array.isArray(input.batch.conditions.units) ? input.batch.conditions.units.join(', ') : null,
      String(input.batch.conditions.purpose ?? ''),
      String(input.batch.conditions.difficulty ?? '중'),
      String(input.batch.conditions.questionType ?? '서술형'),
      input.providerModelId,
      input.embeddingModelId,
    ],
  );
  await client.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,scoring_criteria,accepted_answers,
       design_summary,evidence_summary,quality_scores,change_reason,answer_options
     ) values($1,1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,'question-generation-v1',$9::jsonb)`,
    [
      questionId,
      input.question.questionText,
      input.question.answerText,
      JSON.stringify(prerequisiteScoringCriteria),
      JSON.stringify(input.question.acceptedAnswers),
      input.question.designSummary,
      input.question.evidenceSummary,
      JSON.stringify({
        pipelineComplete: true,
        ordinal: input.item.ordinal,
        questionDirection: input.questionDirection,
        benchmarkDesign: input.question.benchmarkDesign,
      }),
      JSON.stringify(input.question.answerOptions),
    ],
  );
  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  for (const [evidenceIndex, chunkId] of input.question.evidenceChunkIds.entries()) {
    const chunk = chunksById.get(chunkId);
    if (!chunk) {
      throw new DomainError(
        'GENERATION_EVIDENCE_SCOPE_VIOLATION',
        '저장할 근거 청크가 검색 범위에 없습니다.',
      );
    }
    await client.query(
      `insert into question_evidence(question_id,question_revision,source_chunk_id,ordinal,quote_text)
       values($1,1,$2,$3,$4)`,
      [questionId, chunk.id, evidenceIndex + 1, chunk.content],
    );
  }
  const completed = await client.query(
    `update generation_items
        set state='COMPLETED',
            retryable=true,
            error_code=null,
            error_message=null,
            completed_at=now(),
            updated_at=now()
      where id=$1
        and state='RUNNING'
        and attempts=$2
        and claimed_job_id=$3
        and claimed_job_attempt=$4
      returning id`,
    [input.item.id, input.item.attempts, input.lease.jobId, input.lease.attempt],
  );
  if (!completed.rowCount) {
    throw new DomainError(
      'GENERATION_ITEM_OWNERSHIP_LOST',
      `${input.item.ordinal}번 문항 완료 상태를 저장하지 못했습니다.`,
    );
  }
  const summary = await updateLockedBatchWithSummary(client, input.batch.id, 'RUNNING', 7);
  await recordGenerationEventWithClient(
    client,
    input.batch.id,
    input.lease.jobId,
    'QUESTION_GENERATION_COMPLETED',
    {
      ordinal: input.item.ordinal,
      attempt: input.item.attempts,
      questionId,
      publicId,
      questionDirection: input.questionDirection,
      ...input.question,
      completedQuestions: summary.completed,
      failedQuestions: summary.failed,
    },
  );
}

async function reconcileOwnedItemsAfterFailure(
  batchId: string,
  lease: JobLease,
  error: unknown,
  recordEvent: boolean,
) {
  const failure = classifyGenerationFailure(error);
  return withTransaction(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await client.query('select id from generation_batches where id=$1 for update', [batchId]);
    await client.query(
      `update generation_items
          set state='FAILED',
              retryable=$4,
              error_code=$5,
              error_message=$6,
              completed_at=null,
              updated_at=now()
        where generation_batch_id=$1
          and state='RUNNING'
          and claimed_job_id=$2
          and claimed_job_attempt=$3`,
      [batchId, lease.jobId, lease.attempt, failure.retryable, failure.code, failure.message],
    );
    const summary = await updateLockedBatchWithSummary(
      client,
      batchId,
      'FAILED',
      7,
      failure.message,
    );
    if (recordEvent) {
      await recordGenerationEventWithClient(
        client,
        batchId,
        lease.jobId,
        'GENERATION_FAILED',
        {
          ...failure,
          completedQuestions: summary.completed,
          failedQuestions: summary.failed,
        },
      );
    }
    return summary;
  });
}

async function finalizeGeneration(batchId: string, lease: JobLease) {
  return withTransaction<{
    summary: ItemSummary;
    incomplete: GenerationItemsIncompleteError | null;
  }>(async (client) => {
    await assertJobLeaseWithClient(client, lease);
    await client.query('select id from generation_batches where id=$1 for update', [batchId]);
    const summary = await readItemSummaryWithClient(client, batchId);
    if (summary.allCompleted) {
      await updateLockedBatchWithSummary(client, batchId, 'COMPLETED', 9);
      const publicIds = await client.query<{ public_id: string }>(
        `select public_id
           from questions
          where generation_batch_id=$1 and deleted_at is null
          order by created_at,public_id`,
        [batchId],
      );
      await recordGenerationEventWithClient(
        client,
        batchId,
        lease.jobId,
        'GENERATION_COMPLETED',
        {
          questionCount: summary.completed,
          publicIds: publicIds.rows.map((question) => question.public_id),
        },
      );
      return { summary, incomplete: null };
    }
    const failedOrdinals = summary.errors.map((item) => item.ordinal).join(', ');
    const message = `미완료 문항이 남아 있습니다.${failedOrdinals ? ` 실패 문항: ${failedOrdinals}` : ''}`;
    await updateLockedBatchWithSummary(client, batchId, 'FAILED', 7, message);
    const retryable = summary.errors.some((item) => item.retryable)
      || summary.pending > 0
      || summary.running > 0;
    return {
      summary,
      incomplete: new GenerationItemsIncompleteError(message, retryable, {
        errors: summary.errors,
        completed: summary.completed,
        failed: summary.failed,
      }),
    };
  });
}

export async function generateQuestions(
  batchId: string,
  options: GenerationOptions,
): Promise<{ questions: number }> {
  const { lease } = options;
  await assertLease(lease);
  const batchResult = await db.query<Batch>(
    `select id,requested_count,conditions,source_scope,generation_model
     from generation_batches where id=$1`,
    [batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new DomainError('GENERATION_BATCH_NOT_FOUND', '생성 배치를 찾을 수 없습니다.');
  const executionPins = await resolveGenerationExecutionPins(batchId);
  const generationSettings =
    executionPins.questionGeneration.definition.settings;
  const embeddingSettings = executionPins.embeddingRag.definition.settings;
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  if (!mock && batch.generation_model !== generationSettings.model) {
    throw new DomainError(
      'GENERATION_CONFIG_PIN_INTEGRITY_ERROR',
      '생성 배치의 모델 ID가 고정된 연구 설정과 일치하지 않습니다.',
    );
  }
  if (!mock && !process.env.GOOGLE_API_KEY) {
    throw new DomainError(
      'GENERATION_EMBEDDING_NOT_CONFIGURED',
      '검색 질의 임베딩과 Gemini 문항 생성에 GOOGLE_API_KEY가 필요합니다.',
    );
  }

  const existingSummary = await withTransaction((client) => readItemSummaryWithClient(client, batchId));
  if (existingSummary.allCompleted) {
    await withTransaction(async (client) => {
      await assertJobLeaseWithClient(client, lease);
      await updateLockedBatchWithSummary(client, batchId, 'COMPLETED', 9);
    });
    return { questions: existingSummary.completed };
  }

  let sourceRevisionIds = batch.source_scope.sourceRevisionIds ?? [];
  if (!sourceRevisionIds.length) {
    const latestRevisions = await db.query<{ id: string; source_file_id: string }>(
      `select distinct on(source_file_id) id,source_file_id
         from source_revisions
        where source_file_id=any($1::uuid[])
        order by source_file_id,revision desc`,
      [batch.source_scope.sourceFileIds],
    );
    const revisionBySource = new Map(latestRevisions.rows.map((revision) => [revision.source_file_id, revision.id]));
    const resolvedRevisionIds = batch.source_scope.sourceFileIds.flatMap((sourceId) => {
      const revisionId = revisionBySource.get(sourceId);
      return revisionId ? [revisionId] : [];
    });
    if (resolvedRevisionIds.length !== batch.source_scope.sourceFileIds.length) {
      throw new DomainError(
        'GENERATION_SOURCE_SCOPE_INVALID',
        '교과서의 고정 리비전을 결정할 수 없습니다.',
      );
    }
    await withTransaction(async (client) => {
      await assertJobLeaseWithClient(client, lease);
      await client.query('select id from generation_batches where id=$1 for update', [batchId]);
      await client.query(
        `update generation_batches
            set source_scope=jsonb_set(source_scope,'{sourceRevisionIds}',$2::jsonb,true),
                updated_at=now()
          where id=$1
            and coalesce(source_scope->'sourceRevisionIds','[]'::jsonb)='[]'::jsonb`,
        [batchId, JSON.stringify(resolvedRevisionIds)],
      );
    });
    const storedScope = await db.query<{ source_scope: Batch['source_scope'] }>(
      'select source_scope from generation_batches where id=$1',
      [batchId],
    );
    const storedRevisionIds = storedScope.rows[0]?.source_scope.sourceRevisionIds;
    if (!Array.isArray(storedRevisionIds) || !storedRevisionIds.length
      || storedRevisionIds.some((revisionId) => typeof revisionId !== 'string')) {
      throw new DomainError(
        'GENERATION_SOURCE_SCOPE_INVALID',
        '교과서 리비전 고정값을 저장하지 못했습니다.',
      );
    }
    sourceRevisionIds = storedRevisionIds;
  }

  const pinnedRevisions = await db.query<{ id: string; source_file_id: string }>(
    'select id,source_file_id from source_revisions where id=any($1::uuid[])',
    [sourceRevisionIds],
  );
  const pinnedSourceIds = new Set(pinnedRevisions.rows.map((revision) => revision.source_file_id));
  if (sourceRevisionIds.length !== batch.source_scope.sourceFileIds.length
    || pinnedRevisions.rowCount !== sourceRevisionIds.length
    || pinnedSourceIds.size !== batch.source_scope.sourceFileIds.length
    || batch.source_scope.sourceFileIds.some((sourceId) => !pinnedSourceIds.has(sourceId))) {
    throw new DomainError(
      'GENERATION_SOURCE_SCOPE_INVALID',
      '고정된 교과서 리비전 범위가 유효하지 않습니다.',
    );
  }
  const vectorSpace = await db.query<{
    chunk_count:number;
    mismatched_count:number;
  }>(
    `select count(*)::int chunk_count,
       count(*) filter (
         where embedding_rag_profile_hash is distinct from $2
            or embedding_vector_space_id is distinct from $3
            or embedding_rag_profile_snapshot_provenance
                 <> 'AT_CREATION_VERIFIED'
            or (not $4::boolean and embedding is null)
       )::int mismatched_count
     from source_chunks
     where source_revision_id=any($1::uuid[])`,
    [
      sourceRevisionIds,
      executionPins.embeddingRag.contentHash,
      embeddingSettings.vectorSpaceId,
      mock,
    ],
  );
  if (
    !vectorSpace.rows[0]?.chunk_count
    || vectorSpace.rows[0].mismatched_count > 0
  ) {
    throw new DomainError(
      'GENERATION_VECTOR_SPACE_MISMATCH',
      '선택한 교과서의 임베딩 공간이 생성 배치에 고정된 RAG 설정과 다릅니다. 해당 설정으로 교과서를 다시 처리하십시오.',
    );
  }

  const tocEntryIds = batch.source_scope.tocEntryIds ?? [];
  if (tocEntryIds.length) {
    const mappedTocEntries = await db.query<{ id: string; mapped_chunk_count: number }>(
      `select entry.id,count(distinct chunk.id)::int as mapped_chunk_count
         from source_toc_entries entry
         left join source_chunk_toc_entries mapping
           on mapping.source_toc_entry_id=entry.id
          and mapping.source_revision_id=entry.source_revision_id
         left join source_chunks chunk
           on chunk.id=mapping.source_chunk_id
          and chunk.source_revision_id=mapping.source_revision_id
          and chunk.source_revision_id=any($2::uuid[])
        where entry.id=any($1::uuid[])
          and entry.source_revision_id=any($2::uuid[])
        group by entry.id`,
      [tocEntryIds, sourceRevisionIds],
    );
    if (mappedTocEntries.rowCount !== tocEntryIds.length
      || mappedTocEntries.rows.some((entry) => entry.mapped_chunk_count < 1)) {
      throw new DomainError(
        'GENERATION_TOC_SCOPE_EMPTY',
        '선택한 목차에 연결된 현재 리비전 청크가 없습니다.',
      );
    }
  }

  const embeddingModel = mock
    ? 'mock-embedding-3072'
    : embeddingSettings.model;
  const provider = createProviderForModel('gemini', generationSettings.model);
  if (!provider) {
    throw new DomainError(
      'GENERATION_PROVIDER_NOT_CONFIGURED',
      `Gemini ${generationSettings.model} 생성에 GOOGLE_API_KEY가 필요합니다.`,
    );
  }
  const embedder = !mock ? new GeminiEmbedder({
    apiKey: process.env.GOOGLE_API_KEY!,
    modelId:embeddingSettings.model,
    dimensions:embeddingSettings.dimensions,
    baseUrl: process.env.GEMINI_BASE_URL,
    timeoutMs:embeddingSettings.requestTimeoutMs,
  }) : null;

  const executionMode = batch.conditions.executionMode === 'parallel' ? 'parallel' : 'sequential';
  const concurrency = executionMode === 'parallel'
    ? generationSettings.concurrency
    : 1;
  const claimed = await claimGenerationItems(batch, lease);
  if (claimed.summary.allCompleted) return { questions: claimed.summary.completed };
  if (!claimed.items.length) {
    const retryable = claimed.summary.errors.some((item) => item.retryable);
    throw new GenerationItemsIncompleteError(
      '처리 가능한 미완료 문항이 없습니다.',
      retryable,
      { errors: claimed.summary.errors },
    );
  }

  try {
    await logWithLease(batchId, lease, 'GENERATION_STARTED', {
      requestedCount: batch.requested_count,
      remainingCount: claimed.items.length,
      executionMode,
      concurrency,
      jobAttempt: lease.attempt,
      questionGenerationProfileId:
        executionPins.questionGeneration.profileId,
      questionGenerationProfileHash:
        executionPins.questionGeneration.contentHash,
      embeddingRagProfileId:executionPins.embeddingRag.profileId,
      embeddingRagProfileHash:executionPins.embeddingRag.contentHash,
      vectorSpaceId:embeddingSettings.vectorSpaceId,
    });
    await mapConcurrentOrdered(claimed.items, concurrency, async (item) => {
      const hookContext: GenerationItemHookContext = {
        batchId,
        itemId: item.id,
        ordinal: item.ordinal,
        attempt: item.attempts,
      };
      try {
        options.signal?.throwIfAborted();
        await options.testHooks?.beforeItemAttempt?.(hookContext);
        await logWithLease(batchId, lease, 'QUESTION_DIRECTION_STARTED', {
          ordinal: item.ordinal,
          attempt: item.attempts,
          total: batch.requested_count,
        });
        let questionDirection: QuestionDirection;
        if (mock) {
          questionDirection = {
            directionSummary: `${item.ordinal}번 문항의 독립적인 선수관계 측정 방향`,
            targetConceptQuery: `${String(batch.conditions.subject ?? '')} 목표 개념 ${item.ordinal}`,
            prerequisiteQuery: `${String(batch.conditions.subject ?? '')} 선수 개념 ${item.ordinal}`,
            searchQuery: `${String(batch.conditions.subject ?? '')} 목표 개념 ${item.ordinal} 선수 관계 학습 순서`,
          };
        } else {
          const directionInstructions = buildQuestionDirectionInstructions({
            conditions: batch.conditions,
            ordinal: item.ordinal,
            total: batch.requested_count,
          });
          const directionRequest: GenerationRequest = {
            system: directionInstructions.system,
            prompt: directionInstructions.prompt,
            maxOutputTokens:generationSettings.directionMaxOutputTokens,
            ...(generationSettings.structuredOutput ? {
              responseMimeType:generationSettings.responseMimeType,
              responseJsonSchema:questionDirectionJsonSchema,
            } : {}),
            thinkingLevel:generationSettings.thinkingLevel,
          };
          const directionResponse = await auditedGeneration({
            batchId,
            item,
            stage: 'DIRECTION',
            provider,
            request: directionRequest,
            signal: providerRequestSignal(
              options.signal,
              generationSettings.requestTimeoutMs,
            ),
          });
          if (directionResponse.finishReason && directionResponse.finishReason !== 'STOP') {
            throw new DomainError(
              'DIRECTION_INCOMPLETE_RESPONSE',
              `Gemini 방향성 응답이 완료되지 않았습니다. finishReason=${directionResponse.finishReason}`,
            );
          }
          questionDirection = parseQuestionDirectionResponse(directionResponse.text);
        }
        await persistDirection(batchId, item, questionDirection, lease);

        await logWithLease(batchId, lease, 'QUESTION_RETRIEVAL_STARTED', {
          ordinal: item.ordinal,
          attempt: item.attempts,
          queryText: questionDirection.searchQuery,
        });
        let queryVector: string | null = null;
        let queryVectorAudit: QueryVectorAudit | null = null;
        if (embedder) {
          const [vector] = await embedder.embed(
            [
              embeddingSettings.prefixStrategy === 'text_prefix'
                ? `${embeddingSettings.queryPrefix}${questionDirection.searchQuery}`
                : questionDirection.searchQuery,
            ],
            providerRequestSignal(
              options.signal,
              embeddingSettings.requestTimeoutMs,
            ),
            embeddingSettings.queryTaskType,
          );
          const values = vector!;
          queryVector = `[${values.join(',')}]`;
          queryVectorAudit = {
            model: embeddingModel!,
            vectorSpaceId: embeddingSettings.vectorSpaceId,
            taskType: embeddingSettings.queryTaskType,
            prefixStrategy: embeddingSettings.prefixStrategy,
            dimensions: values.length,
            norm: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)),
            sha256: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
          };
        }
        const retrievalTopK = Math.min(
          Number(batch.conditions.chunkCount ?? embeddingSettings.retrievalTopK),
          embeddingSettings.retrievalTopK,
        );
        const chunks = await db.query<RetrievedChunk>(
          `with scoped_chunks as materialized(
             select distinct chunk.id,chunk.content,chunk.page_start,chunk.unit,
                    chunk.source_file_id,chunk.source_revision_id,chunk.ordinal,chunk.embedding
               from source_chunks chunk
              where chunk.source_revision_id=any($1::uuid[])
                and chunk.embedding_rag_profile_hash=$6
                and chunk.embedding_vector_space_id=$7
                and chunk.embedding_rag_profile_snapshot_provenance=
                      'AT_CREATION_VERIFIED'
                and ($8::boolean or chunk.embedding is not null)
                and (
                  cardinality($2::uuid[])=0
                  or exists(
                    select 1
                      from source_chunk_toc_entries mapping
                      join source_toc_entries entry
                        on entry.id=mapping.source_toc_entry_id
                       and entry.source_revision_id=mapping.source_revision_id
                     where mapping.source_chunk_id=chunk.id
                       and mapping.source_revision_id=chunk.source_revision_id
                       and mapping.source_toc_entry_id=any($2::uuid[])
                  )
                )
           ),
           semantic as(
             select scoped.*,
                    case when $3::vector is null then null
                         else (1-(scoped.embedding <=>$3::vector))::double precision
                    end as similarity,
                    row_number() over(
                      order by case when $3::vector is null then null else scoped.embedding <=>$3::vector end nulls last,
                               scoped.source_file_id,scoped.ordinal
                    )::int as semantic_rank
               from scoped_chunks scoped
              order by case when $3::vector is null then null else scoped.embedding <=>$3::vector end nulls last,
                       scoped.source_file_id,scoped.ordinal
              limit $4
           ),
           expanded as(
             select semantic.id,semantic.content,semantic.page_start,semantic.unit,
                    semantic.source_file_id,semantic.source_revision_id,semantic.ordinal,
                    case when $3::vector is null then 'scope_order' else 'semantic' end
                      as retrieval_source,
                    semantic.similarity,semantic.semantic_rank,semantic.id as anchor_chunk_id,
                    semantic.semantic_rank*1000 as selection_order
               from semantic
             union all
             select prior.id,prior.content,prior.page_start,prior.unit,
                    prior.source_file_id,prior.source_revision_id,prior.ordinal,
                    'neighbor' as retrieval_source,
                    semantic.similarity,semantic.semantic_rank,semantic.id as anchor_chunk_id,
                    semantic.semantic_rank*1000-(semantic.ordinal-prior.ordinal) as selection_order
               from semantic
                join scoped_chunks prior
                  on prior.source_revision_id=semantic.source_revision_id
                 and prior.ordinal between
                     greatest(1,semantic.ordinal-$5)
                     and semantic.ordinal-1
           ),
           ranked as(
             select expanded.*,
                    row_number() over(
                      partition by expanded.id
                      order by
                        case when expanded.retrieval_source='neighbor' then 1 else 0 end,
                        expanded.selection_order,
                        expanded.anchor_chunk_id
                    ) as dedupe_rank
               from expanded
           )
           select id,content,page_start,unit,source_file_id,source_revision_id,ordinal,
                  retrieval_source,similarity,semantic_rank,anchor_chunk_id
             from ranked
            where dedupe_rank=1
            order by selection_order,source_file_id,ordinal`,
          [
            sourceRevisionIds,
            tocEntryIds,
            queryVector,
            retrievalTopK,
            embeddingSettings.neighborWindow,
            executionPins.embeddingRag.contentHash,
            embeddingSettings.vectorSpaceId,
            mock,
          ],
        );
        if (!chunks.rowCount) {
          if (tocEntryIds.length) {
            throw new DomainError(
              'GENERATION_TOC_SCOPE_EMPTY',
              `${item.ordinal}번 문항의 선택 목차 범위에 교과서 청크가 없습니다.`,
            );
          }
          throw new DomainError(
            'GENERATION_EVIDENCE_EMPTY',
            `${item.ordinal}번 문항 방향에서 교과서 청크를 찾지 못했습니다.`,
          );
        }
        await persistRetrieval({
          batch,
          item,
          lease,
          embeddingModel,
          questionDirection,
          chunks: chunks.rows,
          sourceRevisionIds,
          tocEntryIds,
          queryVectorAudit,
          retrievalTopK,
          neighborWindow: embeddingSettings.neighborWindow,
          similarityMetric: embeddingSettings.similarityMetric,
        });
        await options.testHooks?.afterRetrievalPersisted?.(hookContext);

        const evidence = JSON.stringify(chunks.rows.map((chunk) => ({
          chunkId: chunk.id,
          page: chunk.page_start,
          unit: chunk.unit,
          content: chunk.content,
        })), null, 2);
        const allowedChunkIds = new Set(chunks.rows.map((chunk) => chunk.id));
        await logWithLease(batchId, lease, 'QUESTION_GENERATION_STARTED', {
          ordinal: item.ordinal,
          attempt: item.attempts,
          executionMode,
          directionSummary: questionDirection.directionSummary,
        });
        let question: GeneratedQuestion;
        if (mock) {
          const citedChunkId = chunks.rows[(item.ordinal - 1) % chunks.rows.length]!.id;
          const targetConcept = `MOCK 목표 개념 ${item.ordinal}`;
          question = {
            questionText: `[MOCK ${item.ordinal}] ${String(batch.conditions.purpose)} 검증 문항`,
            answerText: 'MOCK 모범 답안',
            acceptedAnswers: ['MOCK 모범 답안'],
            answerOptions: [],
            designSummary: '로컬 파이프라인 검증 전용',
            evidenceSummary: '검색 청크 근거',
            evidenceChunkIds: [citedChunkId],
            benchmarkDesign: {
              benchmarkType: 'PREREQUISITE_RELATIONSHIP',
              taskType: benchmarkTaskForOrdinal(item.ordinal),
              targetConcept,
              prerequisiteConcepts: [{
                concept: `MOCK 선수 개념 ${item.ordinal}`,
                role: '목표 개념의 이해에 먼저 필요한 개념',
                evidenceChunkIds: [citedChunkId],
              }],
              prerequisiteRelations: [{
                fromConcept: `MOCK 선수 개념 ${item.ordinal}`,
                toConcept: targetConcept,
                relationType: 'REQUIRES',
                explanation: '선수 개념을 먼저 적용해야 목표 개념을 판단할 수 있다.',
                evidenceChunkIds: [citedChunkId],
              }],
              requiredReasoningSteps: ['선수 개념을 식별한다.', '선수 개념을 목표 개념 판단에 적용한다.'],
              failureSignals: ['선수 개념을 적용하지 않고 결론만 제시한다.'],
            },
          };
        } else {
          const instructions = buildQuestionGenerationInstructions({
            conditions: {
              ...batch.conditions,
              direction: `${String(batch.conditions.direction ?? '')}\n이번 문항 전용 방향성: ${questionDirection.directionSummary}`.trim(),
            },
            ordinal: item.ordinal,
            total: batch.requested_count,
            evidence,
          });
          const generationRequest: GenerationRequest = {
            system: instructions.system,
            prompt: instructions.prompt,
            maxOutputTokens:generationSettings.questionMaxOutputTokens,
            ...(generationSettings.structuredOutput ? {
              responseMimeType:generationSettings.responseMimeType,
              responseJsonSchema:generatedQuestionResponseJsonSchema,
            } : {}),
            thinkingLevel:generationSettings.thinkingLevel,
          };
          const response = await auditedGeneration({
            batchId,
            item,
            stage: 'QUESTION',
            provider,
            request: generationRequest,
            signal: providerRequestSignal(
              options.signal,
              generationSettings.requestTimeoutMs,
            ),
          });
          if (response.finishReason && response.finishReason !== 'STOP') {
            throw new DomainError(
              'GENERATION_INCOMPLETE_RESPONSE',
              `Gemini 응답이 완료되지 않았습니다. finishReason=${response.finishReason}`,
            );
          }
          question = parseGeneratedQuestionResponse(response.text);
          validateGeneratedQuestionForType(question, batch.conditions.questionType);
        }
        if (question.evidenceChunkIds.some((id) => !allowedChunkIds.has(id))) {
          throw new DomainError(
            'GENERATION_EVIDENCE_SCOPE_VIOLATION',
            '모델이 검색 범위 밖의 청크를 인용했습니다.',
          );
        }
        const designChunkIds = [
          ...question.benchmarkDesign.prerequisiteConcepts.flatMap((concept) => concept.evidenceChunkIds),
          ...question.benchmarkDesign.prerequisiteRelations.flatMap((relation) => relation.evidenceChunkIds),
        ];
        if (designChunkIds.some((id) => !allowedChunkIds.has(id))) {
          throw new DomainError(
            'GENERATION_EVIDENCE_SCOPE_VIOLATION',
            '선수 관계 청사진이 검색 범위 밖의 청크를 인용했습니다.',
          );
        }

        await withTransaction((client) => persistCompletedQuestion(client, {
          batch,
          item,
          question,
          chunks: chunks.rows,
          questionDirection,
          providerModelId: provider.modelId,
          embeddingModelId:embeddingModel,
          lease,
        }));
      } catch (error) {
        if (isGenerationControlError(error, options.signal)) throw error;
        await persistItemFailure(batchId, item, lease, error);
        return;
      }

      await options.testHooks?.afterItemCommitted?.(hookContext);
    });
  } catch (error) {
    if (isGenerationControlError(error, options.signal)) throw error;
    await reconcileOwnedItemsAfterFailure(batchId, lease, error, false);
    throw error;
  }

  const final = await finalizeGeneration(batchId, lease);
  if (final.incomplete) throw final.incomplete;
  return { questions: final.summary.completed };
}

export async function markGenerationFailed(
  batchId: string,
  error: unknown,
  lease: JobLease,
) {
  return reconcileOwnedItemsAfterFailure(batchId, lease, error, true);
}
