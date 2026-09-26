import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  buildPublicQuestionRetrievalQuery,
  hashBenchmarkRetrievalSnapshot,
  orderPikeRetrievalChunks,
  type BenchmarkRetrievedChunk,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import { DomainError } from '@/domain/errors';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';
import { withProviderRetry } from '@/server/providers/retry';
import { isMockProviders, providerEnvFor } from '@/server/providers/credentials';
import {
  ProviderError,
  type ProviderErrorKind,
  type ProviderRateLimitDimension,
} from '@/server/providers/types';
import { resolveGenerationExecutionPins } from '@/server/settings/execution-pins';

type RetrievalItemRow = {
  id:string;
  benchmark_run_id:string;
  question_id:string;
  question_revision:number;
  retrieval_mode:StoredBenchmarkRetrievalMode;
  question_text:string;
  answer_options:unknown;
  quality_scores:unknown;
  generation_batch_id:string | null;
  generation_item_id:string | null;
  generation_retrieval_id:string | null;
};

type GenerationRetrievalRow = {
  id:string;
  generation_batch_id:string;
  generation_item_id:string | null;
  query_text:string;
  embedding_model:string | null;
  candidate_scope:unknown;
  selected_chunks:unknown;
};

type StoredRetrievalRow = {
  id:string;
  retrieval_mode:StoredBenchmarkRetrievalMode;
  query_text:string | null;
  embedding_model:string | null;
  embedding_profile_hash:string | null;
  vector_space_id:string | null;
  candidate_scope:unknown;
  selected_chunks:unknown;
  graph_trace:unknown;
  config_snapshot:unknown;
  config_hash:string | null;
  rendered_context:string | null;
  context_hash:string | null;
  shared_snapshot_key:string | null;
  shared_from_retrieval_id:string | null;
};

type SnapshotClaimRow = {
  snapshot_key:string;
  state:'COMPUTING' | 'READY' | 'FAILED';
  owner_id:string | null;
  lease_expires_at:Date | null;
  root_retrieval_id:string | null;
  error_snapshot:unknown;
};

type Queryable = Pick<PoolClient, 'query'>;

type ResolvedRetrieval = {
  queryText:string | null;
  embeddingModel:string | null;
  embeddingProfileHash:string | null;
  vectorSpaceId:string | null;
  candidateScope:Record<string, unknown>;
  selectedChunks:BenchmarkRetrievedChunk[];
  graphTrace:Record<string, unknown>;
  configSnapshot:Record<string, unknown>;
};

const STORED_RETRIEVAL_COLUMNS = `
  id,retrieval_mode,query_text,embedding_model,
  embedding_profile_hash,vector_space_id,candidate_scope,
  selected_chunks,graph_trace,config_snapshot,config_hash,
  rendered_context,context_hash,shared_snapshot_key,
  shared_from_retrieval_id
`;

const CLAIM_FAILED_RETRY_MS = 2_000;
const CLAIM_POLL_MS = 125;

function retrievalClaimLeaseMs():number {
  const configured = Number(
    process.env.BENCHMARK_RETRIEVAL_CLAIM_LEASE_MS ?? 150_000,
  );
  return Number.isFinite(configured)
    ? Math.max(1_000, configured)
    : 150_000;
}

export type BenchmarkRetrievalAudit = {
  id:string;
  mode:StoredBenchmarkRetrievalMode;
  queryText:string | null;
  embeddingModel:string | null;
  embeddingProfileHash:string | null;
  vectorSpaceId:string | null;
  candidateScope:Record<string, unknown>;
  selectedChunks:BenchmarkRetrievedChunk[];
  graphTrace:Record<string, unknown>;
  configSnapshot:Record<string, unknown>;
  configHash:string;
  renderedContext:string;
  contextHash:string;
  sharedSnapshotKey:string | null;
  sharedFromRetrievalId:string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function retrievalChunks(value: unknown): BenchmarkRetrievedChunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = objectValue(item);
    const chunkId = typeof row.chunkId === 'string' ? row.chunkId : '';
    const content = typeof row.content === 'string' ? row.content : '';
    if (!chunkId || !content) return [];
    return [{
      ...row,
      chunkId,
      content,
      rank:typeof row.rank === 'number' ? row.rank : undefined,
      page:typeof row.page === 'number' ? row.page : null,
      unit:typeof row.unit === 'string' ? row.unit : null,
      similarity:typeof row.similarity === 'number' ? row.similarity : null,
    } satisfies BenchmarkRetrievedChunk];
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function renderEvidence(chunks: readonly BenchmarkRetrievedChunk[]): string {
  return chunks.map((chunk, index) => {
    const page = typeof chunk.page === 'number'
      ? ` · p.${chunk.page}`
      : '';
    return `[근거 ${index + 1}${page}]\n${chunk.content}`;
  }).join('\n\n');
}

function benchmarkDesign(qualityScores: unknown): Record<string, unknown> {
  return objectValue(objectValue(qualityScores).benchmarkDesign);
}

function graphCitedIds(design: Record<string, unknown>): string[] {
  const concepts = Array.isArray(design.prerequisiteConcepts)
    ? design.prerequisiteConcepts
    : [];
  const relations = Array.isArray(design.prerequisiteRelations)
    ? design.prerequisiteRelations
    : [];
  return [...new Set([
    ...concepts.flatMap((concept) => {
      const ids = objectValue(concept).evidenceChunkIds;
      return Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string')
        : [];
    }),
    ...relations.flatMap((relation) => {
      const ids = objectValue(relation).evidenceChunkIds;
      return Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string')
        : [];
    }),
  ])];
}

function mapStored(row: StoredRetrievalRow): BenchmarkRetrievalAudit {
  if (
    row.candidate_scope == null
    || row.selected_chunks == null
    || row.graph_trace == null
    || row.config_snapshot == null
    || row.config_hash == null
    || row.rendered_context == null
    || row.context_hash == null
  ) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_CANONICAL_PAYLOAD_MISSING',
      '공유 검색 감사 receipt의 원본 payload를 복원하지 못했습니다.',
    );
  }
  return {
    id:row.id,
    mode:row.retrieval_mode,
    queryText:row.query_text,
    embeddingModel:row.embedding_model,
    embeddingProfileHash:row.embedding_profile_hash,
    vectorSpaceId:row.vector_space_id,
    candidateScope:objectValue(row.candidate_scope),
    selectedChunks:retrievalChunks(row.selected_chunks),
    graphTrace:objectValue(row.graph_trace),
    configSnapshot:objectValue(row.config_snapshot),
    configHash:row.config_hash,
    renderedContext:row.rendered_context,
    contextHash:row.context_hash,
    sharedSnapshotKey:row.shared_snapshot_key,
    sharedFromRetrievalId:row.shared_from_retrieval_id,
  };
}

