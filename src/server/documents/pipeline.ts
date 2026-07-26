import { readFile } from 'node:fs/promises';
import { chunkTextbook } from '@/domain/chunking';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import {
  streamPdfPages,
  type RenderedPage,
  type RenderPdfPagesOptions,
  type StreamedPage,
} from '@/server/documents/page-renderer';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';
import { UpstageDocumentParser, type DocumentParseOptions } from '@/server/providers/upstage-document';
import { upstageDocumentParseDistributedGate } from '@/server/providers/postgres-concurrency-gate';
import {
  withProviderRetry,
  type RetryOptions as ProviderRetryOptions,
} from '@/server/providers/retry';
import { recordSourceEvent } from '@/server/sources/activity';
import { extractTableOfContents } from '@/domain/toc';
import { replaceSourceTocEntries } from '@/server/sources/toc';
import { mapConcurrentOrdered } from '@/domain/parallel';
import { resolveSourceExecutionPins } from '@/server/settings/execution-pins';
import {
  effectiveDocumentParseConcurrency,
  DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS,
} from '@/domain/document-parse-config';
import {
  classifyDocumentFailure,
  DocumentPageParseExhaustedError,
} from '@/server/documents/failure';
import { ProviderError } from '@/server/providers/types';

export {
  effectiveDocumentParseConcurrency,
  DEFAULT_UPSTAGE_DOCUMENT_PARSE_CONCURRENCY_CAP,
} from '@/domain/document-parse-config';

function vectorLiteral(values: number[]): string { return `[${values.join(',')}]`; }

type ParsedPage = {
  html: string;
  markdown?:string;
  raw: unknown;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
};

type PageParser = {
  parse(bytes: Uint8Array, filename: string, options: DocumentParseOptions): Promise<ParsedPage>;
};

export type ParseDocumentPagesDependencies = {
  renderPdfPages?: (bytes: Uint8Array) => Promise<RenderedPage[]>;
  streamPdfPages?: (bytes: Uint8Array) => AsyncIterable<StreamedPage>;
  parser: PageParser;
  signal?: AbortSignal;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => Promise<void> | void;
  batchSize?: number;
  concurrency?: number;
  providerRetry?: Pick<
    ProviderRetryOptions,
    'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random'
  >;
  rasterization?: Pick<
    RenderPdfPagesOptions,
    'format' | 'dpi' | 'jpegQuality' | 'timeoutMs' | 'pagesPerBatch'
  >;
};

type PipelinePage = RenderedPage | StreamedPage;

type LightweightPageMetadata = {
  pageNumber: number;
  filename: string;
  mimeType: PipelinePage['mimeType'];
  width?: number | null;
  height?: number | null;
};

type PersistedPageProvenance = {
  pageNumber: number;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
};

export type PersistedPageArtifact = PersistedPageProvenance & LightweightPageMetadata & {
  html: string;
  markdown: string | null;
  raw: unknown;
};

type ParsedDocumentPages = {
  html: string;
  markdown:string | null;
  raw: { pageCount: number; pages: PersistedPageProvenance[] };
  pageArtifacts: PersistedPageArtifact[];
  requestId: string | null;
  model: string | null;
};

export const MAX_LIVE_ARTIFACT_PREVIEW_CHARS = 4_000;
export const DOCUMENT_PARSE_PAGES_PER_TASK = 1;

function liveTextPreview(value: string | null | undefined) {
  if (value == null) return { value: null, truncated: false };
  return {
    value: value.slice(0, MAX_LIVE_ARTIFACT_PREVIEW_CHARS),
    truncated: value.length > MAX_LIVE_ARTIFACT_PREVIEW_CHARS,
  };
}

function liveJsonPreview(value: unknown) {
  try {
    return liveTextPreview(JSON.stringify(value));
  } catch {
    return { value: '[직렬화할 수 없는 파서 응답]', truncated: true };
  }
}

async function* arrayPages(pages: Promise<RenderedPage[]>): AsyncGenerator<RenderedPage> {
  for (const page of await pages) yield page;
}

function lightweightPageMetadata(page: PipelinePage): LightweightPageMetadata {
  return {
    pageNumber: page.pageNumber,
    filename: page.filename,
    mimeType: page.mimeType,
    width: page.width,
    height: page.height,
  };
}