async function loadGenerationRetrieval(
  item: RetrievalItemRow,
  queryable:Queryable,
): Promise<GenerationRetrievalRow> {
  if (
    !item.generation_retrieval_id
    && (!item.generation_batch_id || !item.generation_item_id)
  ) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_PROVENANCE_MISSING',
      '이 문항에는 질문 생성 검색 계보가 없어 RAG/Pike 조건을 실행할 수 없습니다.',
    );
  }
  const result = item.generation_retrieval_id
    ? await queryable.query<GenerationRetrievalRow>(
      `select id,generation_batch_id,generation_item_id,query_text,
         embedding_model,candidate_scope,selected_chunks
         from generation_retrievals
        where id=$1`,
      [item.generation_retrieval_id],
    )
    : await queryable.query<GenerationRetrievalRow>(
      `select id,generation_batch_id,generation_item_id,query_text,
         embedding_model,candidate_scope,selected_chunks
         from generation_retrievals
        where generation_batch_id=$1 and generation_item_id=$2
        order by attempt desc,created_at desc
        limit 1`,
      [item.generation_batch_id, item.generation_item_id],
    );
  if (!result.rows[0]) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_SNAPSHOT_MISSING',
      '문항 생성 당시의 검색 스냅샷이 없어 RAG/Pike 조건을 실행할 수 없습니다.',
    );
  }
  return result.rows[0];
}

async function legacyRetrieval(
  item: RetrievalItemRow,
  queryable:Queryable,
): Promise<{
  queryText:null;
  embeddingModel:null;
  embeddingProfileHash:null;
  vectorSpaceId:null;
  candidateScope:Record<string, unknown>;
  selectedChunks:BenchmarkRetrievedChunk[];
  graphTrace:Record<string, unknown>;
  configSnapshot:Record<string, unknown>;
}> {
  const evidence = await queryable.query<{
    chunk_id:string;
    content:string;
    quote_text:string | null;
    page_start:number | null;
    unit:string | null;
    source_file_id:string;
    source_revision_id:string;
    ordinal:number;
  }>(
    `select sc.id chunk_id,sc.content,qe.quote_text,sc.page_start,sc.unit,
       sc.source_file_id,sc.source_revision_id,sc.ordinal
       from question_evidence qe
       join source_chunks sc on sc.id=qe.source_chunk_id
      where qe.question_id=(
        select question_id from run_items where id=$1
      )
        and qe.question_revision=(
          select question_revision from run_items where id=$1
        )
      order by qe.ordinal`,
    [item.id],
  );
  return {
    queryText:null,
    embeddingModel:null,
    embeddingProfileHash:null,
    vectorSpaceId:null,
    candidateScope:{ source:'question_evidence' },
    selectedChunks:evidence.rows.map((row, index) => ({
      chunkId:row.chunk_id,
      content:row.quote_text ?? row.content,
      page:row.page_start,
      unit:row.unit,
      sourceFileId:row.source_file_id,
      sourceRevisionId:row.source_revision_id,
      ordinal:row.ordinal,
      rank:index + 1,
      source:'question_evidence',
    })),
    graphTrace:{},
    configSnapshot:{
      schemaVersion:1,
      strategy:'legacy-question-evidence',
    },
  };
}

async function vectorRetrieval(
  item: RetrievalItemRow,
  signal?:AbortSignal,
  queryable:Queryable = db,
): Promise<{
  queryText:string;
  embeddingModel:string;
  embeddingProfileHash:string;
  vectorSpaceId:string;
  candidateScope:Record<string, unknown>;
  selectedChunks:BenchmarkRetrievedChunk[];
  graphTrace:Record<string, unknown>;
  configSnapshot:Record<string, unknown>;
}> {
  const generation = await loadGenerationRetrieval(item, queryable);
  const candidateScope = objectValue(generation.candidate_scope);
  const sourceRevisionIds = Array.isArray(candidateScope.sourceRevisionIds)
    ? candidateScope.sourceRevisionIds.filter(
      (id): id is string => typeof id === 'string',
    )
    : [];
  if (!sourceRevisionIds.length) {
    throw new DomainError(
      'BENCHMARK_VECTOR_SCOPE_EMPTY',
      '단순 RAG가 검색할 교과서 리비전 범위가 비어 있습니다.',
    );
  }
  const pins = await resolveGenerationExecutionPins(
    generation.generation_batch_id,
    queryable,
  );
  const settings = pins.embeddingRag.definition.settings;
  const queryText = buildPublicQuestionRetrievalQuery({
    questionText:item.question_text,
    answerOptions:item.answer_options,
  });
  const mock = isMockProviders();
  const providerEnv = providerEnvFor(`run:${item.benchmark_run_id}`);
  let queryVector: string | null = null;
  let vectorAudit: Record<string, unknown> | null = null;
  if (!mock) {
    if (!providerEnv.GOOGLE_API_KEY) {
      throw new DomainError(
        'BENCHMARK_EMBEDDING_PROVIDER_NOT_CONFIGURED',
        '단순 RAG 질의 임베딩에 Gemini API 키가 필요합니다. 설정 화면에서 키를 입력한 뒤 재개하세요.',
      );
    }
    const embedder = new GeminiEmbedder({
      apiKey:providerEnv.GOOGLE_API_KEY,
      modelId:settings.model,
      dimensions:settings.dimensions,
      baseUrl:providerEnv.GEMINI_BASE_URL,
      timeoutMs:settings.requestTimeoutMs,
    });
    const queryInput = settings.prefixStrategy === 'text_prefix'
      ? `${settings.queryPrefix}${queryText}`
      : queryText;
    const [vector] = await withProviderRetry(
      () => embedder.embed(
        [queryInput],
        signal,
        settings.queryTaskType,
      ),
      {
        maxAttempts:3,
        baseDelayMs:500,
        signal,
        shouldRetry:(error) => error.kind !== 'RATE_LIMIT',
      },
    );
    const values = vector!;
    queryVector = `[${values.join(',')}]`;
    vectorAudit = {
      dimensions:values.length,
      norm:Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0),
      ),
      sha256:sha256(JSON.stringify(values)),
      taskType:settings.queryTaskType,
      prefixStrategy:settings.prefixStrategy,
    };
  }
  const result = await queryable.query<{
    id:string;
    content:string;
    page_start:number | null;
    unit:string | null;
    source_file_id:string;
    source_revision_id:string;
    ordinal:number;
    similarity:number | null;
    semantic_rank:number;
  }>(
    `select chunk.id,chunk.content,chunk.page_start,chunk.unit,
       chunk.source_file_id,chunk.source_revision_id,chunk.ordinal,
       case when $2::vector is null then null
            else (1-(chunk.embedding <=>$2::vector))::double precision
       end similarity,
       row_number() over(
         order by
           case when $2::vector is null then null
                else chunk.embedding <=>$2::vector end nulls last,
           chunk.source_file_id,chunk.ordinal
       )::int semantic_rank
       from source_chunks chunk
      where chunk.source_revision_id=any($1::uuid[])
        and (
          $5::boolean
          or (
            chunk.embedding is not null
            and chunk.embedding_rag_profile_hash=$3
            and chunk.embedding_vector_space_id=$4
            and chunk.embedding_rag_profile_snapshot_provenance=
                'AT_CREATION_VERIFIED'
          )
        )
      order by
        case when $2::vector is null then null
             else chunk.embedding <=>$2::vector end nulls last,
        chunk.source_file_id,chunk.ordinal
      limit $6`,
    [
      sourceRevisionIds,
      queryVector,
      pins.embeddingRag.contentHash,
      settings.vectorSpaceId,
      mock,
      settings.retrievalTopK,
    ],
  );
  if (!result.rows.length) {
    throw new DomainError(
      'BENCHMARK_VECTOR_EVIDENCE_EMPTY',
      '단순 벡터 검색에서 교과서 근거를 찾지 못했습니다.',
    );
  }
  return {
    queryText,
    embeddingModel:settings.model,
    embeddingProfileHash:pins.embeddingRag.contentHash,
    vectorSpaceId:settings.vectorSpaceId,
    candidateScope:{
      sourceRevisionIds,
      generationRetrievalId:generation.id,
      benchmarkQuestionRevision:item.question_revision,
      generationQuestionRevision:1,
      revisionRelation:item.question_revision === 1
        ? 'EXACT_GENERATED_REVISION'
        : 'REVIEWED_DERIVATIVE',
      scopePolicy:'generation-source-revisions',
      excludedFromQuery:[
        'answer_text',
        'accepted_answers',
        'scoring_criteria',
        'benchmark_design',
      ],
      queryVector:vectorAudit,
    },
    selectedChunks:result.rows.map((row, index) => ({
      chunkId:row.id,
      content:row.content,
      page:row.page_start,
      unit:row.unit,
      sourceFileId:row.source_file_id,
      sourceRevisionId:row.source_revision_id,
      ordinal:row.ordinal,
      rank:index + 1,
      semanticRank:row.semantic_rank,
      similarity:row.similarity,
      source:mock ? 'scope_order' : 'semantic',
    })),
    graphTrace:{},
    configSnapshot:{
      schemaVersion:1,
      strategy:'simple-vector-top-k',
      querySource:'public-question-and-options-only',
      topK:settings.retrievalTopK,
      neighborWindow:0,
      similarityMetric:'cosine',
      generationRetrievalId:generation.id,
      generationRetrievalPin:item.generation_retrieval_id
        ? 'RUN_CREATION_PINNED'
        : 'LEGACY_LATEST_ATTEMPT',
    },
  };
}