export function parseDocumentPages(bytes: Uint8Array, dependencies: ParseDocumentPagesDependencies): Promise<ParsedDocumentPages>;
export function parseDocumentPages(bytes: Uint8Array, filename: string, dependencies: ParseDocumentPagesDependencies): Promise<ParsedDocumentPages>;
export async function parseDocumentPages(
  bytes: Uint8Array,
  filenameOrDependencies: string | ParseDocumentPagesDependencies,
  maybeDependencies?: ParseDocumentPagesDependencies,
) {
  const dependencies = typeof filenameOrDependencies === 'string' ? maybeDependencies! : filenameOrDependencies;
  const pages: AsyncIterable<PipelinePage> = dependencies.streamPdfPages
    ? dependencies.streamPdfPages(bytes)
    : dependencies.renderPdfPages
      ? arrayPages(dependencies.renderPdfPages(bytes))
      : streamPdfPages(bytes, {
        signal:dependencies.signal,
        timeoutMs:dependencies.rasterization?.timeoutMs
          ?? Number(process.env.PROVIDER_TIMEOUT_MS || 120_000),
        format:dependencies.rasterization?.format,
        dpi:dependencies.rasterization?.dpi,
        jpegQuality:dependencies.rasterization?.jpegQuality,
        pagesPerBatch:dependencies.rasterization?.pagesPerBatch ?? dependencies.batchSize,
        onEvent:dependencies.onEvent,
      });
  const parsedPages: Array<{ page: LightweightPageMetadata; parsed: ParsedPage }> = [];
  const batchSize = dependencies.batchSize ?? Math.max(1, Number(process.env.DOCUMENT_PARSE_BATCH_SIZE ?? 4));
  const concurrency = dependencies.concurrency ?? Math.max(1, Number(process.env.DOCUMENT_PARSE_CONCURRENCY ?? 3));
  let pendingBatch: PipelinePage[] = [];
  let activeBatches: Array<Promise<
    | { ok: true; results: Array<{ page: LightweightPageMetadata; parsed: ParsedPage }> }
    | { ok: false; error: unknown }
  >> = [];
  let batchIndex = 0;

  const parseBatch = async (batch: { index: number; pages: PipelinePage[] }) => {
    await dependencies.onEvent?.('DOCUMENT_PARSE_BATCH_STARTED', { batchIndex: batch.index + 1, pageNumbers: batch.pages.map((page) => page.pageNumber), concurrency });
    const results: Array<{ page: LightweightPageMetadata; parsed: ParsedPage }> = [];
    for (const page of batch.pages) {
      await dependencies.onEvent?.('DOCUMENT_PAGE_PARSE_STARTED', { pageNumber: page.pageNumber, filename: page.filename, imageBytes: page.bytes.byteLength, batchIndex: batch.index + 1 });
      let parsed: ParsedPage;
      try {
        const providerRetry = dependencies.providerRetry ?? {
          maxAttempts:DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS,
          baseDelayMs:2_000,
          maxDelayMs:60_000,
        };
        parsed = await withProviderRetry(
          () => dependencies.parser.parse(
            page.bytes,
            page.filename,
            {
              mimeType:page.mimeType,
              pageNumber:page.pageNumber,
              signal:dependencies.signal,
            },
          ),
          {
            ...providerRetry,
            signal:dependencies.signal,
            onRetry:async ({ attempt, delayMs, error }) => {
              await dependencies.onEvent?.('DOCUMENT_PAGE_PARSE_RETRY', {
                pageNumber:page.pageNumber,
                filename:page.filename,
                batchIndex:batch.index + 1,
                failedAttempt:attempt,
                nextAttempt:attempt + 1,
                delayMs,
                kind:error.kind,
                status:error.status,
                requestId:error.requestId,
                message:error.message,
              });
            },
          },
        );
      } catch (error) {
        if (dependencies.signal?.aborted) throw dependencies.signal.reason;
        if (error instanceof ProviderError && error.retryable) {
          throw new DocumentPageParseExhaustedError(page.pageNumber, error);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`DOCUMENT_PARSE_PAGE_${page.pageNumber}: ${message}`, { cause: error });
      } finally {
        page.bytes = new Uint8Array(0);
      }
      results.push({ page: lightweightPageMetadata(page), parsed });
      const htmlPreview = liveTextPreview(parsed.html);
      const markdownPreview = liveTextPreview(parsed.markdown);
      const rawPreview = liveJsonPreview(parsed.raw);
      await dependencies.onEvent?.('DOCUMENT_PAGE_PARSE_COMPLETED', {
        pageNumber: page.pageNumber,
        requestId: parsed.requestId,
        model: parsed.model,
        htmlBytes: Buffer.byteLength(parsed.html, 'utf8'),
        markdownBytes: parsed.markdown == null
          ? null
          : Buffer.byteLength(parsed.markdown, 'utf8'),
        requestConfig: parsed.requestConfig,
        batchIndex: batch.index + 1,
        htmlPreview: htmlPreview.value,
        markdownPreview: markdownPreview.value,
        rawPreview: rawPreview.value,
        outputTruncated: htmlPreview.truncated
          || markdownPreview.truncated
          || rawPreview.truncated,
      });
    }
    await dependencies.onEvent?.('DOCUMENT_PARSE_BATCH_COMPLETED', { batchIndex: batch.index + 1, pageNumbers: batch.pages.map((page) => page.pageNumber) });
    return results;
  };
  const drainOldestBatch = async () => {
    const task = activeBatches.shift();
    if (!task) return;
    const outcome = await task;
    if (!outcome.ok) {
      await Promise.all(activeBatches);
      activeBatches = [];
      throw outcome.error;
    }
    parsedPages.push(...outcome.results);
  };
  const scheduleBatch = async () => {
    if (!pendingBatch.length) return;
    const batch = { index: batchIndex++, pages: pendingBatch };
    pendingBatch = [];
    activeBatches.push(parseBatch(batch).then(
      (results) => ({ ok: true as const, results }),
      (error: unknown) => ({ ok: false as const, error }),
    ));
    if (activeBatches.length >= concurrency) await drainOldestBatch();
  };
  for await (const page of pages) {
    pendingBatch.push(page);
    if (pendingBatch.length >= batchSize) await scheduleBatch();
  }
  await scheduleBatch();
  while (activeBatches.length) await drainOldestBatch();
  parsedPages.sort((left, right) => left.page.pageNumber - right.page.pageNumber);
  const requestIds = [...new Set(parsedPages
    .map(({ parsed }) => parsed.requestId?.trim())
    .filter((requestId): requestId is string => Boolean(requestId)))];
  const markdownPages = parsedPages.filter(
    ({ parsed }) => Boolean(parsed.markdown?.trim()),
  );

  return {
    html: parsedPages.map(({ page, parsed }) => `<section data-page="${page.pageNumber}">${parsed.html}</section>`).join(''),
    raw: {
      pageCount: parsedPages.length,
      pages: parsedPages.map(({ page, parsed }) => ({
        pageNumber: page.pageNumber,
        requestId: parsed.requestId,
        model: parsed.model,
        requestConfig: parsed.requestConfig,
      })),
    },
    pageArtifacts: parsedPages.map(({ page, parsed }) => ({
      ...page,
      html: parsed.html,
      markdown: parsed.markdown?.trim() ? parsed.markdown : null,
      raw: parsed.raw,
      requestId: parsed.requestId,
      model: parsed.model,
      requestConfig: parsed.requestConfig,
    })),
    requestId: requestIds.length ? requestIds.join(',') : null,
    model: parsedPages[0]?.parsed.model ?? null,
    markdown:markdownPages.length
      ? markdownPages.map(({ page, parsed }) =>
        `<!-- page:${page.pageNumber} -->\n${parsed.markdown}`).join('\n\n')
      : null,
  };
}