async function pikeRetrieval(
  item: RetrievalItemRow,
  queryable:Queryable,
): Promise<{
  queryText:string;
  embeddingModel:string | null;
  embeddingProfileHash:string | null;
  vectorSpaceId:string | null;
  candidateScope:Record<string, unknown>;
  selectedChunks:BenchmarkRetrievedChunk[];
  graphTrace:Record<string, unknown>;
  configSnapshot:Record<string, unknown>;
}> {
  const generation = await loadGenerationRetrieval(item, queryable);
  const selected = retrievalChunks(generation.selected_chunks);
  if (!selected.length) {
    throw new DomainError(
      'BENCHMARK_PIKE_EVIDENCE_EMPTY',
      '문항 생성 당시 Pike 검색 스냅샷에 교과서 근거가 없습니다.',
    );
  }
  const design = benchmarkDesign(item.quality_scores);
  const citedChunkIds = graphCitedIds(design);
  const ordered = orderPikeRetrievalChunks(selected, design);
  const candidateScope = objectValue(generation.candidate_scope);
  const queryVector = objectValue(candidateScope.queryVector);
  return {
    queryText:generation.query_text,
    embeddingModel:generation.embedding_model,
    embeddingProfileHash:(await resolveGenerationExecutionPins(
      generation.generation_batch_id,
      queryable,
    )).embeddingRag.contentHash,
    vectorSpaceId:typeof queryVector.vectorSpaceId === 'string'
      ? queryVector.vectorSpaceId
      : null,
    candidateScope:{
      ...candidateScope,
      generationRetrievalId:generation.id,
      benchmarkQuestionRevision:item.question_revision,
      generationQuestionRevision:1,
      revisionRelation:item.question_revision === 1
        ? 'EXACT_GENERATED_REVISION'
        : 'REVIEWED_DERIVATIVE',
    },
    selectedChunks:ordered.map((chunk, index) => ({
      ...chunk,
      rank:index + 1,
      pikePriority:citedChunkIds.includes(chunk.chunkId)
        ? 'graph-cited'
        : 'generation-retrieved',
    })),
    graphTrace:{
      graphApplied:citedChunkIds.length > 0,
      graphOperation:'POST_RETRIEVAL_EVIDENCE_PRIORITIZATION',
      graphDrivenRetrieval:false,
      graphCitedChunkIds:citedChunkIds,
      graphCitedChunkCount:citedChunkIds.length,
      selectedChunkCount:ordered.length,
      disclosurePolicy:'graph-structure-hidden-from-candidate',
    },
    configSnapshot:{
      schemaVersion:1,
      strategy:'pike-inspired-generation-graph-snapshot',
      retrievalSnapshotId:generation.id,
      retrievalSnapshotPin:item.generation_retrieval_id
        ? 'RUN_CREATION_PINNED'
        : 'LEGACY_LATEST_ATTEMPT',
      ordering:'prerequisite-graph-evidence-first',
      graphRole:'post-retrieval-evidence-prioritization',
      promptDisclosure:'chunk-content-only',
    },
  };
}

async function loadRetrievalItem(
  itemId:string,
  queryable:Queryable = db,
):Promise<RetrievalItemRow> {
  const result = await queryable.query<RetrievalItemRow>(
    `select ri.id,ri.benchmark_run_id,ri.question_id,
       ri.question_revision,ri.retrieval_mode,qr.question_text,
       qr.answer_options,qr.quality_scores,q.generation_batch_id,
       q.generation_item_id,ri.generation_retrieval_id
       from run_items ri
       join questions q on q.id=ri.question_id
       join question_revisions qr
         on qr.question_id=ri.question_id
        and qr.revision=ri.question_revision
      where ri.id=$1`,
    [itemId],
  );
  if (!result.rows[0]) {
    throw new DomainError(
      'RUN_ITEM_NOT_FOUND',
      '검색할 실행 항목을 찾을 수 없습니다.',
    );
  }
  return result.rows[0];
}

async function loadStoredForItem(
  itemId:string,
  queryable:Queryable = db,
):Promise<StoredRetrievalRow | null> {
  const result = await queryable.query<StoredRetrievalRow>(
    `select receipt.id,receipt.retrieval_mode,
       coalesce(receipt.query_text,root.query_text) query_text,
       coalesce(receipt.embedding_model,root.embedding_model) embedding_model,
       coalesce(receipt.embedding_profile_hash,root.embedding_profile_hash)
         embedding_profile_hash,
       coalesce(receipt.vector_space_id,root.vector_space_id) vector_space_id,
       coalesce(receipt.candidate_scope,root.candidate_scope) candidate_scope,
       coalesce(receipt.selected_chunks,root.selected_chunks) selected_chunks,
       coalesce(receipt.graph_trace,root.graph_trace) graph_trace,
       coalesce(receipt.config_snapshot,root.config_snapshot) config_snapshot,
       coalesce(receipt.config_hash,root.config_hash) config_hash,
       coalesce(receipt.rendered_context,root.rendered_context) rendered_context,
       coalesce(receipt.context_hash,root.context_hash) context_hash,
       receipt.shared_snapshot_key,receipt.shared_from_retrieval_id
       from run_item_retrievals receipt
       left join run_item_retrievals root
         on root.id=receipt.shared_from_retrieval_id
      where receipt.run_item_id=$1`,
    [itemId],
  );
  return result.rows[0] ?? null;
}

async function loadStoredById(
  retrievalId:string,
  queryable:Queryable,
):Promise<StoredRetrievalRow | null> {
  const result = await queryable.query<StoredRetrievalRow>(
    `select receipt.id,receipt.retrieval_mode,
       coalesce(receipt.query_text,root.query_text) query_text,
       coalesce(receipt.embedding_model,root.embedding_model) embedding_model,
       coalesce(receipt.embedding_profile_hash,root.embedding_profile_hash)
         embedding_profile_hash,
       coalesce(receipt.vector_space_id,root.vector_space_id) vector_space_id,
       coalesce(receipt.candidate_scope,root.candidate_scope) candidate_scope,
       coalesce(receipt.selected_chunks,root.selected_chunks) selected_chunks,
       coalesce(receipt.graph_trace,root.graph_trace) graph_trace,
       coalesce(receipt.config_snapshot,root.config_snapshot) config_snapshot,
       coalesce(receipt.config_hash,root.config_hash) config_hash,
       coalesce(receipt.rendered_context,root.rendered_context) rendered_context,
       coalesce(receipt.context_hash,root.context_hash) context_hash,
       receipt.shared_snapshot_key,receipt.shared_from_retrieval_id
       from run_item_retrievals receipt
       left join run_item_retrievals root
         on root.id=receipt.shared_from_retrieval_id
      where receipt.id=$1`,
    [retrievalId],
  );
  return result.rows[0] ?? null;
}

async function loadCanonicalPeer(
  item:RetrievalItemRow,
  queryable:Queryable,
):Promise<StoredRetrievalRow | null> {
  const peer = await queryable.query<StoredRetrievalRow>(
    `select retrieval.id,retrieval.retrieval_mode,
       retrieval.query_text,retrieval.embedding_model,
       retrieval.embedding_profile_hash,retrieval.vector_space_id,
       retrieval.candidate_scope,retrieval.selected_chunks,
       retrieval.graph_trace,retrieval.config_snapshot,
       retrieval.config_hash,retrieval.rendered_context,
       retrieval.context_hash,retrieval.shared_snapshot_key,
       retrieval.shared_from_retrieval_id
       from run_item_retrievals retrieval
       join run_items peer_item
         on peer_item.id=retrieval.run_item_id
      where peer_item.benchmark_run_id=$1
        and peer_item.question_id=$2
        and peer_item.question_revision=$3
        and peer_item.retrieval_mode=$4
      order by retrieval.created_at,retrieval.id
      limit 1`,
    [
      item.benchmark_run_id,
      item.question_id,
      item.question_revision,
      item.retrieval_mode,
    ],
  );
  const source = peer.rows[0];
  if (!source?.shared_from_retrieval_id) return source ?? null;
  return await loadStoredById(
    source.shared_from_retrieval_id,
    queryable,
  ) ?? source;
}

async function cloneStoredRetrieval(
  input:{
    item:RetrievalItemRow;
    rootRetrievalId:string;
    sharedSnapshotKey:string;
  },
  queryable:Queryable,
):Promise<StoredRetrievalRow> {
  await queryable.query(
    `insert into run_item_retrievals(
       run_item_id,retrieval_mode,query_text,embedding_model,
       embedding_profile_hash,vector_space_id,candidate_scope,
       selected_chunks,graph_trace,config_snapshot,config_hash,
       rendered_context,context_hash,shared_snapshot_key,
       shared_from_retrieval_id
     ) values(
       $1,$2,null,null,null,null,null,null,null,null,null,null,null,$3,$4
     )
     on conflict (run_item_id) do nothing
     returning id`,
    [
      input.item.id,
      input.item.retrieval_mode,
      input.sharedSnapshotKey,
      input.rootRetrievalId,
    ],
  );
  const stored = await loadStoredForItem(input.item.id, queryable);
  if (!stored) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_AUDIT_PERSIST_FAILED',
      '공유 검색 결과 감사 기록을 저장하지 못했습니다.',
    );
  }
  return stored;
}

function providerErrorKind(value:unknown):ProviderErrorKind {
  const allowed:ProviderErrorKind[] = [
    'AUTH',
    'RATE_LIMIT',
    'TIMEOUT',
    'NETWORK',
    'INVALID_REQUEST',
    'CONTENT_FILTER',
    'PROVIDER_5XX',
    'PARSE',
    'UNKNOWN',
  ];
  return allowed.includes(value as ProviderErrorKind)
    ? value as ProviderErrorKind
    : 'UNKNOWN';
}

function rateLimitDimension(
  value:unknown,
):ProviderRateLimitDimension {
  return ['RPM', 'RPD', 'TPM', 'UNKNOWN'].includes(String(value))
    ? value as ProviderRateLimitDimension
    : 'UNKNOWN';
}

function serializeRetrievalError(error:unknown):Record<string, unknown> {
  if (error instanceof ProviderError) {
    return {
      type:'provider',
      name:error.name,
      message:error.message,
      kind:error.kind,
      retryable:error.retryable,
      status:error.status,
      requestId:error.requestId,
      retryAfterMs:error.retryAfterMs,
      rateLimitDimension:error.rateLimitDimension,
      rateLimitScope:error.rateLimitScope,
    };
  }
  if (error instanceof DomainError) {
    const prefix = `${error.code}: `;
    return {
      type:'domain',
      name:error.name,
      code:error.code,
      message:error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message,
      details:error.details ?? null,
    };
  }
  return {
    type:'error',
    name:error instanceof Error ? error.name : 'Error',
    message:error instanceof Error
      ? error.message
      : '검색 스냅샷 계산 중 알 수 없는 오류가 발생했습니다.',
  };
}

function restoreRetrievalError(snapshot:unknown):Error {
  const stored = objectValue(snapshot);
  const message = typeof stored.message === 'string'
    ? stored.message
    : '검색 스냅샷 계산에 실패했습니다.';
  if (stored.type === 'provider') {
    return new ProviderError({
      kind:providerErrorKind(stored.kind),
      message,
      retryable:stored.retryable === true,
      status:typeof stored.status === 'number' ? stored.status : null,
      requestId:typeof stored.requestId === 'string'
        ? stored.requestId
        : null,
      retryAfterMs:typeof stored.retryAfterMs === 'number'
        ? stored.retryAfterMs
        : null,
      rateLimitDimension:rateLimitDimension(
        stored.rateLimitDimension,
      ),
      rateLimitScope:typeof stored.rateLimitScope === 'string'
        ? stored.rateLimitScope
        : null,
    });
  }
  if (stored.type === 'domain' && typeof stored.code === 'string') {
    return new DomainError(
      stored.code,
      message,
      objectValue(stored.details),
    );
  }
  const error = new Error(message);
  if (typeof stored.name === 'string') error.name = stored.name;
  return error;
}

async function waitForSnapshotClaim(
  durationMs:number,
  signal?:AbortSignal,
):Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once:true });
  });
}

async function tryAcquireSnapshotClaim(
  item:RetrievalItemRow,
  sharedSnapshotKey:string,
  ownerId:string,
):Promise<boolean> {
  const leaseExpiresAt = new Date(
    Date.now() + retrievalClaimLeaseMs(),
  );
  const inserted = await db.query<{ owner_id:string }>(
    `insert into benchmark_retrieval_snapshot_claims(
       snapshot_key,benchmark_run_id,question_id,question_revision,
       retrieval_mode,state,owner_id,lease_expires_at
     ) values($1,$2,$3,$4,$5,'COMPUTING',$6,$7)
     on conflict do nothing
     returning owner_id`,
    [
      sharedSnapshotKey,
      item.benchmark_run_id,
      item.question_id,
      item.question_revision,
      item.retrieval_mode,
      ownerId,
      leaseExpiresAt,
    ],
  );
  if (inserted.rows[0]?.owner_id === ownerId) return true;
  const takenOver = await db.query<{ owner_id:string }>(
    `update benchmark_retrieval_snapshot_claims
        set state='COMPUTING',
            owner_id=$2,
            lease_expires_at=$3,
            root_retrieval_id=null,
            error_snapshot=null,
            updated_at=now()
      where snapshot_key=$1
        and state in ('COMPUTING','FAILED')
        and lease_expires_at<=now()
      returning owner_id`,
    [sharedSnapshotKey, ownerId, leaseExpiresAt],
  );
  return takenOver.rows[0]?.owner_id === ownerId;
}