export async function processDocument(
  sourceId: string,
  options: { signal?: AbortSignal; jobId?: string } = {},
): Promise<{ revision: number; chunks: number; embeddingModel: string }> {
  const sourceResult = await db.query<{ storage_path: string; original_name: string; subject: string | null; grade: string | null }>(
    'select storage_path, original_name, subject, grade from source_files where id = $1 and deleted_at is null', [sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error('SOURCE_NOT_FOUND: 교과서 파일을 찾을 수 없습니다.');
  const executionPins = await resolveSourceExecutionPins(sourceId);
  const parseSettings = executionPins.documentParse.definition.settings;
  const embeddingSettings = executionPins.embeddingRag.definition.settings;
  const requestedPageConcurrency = parseSettings.pageConcurrency;
  const effectivePageConcurrency = effectiveDocumentParseConcurrency(
    requestedPageConcurrency,
  );
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  if (!mock && !process.env.UPSTAGE_API_KEY) {
    throw new Error(
      'UPSTAGE_NOT_CONFIGURED: UPSTAGE_API_KEY가 필요합니다.',
    );
  }
  if (!mock && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      'EMBEDDING_NOT_CONFIGURED: GOOGLE_API_KEY가 필요합니다.',
    );
  }
  options.signal?.throwIfAborted();
  const log = (eventType: string, payload: Record<string, unknown> = {}) =>
    recordSourceEvent(sourceId, options.jobId ?? null, eventType, payload);
  await log('PIPELINE_STARTED', { filename: source.original_name });
  const bytes = new Uint8Array(await readFile(source.storage_path));
  await db.query("update source_files set status = 'PARSING', failed_stage = null, failure_code = null, failure_message = null, updated_at = now() where id = $1", [sourceId]);
  await log('DOCUMENT_PARSE_STARTED', {
    provider: mock ? 'mock' : 'upstage',
    model:mock ? 'mock-document-parse' : parseSettings.model,
    profileId:executionPins.documentParse.profileId,
    profileHash:executionPins.documentParse.contentHash,
    settings:parseSettings,
    runtime:{
      requestedPageConcurrency,
      effectivePageConcurrency,
      providerConcurrencyCap:effectiveDocumentParseConcurrency(
        Number.MAX_SAFE_INTEGER,
      ),
      providerRetryMaxAttempts:DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS,
    },
    sourceBytes: bytes.byteLength,
  });
  const parsed = mock
    ? {
      html:`<section data-page="1"><h2>로컬 파이프라인 검증</h2><p>${source.original_name} 문서의 실제 내용은 MOCK 모드에서 추출하지 않습니다.</p></section>`,
      markdown:`# 로컬 파이프라인 검증\n\n${source.original_name}`,
      raw:{
        pageCount:1,
        pages:[{
          pageNumber:1,
          requestId:'mock-document-parse',
          model:'mock-document-parse',
          requestConfig:{ settings:parseSettings },
        }],
      },
      pageArtifacts:[{
        pageNumber:1,
        filename:source.original_name,
        mimeType:'application/pdf' as const,
        width:null,
        height:null,
        html:`<h2>로컬 파이프라인 검증</h2><p>${source.original_name} 문서의 실제 내용은 MOCK 모드에서 추출하지 않습니다.</p>`,
        markdown:`# 로컬 파이프라인 검증\n\n${source.original_name}`,
        raw:{ mock:true, settings:parseSettings },
        requestId:'mock-document-parse',
        model:'mock-document-parse',
        requestConfig:{ settings:parseSettings },
      }],
      requestId:'mock-document-parse',
      model:'mock-document-parse',
    }
    : await parseDocumentPages(bytes, source.original_name, {
      parser:new UpstageDocumentParser({
        apiKey:process.env.UPSTAGE_API_KEY ?? '',
        model:parseSettings.model,
        baseUrl:process.env.UPSTAGE_BASE_URL,
        requestGate:upstageDocumentParseDistributedGate,
        timeoutMs:parseSettings.requestTimeoutMs,
        mode:parseSettings.mode,
        ocr:parseSettings.ocr,
        base64Encoding:parseSettings.base64Encoding,
        outputFormats:parseSettings.outputFormat === 'both'
          ? ['html', 'markdown']
          : [parseSettings.outputFormat],
      }),
      signal: options.signal,
      onEvent: log,
      batchSize:DOCUMENT_PARSE_PAGES_PER_TASK,
      concurrency:effectivePageConcurrency,
      rasterization:{
        format:parseSettings.rasterization.format,
        dpi:parseSettings.rasterization.dpi,
        ...(parseSettings.rasterization.format === 'jpeg'
          ? { jpegQuality:parseSettings.rasterization.jpegQuality }
          : {}),
        timeoutMs:parseSettings.requestTimeoutMs,
        pagesPerBatch:parseSettings.pagesPerBatch,
      },
    });
  options.signal?.throwIfAborted();
  await log('DOCUMENT_PARSE_COMPLETED', { model: parsed.model, requestId: parsed.requestId });
  const parseHtml = /data-page=/.test(parsed.html) ? parsed.html : `<section data-page="1">${parsed.html}</section>`;
  const persistedRevision = await withTransaction(async (client) => {
    const lockedSource = await client.query<{ id: string }>(
      `select id
         from source_files
        where id=$1 and deleted_at is null
        for update`,
      [sourceId],
    );
    if (!lockedSource.rows[0]) {
      throw new Error('SOURCE_NOT_FOUND: 교과서 파일을 찾을 수 없습니다.');
    }
    const nextRevision = await client.query<{ revision: number }>(
      `select coalesce(max(revision),0)::int+1 revision
         from source_revisions
        where source_file_id=$1`,
      [sourceId],
    );
    const revision = nextRevision.rows[0]!.revision;
    const sourceRevision = await client.query<{ id: string }>(
      `insert into source_revisions(
         source_file_id,revision,parse_model,parse_request_id,
         raw_response,raw_html,raw_markdown,reviewed_html,review_summary
       )
       values(
         $1,$2,$3,$4,$5::jsonb,$6,$7,$6,
         '자동 파이프라인 검수: 원문 HTML·Markdown 보존'
       )
       returning id`,
      [
        sourceId,
        revision,
        parsed.model,
        parsed.requestId,
        JSON.stringify(parsed.raw),
        parseHtml,
        parsed.markdown,
      ],
    );
    for (const page of parsed.pageArtifacts) {
      await client.query(
        `insert into source_revision_page_artifacts(
           source_revision_id,page_number,filename,mime_type,
           raster_width,raster_height,parse_model,parse_request_id,
           request_config,raw_response,raw_html,raw_markdown
         )
         values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
        [
          sourceRevision.rows[0]!.id,
          page.pageNumber,
          page.filename,
          page.mimeType,
          page.width ?? null,
          page.height ?? null,
          page.model,
          page.requestId,
          JSON.stringify(page.requestConfig ?? null),
          JSON.stringify(page.raw ?? null),
          page.html,
          page.markdown,
        ],
      );
    }
    await client.query(
      "update source_files set status='PARSED',updated_at=now() where id=$1",
      [sourceId],
    );
    return { id: sourceRevision.rows[0]!.id, revision };
  });
  const revision = persistedRevision.revision;
  await log('DOCUMENT_PARSE_PERSISTED', {
    revision,
    revisionId:persistedRevision.id,
    pageCount:parsed.pageArtifacts.length,
  });
  await log('CHUNKING_STARTED', {
    htmlBytes:Buffer.byteLength(parseHtml, 'utf8'),
    maxTokens:embeddingSettings.chunkTargetTokens,
    embeddingProfileId:executionPins.embeddingRag.profileId,
    vectorSpaceId:embeddingSettings.vectorSpaceId,
  });
  const chunks = chunkTextbook(parseHtml, {
    maxTokens:embeddingSettings.chunkTargetTokens,
  });
  if (!chunks.length) throw new Error('DOCUMENT_EMPTY: 문서에서 청크를 만들 수 없습니다.');
  await log('CHUNKING_COMPLETED', { chunkCount: chunks.length });
  const tocEntries = extractTableOfContents(parseHtml, 10);
  await log('TABLE_OF_CONTENTS_EXTRACTED', { scannedPages: 10, entryCount: tocEntries.length, entries: tocEntries });
  const embeddingModel = mock
    ? 'mock-embedding-3072'
    : embeddingSettings.model;
  await db.query("update source_files set status = 'EMBEDDING', updated_at = now() where id = $1", [sourceId]);
  await log('GEMINI_EMBEDDING_STARTED', {
    provider:mock ? 'mock' : 'gemini',
    model:embeddingModel,
    chunkCount:chunks.length,
    dimensions:embeddingSettings.dimensions,
    profileId:executionPins.embeddingRag.profileId,
    profileHash:executionPins.embeddingRag.contentHash,
    vectorSpaceId:embeddingSettings.vectorSpaceId,
    taskType:embeddingSettings.documentTaskType,
    prefixStrategy:embeddingSettings.prefixStrategy,
  });
  const vectors: number[][] = [];
  if (mock) {
    for (let index = 0; index < chunks.length; index += 1) {
      vectors.push(new Array<number>(embeddingSettings.dimensions).fill(0));
    }
  }
  else {
    const embedder = new GeminiEmbedder({
      apiKey:process.env.GOOGLE_API_KEY!,
      modelId:embeddingModel,
      dimensions:embeddingSettings.dimensions,
      baseUrl:process.env.GEMINI_BASE_URL,
      timeoutMs:embeddingSettings.requestTimeoutMs,
    });
    const embeddingBatchSize = embeddingSettings.batchSize;
    const embeddingConcurrency = embeddingSettings.concurrency;
    const batches = Array.from({ length: Math.ceil(chunks.length / embeddingBatchSize) }, (_, index) => ({
      index, start: index * embeddingBatchSize, chunks: chunks.slice(index * embeddingBatchSize, (index + 1) * embeddingBatchSize),
    }));
    const batchVectors = await mapConcurrentOrdered(batches, embeddingConcurrency, async (batch) => {
      options.signal?.throwIfAborted();
      await log('EMBEDDING_BATCH_STARTED', { batchIndex: batch.index + 1, start: batch.start + 1, count: batch.chunks.length, total: chunks.length, concurrency: embeddingConcurrency });
      const result = await embedder.embed(
        batch.chunks.map((chunk) =>
          embeddingSettings.prefixStrategy === 'text_prefix'
            ? `${embeddingSettings.documentPrefix}${chunk.content}`
            : chunk.content),
        options.signal,
        embeddingSettings.documentTaskType,
      );
      await log('EMBEDDING_BATCH_COMPLETED', { model: embeddingModel, batchIndex: batch.index + 1, start: batch.start + 1, count: batch.chunks.length, total: chunks.length });
      return result;
    });
    vectors.push(...batchVectors.flat());
  }
  options.signal?.throwIfAborted();
  await log('GEMINI_EMBEDDING_COMPLETED', {
    model:embeddingModel,
    vectorCount:vectors.length,
    dimensions:embeddingSettings.dimensions,
    vectorSpaceId:embeddingSettings.vectorSpaceId,
  });
  const tocAlignment = await withTransaction(async (client) => {
    const persistedChunks = [];
    for (const [index, chunk] of chunks.entries()) {
      const inserted = await client.query<{ id: string }>(
        `insert into source_chunks(source_file_id, source_revision_id, ordinal, subject, grade, chapter, unit, page_start, page_end, kind, html, content, token_count, embedding, embedding_model, embedding_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector,$15,$16)
         returning id`,
        [
          sourceId,
          persistedRevision.id,
          chunk.ordinal,
          source.subject,
          source.grade,
          chunk.chapter,
          chunk.unit,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.kind,
          chunk.html,
          chunk.content,
          chunk.estimatedTokens,
          vectorLiteral(vectors[index]!),
          embeddingModel,
          embeddingSettings.vectorSpaceId,
        ],
      );
      persistedChunks.push({ ...chunk, id: inserted.rows[0]!.id });
    }
    const alignment = await replaceSourceTocEntries(
      client,
      sourceId,
      persistedRevision.id,
      tocEntries,
      persistedChunks,
    );
    await client.query("update source_files set status = 'READY', updated_at = now() where id = $1", [sourceId]);
    return alignment;
  });
  await log('TABLE_OF_CONTENTS_ALIGNED', {
    mappedEntries: tocAlignment.entries.filter((entry) => entry.mappingStatus === 'MAPPED').length,
    unmappedEntries: tocAlignment.entries.filter((entry) => entry.mappingStatus === 'UNMAPPED').length,
    chunkMappings: tocAlignment.mappings.length,
  });
  await log('PIPELINE_COMPLETED', { revision, chunks: chunks.length, embeddingModel });
  return { revision, chunks: chunks.length, embeddingModel };
}

export async function markDocumentFailed(sourceId: string, error: unknown, jobId?: string) {
  const message = error instanceof Error ? error.message : '알 수 없는 문서 처리 오류';
  const failure = classifyDocumentFailure(error);
  await db.query("update source_files set status = 'FAILED', failed_stage = status, failure_code = $2, failure_message = $3, updated_at = now() where id = $1", [sourceId, failure.code, message]);
  await recordSourceEvent(sourceId, jobId ?? null, 'PIPELINE_FAILED', {
    code:failure.code,
    message,
    retryable:failure.retryable,
    provider:failure.provider ?? null,
  });
}