async function loadSnapshotClaim(
  sharedSnapshotKey:string,
):Promise<SnapshotClaimRow | null> {
  const result = await db.query<SnapshotClaimRow>(
    `select snapshot_key,state,owner_id,lease_expires_at,
       root_retrieval_id,error_snapshot
       from benchmark_retrieval_snapshot_claims
      where snapshot_key=$1`,
    [sharedSnapshotKey],
  );
  return result.rows[0] ?? null;
}

function assertClaimOwner(
  claim:SnapshotClaimRow | undefined,
  ownerId:string,
):void {
  if (
    claim?.state !== 'COMPUTING'
    || claim.owner_id !== ownerId
  ) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_CLAIM_LOST',
      '검색 스냅샷 계산 소유권이 다른 워커로 이전되었습니다.',
    );
  }
}

function startSnapshotClaimHeartbeat(
  sharedSnapshotKey:string,
  ownerId:string,
):{
  signal:AbortSignal;
  stop:()=>void;
} {
  const controller = new AbortController();
  const leaseMs = retrievalClaimLeaseMs();
  const intervalMs = Math.max(
    250,
    Math.min(30_000, Math.floor(leaseMs / 3)),
  );
  let stopped = false;
  let renewing = false;
  const timer = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    const leaseExpiresAt = new Date(Date.now() + leaseMs);
    db.query(
      `update benchmark_retrieval_snapshot_claims
          set lease_expires_at=$3,updated_at=now()
        where snapshot_key=$1
          and state='COMPUTING'
          and owner_id=$2
          and lease_expires_at>now()`,
      [sharedSnapshotKey, ownerId, leaseExpiresAt],
    ).then((result) => {
      if (!stopped && !result.rowCount) {
        controller.abort(new DomainError(
          'BENCHMARK_RETRIEVAL_CLAIM_LOST',
          '검색 스냅샷 계산 소유권을 갱신하지 못했습니다.',
        ));
      }
    }).catch(() => {
      if (!stopped) {
        controller.abort(new DomainError(
          'BENCHMARK_RETRIEVAL_CLAIM_RENEWAL_FAILED',
          '검색 스냅샷 계산 임대를 갱신하지 못했습니다.',
        ));
      }
    }).finally(() => {
      renewing = false;
    });
  }, intervalMs);
  timer.unref?.();
  return {
    signal:controller.signal,
    stop:() => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function markSnapshotClaimFailed(
  sharedSnapshotKey:string,
  ownerId:string,
  error:unknown,
):Promise<void> {
  await db.query(
    `update benchmark_retrieval_snapshot_claims
        set state='FAILED',
            owner_id=null,
            lease_expires_at=$3,
            root_retrieval_id=null,
            error_snapshot=$4::jsonb,
            updated_at=now()
      where snapshot_key=$1
        and state='COMPUTING'
        and owner_id=$2`,
    [
      sharedSnapshotKey,
      ownerId,
      new Date(Date.now() + CLAIM_FAILED_RETRY_MS),
      JSON.stringify(serializeRetrievalError(error)),
    ],
  );
}

async function relinquishSnapshotClaim(
  sharedSnapshotKey:string,
  ownerId:string,
):Promise<void> {
  await db.query(
    `update benchmark_retrieval_snapshot_claims
        set owner_id=$3,
            lease_expires_at=now(),
            updated_at=now()
      where snapshot_key=$1
        and state='COMPUTING'
        and owner_id=$2`,
    [sharedSnapshotKey, ownerId, randomUUID()],
  );
}

function isOwnerLocalRetrievalFailure(
  error:unknown,
  inputSignal:AbortSignal | undefined,
  claimSignal:AbortSignal,
):boolean {
  if (inputSignal?.aborted || claimSignal.aborted) return true;
  return error instanceof DomainError && [
    'BENCHMARK_RETRIEVAL_CLAIM_LOST',
    'BENCHMARK_RETRIEVAL_CLAIM_RENEWAL_FAILED',
  ].includes(error.code);
}

async function finalizeClaimFromPeer(
  item:RetrievalItemRow,
  sharedSnapshotKey:string,
  ownerId:string,
):Promise<BenchmarkRetrievalAudit> {
  return withTransaction(async (client) => {
    const claimResult = await client.query<SnapshotClaimRow>(
      `select snapshot_key,state,owner_id,lease_expires_at,
         root_retrieval_id,error_snapshot
         from benchmark_retrieval_snapshot_claims
        where snapshot_key=$1
        for update`,
      [sharedSnapshotKey],
    );
    assertClaimOwner(claimResult.rows[0], ownerId);
    const current = await loadStoredForItem(item.id, client);
    const source = current ?? await loadCanonicalPeer(item, client);
    if (!source) {
      throw new DomainError(
        'BENCHMARK_RETRIEVAL_PEER_DISAPPEARED',
        '기존 공유 검색 스냅샷을 찾지 못했습니다.',
      );
    }
    const rootRetrievalId = source.shared_from_retrieval_id
      ?? source.id;
    const canonical = rootRetrievalId === source.id
      ? source
      : await loadStoredById(rootRetrievalId, client) ?? source;
    const stored = current ?? await cloneStoredRetrieval({
      item,
      rootRetrievalId:canonical.id,
      sharedSnapshotKey,
    }, client);
    await client.query(
      `update benchmark_retrieval_snapshot_claims
          set state='READY',
              owner_id=null,
              lease_expires_at=null,
              root_retrieval_id=$3,
              error_snapshot=null,
              updated_at=now()
        where snapshot_key=$1
          and state='COMPUTING'
          and owner_id=$2`,
      [sharedSnapshotKey, ownerId, canonical.id],
    );
    return mapStored(stored);
  });
}

async function finalizeComputedClaim(
  item:RetrievalItemRow,
  sharedSnapshotKey:string,
  ownerId:string,
  resolved:ResolvedRetrieval,
):Promise<BenchmarkRetrievalAudit> {
  const renderedContext = renderEvidence(resolved.selectedChunks);
  const configHash = hashBenchmarkRetrievalSnapshot(
    resolved.configSnapshot,
  );
  const contextHash = sha256(renderedContext);
  return withTransaction(async (client) => {
    const claimResult = await client.query<SnapshotClaimRow>(
      `select snapshot_key,state,owner_id,lease_expires_at,
         root_retrieval_id,error_snapshot
         from benchmark_retrieval_snapshot_claims
        where snapshot_key=$1
        for update`,
      [sharedSnapshotKey],
    );
    assertClaimOwner(claimResult.rows[0], ownerId);
    const existing = await loadStoredForItem(item.id, client);
    let stored = existing;
    if (!stored) {
      const inserted = await client.query<StoredRetrievalRow>(
        `insert into run_item_retrievals(
           run_item_id,retrieval_mode,query_text,embedding_model,
           embedding_profile_hash,vector_space_id,candidate_scope,
           selected_chunks,graph_trace,config_snapshot,config_hash,
           rendered_context,context_hash,shared_snapshot_key,
           shared_from_retrieval_id
         ) values(
           $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
           $11,$12,$13,$14,null
         )
         returning ${STORED_RETRIEVAL_COLUMNS}`,
        [
          item.id,
          item.retrieval_mode,
          resolved.queryText,
          resolved.embeddingModel,
          resolved.embeddingProfileHash,
          resolved.vectorSpaceId,
          JSON.stringify(resolved.candidateScope),
          JSON.stringify(resolved.selectedChunks.map((chunk) => ({
            ...chunk,
            contentHash:sha256(chunk.content),
          }))),
          JSON.stringify(resolved.graphTrace),
          JSON.stringify(resolved.configSnapshot),
          configHash,
          renderedContext,
          contextHash,
          sharedSnapshotKey,
        ],
      );
      stored = inserted.rows[0] ?? null;
    }
    if (!stored) {
      throw new DomainError(
        'BENCHMARK_RETRIEVAL_AUDIT_PERSIST_FAILED',
        '검색 결과 감사 기록을 저장하지 못했습니다.',
      );
    }
    const rootRetrievalId = stored.shared_from_retrieval_id
      ?? stored.id;
    await client.query(
      `update benchmark_retrieval_snapshot_claims
          set state='READY',
              owner_id=null,
              lease_expires_at=null,
              root_retrieval_id=$3,
              error_snapshot=null,
              updated_at=now()
        where snapshot_key=$1
          and state='COMPUTING'
          and owner_id=$2`,
      [sharedSnapshotKey, ownerId, rootRetrievalId],
    );
    return mapStored(stored);
  });
}

async function validatedClaimRootId(
  item:RetrievalItemRow,
  claimRootId:string,
  sharedSnapshotKey:string,
  client:PoolClient,
):Promise<string> {
  const result = await client.query<{
    root_id:string;
    source_mode:string;
    source_snapshot_key:string | null;
    source_benchmark_run_id:string;
    source_question_id:string;
    source_question_revision:number;
    root_shared_from_retrieval_id:string | null;
    root_mode:string;
    root_snapshot_key:string | null;
    root_benchmark_run_id:string;
    root_question_id:string;
    root_question_revision:number;
    root_payload_complete:boolean;
  }>(
    `select canonical.id root_id,
       source.retrieval_mode source_mode,
       source.shared_snapshot_key source_snapshot_key,
       source_item.benchmark_run_id source_benchmark_run_id,
       source_item.question_id source_question_id,
       source_item.question_revision source_question_revision,
       canonical.shared_from_retrieval_id root_shared_from_retrieval_id,
       canonical.retrieval_mode root_mode,
       canonical.shared_snapshot_key root_snapshot_key,
       root_item.benchmark_run_id root_benchmark_run_id,
       root_item.question_id root_question_id,
       root_item.question_revision root_question_revision,
       (
         canonical.candidate_scope is not null
         and canonical.selected_chunks is not null
         and canonical.graph_trace is not null
         and canonical.config_snapshot is not null
         and canonical.config_hash is not null
         and canonical.rendered_context is not null
         and canonical.context_hash is not null
       ) root_payload_complete
       from run_item_retrievals source
       join run_items source_item on source_item.id=source.run_item_id
       join run_item_retrievals canonical
         on canonical.id=coalesce(
           source.shared_from_retrieval_id,
           source.id
         )
       join run_items root_item on root_item.id=canonical.run_item_id
      where source.id=$1
      for share of source,source_item,canonical,root_item`,
    [claimRootId],
  );
  const root = result.rows[0];
  if (!root) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_ROOT_MISSING',
      '공유 검색 스냅샷의 원본 감사 기록을 찾지 못했습니다.',
    );
  }
  const identityMatches = (
    root.source_benchmark_run_id === item.benchmark_run_id
    && root.source_question_id === item.question_id
    && root.source_question_revision === item.question_revision
    && root.root_benchmark_run_id === item.benchmark_run_id
    && root.root_question_id === item.question_id
    && root.root_question_revision === item.question_revision
  );
  if (
    !identityMatches
    || root.source_mode !== item.retrieval_mode
    || root.root_mode !== item.retrieval_mode
    || root.source_snapshot_key !== sharedSnapshotKey
    || root.root_snapshot_key !== sharedSnapshotKey
  ) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_CLAIM_ROOT_MISMATCH',
      '공유 검색 claim의 모드 또는 스냅샷 신원이 실행 항목과 일치하지 않습니다.',
    );
  }
  if (
    root.root_shared_from_retrieval_id !== null
    || !root.root_payload_complete
  ) {
    throw new DomainError(
      'BENCHMARK_RETRIEVAL_CANONICAL_PAYLOAD_MISSING',
      '공유 검색 claim이 완전한 직접 원본 감사 기록을 가리키지 않습니다.',
    );
  }
  return root.root_id;
}

async function cloneReadyClaim(
  item:RetrievalItemRow,
  claim:SnapshotClaimRow,
  sharedSnapshotKey:string,
):Promise<BenchmarkRetrievalAudit> {
  return withTransaction(async (client) => {
    const existing = await loadStoredForItem(item.id, client);
    if (existing) return mapStored(existing);
    if (!claim.root_retrieval_id) {
      throw new DomainError(
        'BENCHMARK_RETRIEVAL_READY_WITHOUT_ROOT',
        '완료된 검색 스냅샷의 원본 감사 기록이 없습니다.',
      );
    }
    const rootRetrievalId = await validatedClaimRootId(
      item,
      claim.root_retrieval_id,
      sharedSnapshotKey,
      client,
    );
    return mapStored(await cloneStoredRetrieval({
      item,
      rootRetrievalId,
      sharedSnapshotKey,
    }, client));
  });
}

async function computeOwnedRetrieval(
  item:RetrievalItemRow,
  sharedSnapshotKey:string,
  ownerId:string,
  signal?:AbortSignal,
):Promise<BenchmarkRetrievalAudit> {
  const heartbeat = startSnapshotClaimHeartbeat(
    sharedSnapshotKey,
    ownerId,
  );
  const lifecycleSignal = signal
    ? AbortSignal.any([signal, heartbeat.signal])
    : heartbeat.signal;
  try {
    const peer = await loadCanonicalPeer(item, db);
    if (peer) {
      heartbeat.stop();
      return await finalizeClaimFromPeer(
        item,
        sharedSnapshotKey,
        ownerId,
      );
    }
    lifecycleSignal.throwIfAborted();
    const resolved:ResolvedRetrieval = item.retrieval_mode === 'NONE'
      ? {
        queryText:null,
        embeddingModel:null,
        embeddingProfileHash:null,
        vectorSpaceId:null,
        candidateScope:{},
        selectedChunks:[],
        graphTrace:{},
        configSnapshot:{
          schemaVersion:1,
          strategy:'none',
          context:'none',
        },
      }
      : item.retrieval_mode === 'VECTOR'
        ? await vectorRetrieval(item, lifecycleSignal, db)
        : item.retrieval_mode === 'PIKE'
          ? await pikeRetrieval(item, db)
          : await legacyRetrieval(item, db);
    lifecycleSignal.throwIfAborted();
    heartbeat.stop();
    return await finalizeComputedClaim(
      item,
      sharedSnapshotKey,
      ownerId,
      resolved,
    );
  } catch (error) {
    heartbeat.stop();
    if (isOwnerLocalRetrievalFailure(
      error,
      signal,
      heartbeat.signal,
    )) {
      await relinquishSnapshotClaim(
        sharedSnapshotKey,
        ownerId,
      ).catch(() => undefined);
    } else {
      await markSnapshotClaimFailed(
        sharedSnapshotKey,
        ownerId,
        error,
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function resolveRunItemRetrieval(
  itemId: string,
  signal?:AbortSignal,
): Promise<BenchmarkRetrievalAudit> {
  signal?.throwIfAborted();
  const existing = await loadStoredForItem(itemId);
  if (existing) return mapStored(existing);

  const item = await loadRetrievalItem(itemId);
  const snapshotIdentity = [
    item.benchmark_run_id,
    item.question_id,
    item.question_revision,
    item.retrieval_mode,
  ].join(':');
  const sharedSnapshotKey = sha256(snapshotIdentity);
  const ownerId = randomUUID();
  if (await tryAcquireSnapshotClaim(
    item,
    sharedSnapshotKey,
    ownerId,
  )) {
    return computeOwnedRetrieval(
      item,
      sharedSnapshotKey,
      ownerId,
      signal,
    );
  }

  while (true) {
    signal?.throwIfAborted();
    const stored = await loadStoredForItem(item.id);
    if (stored) return mapStored(stored);
    const claim = await loadSnapshotClaim(sharedSnapshotKey);
    if (!claim) {
      if (await tryAcquireSnapshotClaim(
        item,
        sharedSnapshotKey,
        ownerId,
      )) {
        return computeOwnedRetrieval(
          item,
          sharedSnapshotKey,
          ownerId,
          signal,
        );
      }
      await waitForSnapshotClaim(CLAIM_POLL_MS, signal);
      continue;
    }
    if (claim.state === 'READY') {
      return cloneReadyClaim(item, claim, sharedSnapshotKey);
    }
    const leaseExpiresAt = claim.lease_expires_at?.getTime() ?? 0;
    if (
      claim.state === 'FAILED'
      && leaseExpiresAt > Date.now()
    ) {
      throw restoreRetrievalError(claim.error_snapshot);
    }
    if (leaseExpiresAt <= Date.now()) {
      if (await tryAcquireSnapshotClaim(
        item,
        sharedSnapshotKey,
        ownerId,
      )) {
        return computeOwnedRetrieval(
          item,
          sharedSnapshotKey,
          ownerId,
          signal,
        );
      }
      continue;
    }
    await waitForSnapshotClaim(
      Math.min(CLAIM_POLL_MS, leaseExpiresAt - Date.now()),
      signal,
    );
  }
}
