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
import { recordSourceEvent } from '@/server/sources/activity';
import { extractTableOfContents } from '@/domain/toc';
import { replaceSourceTocEntries } from '@/server/sources/toc';
import { mapConcurrentOrdered } from '@/domain/parallel';
import { resolveSourceExecutionPins } from '@/server/settings/execution-pins';

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
  rasterization?: Pick<
    RenderPdfPagesOptions,
    'format' | 'dpi' | 'jpegQuality' | 'timeoutMs'
  >;
};

type PipelinePage = RenderedPage | StreamedPage;

type PersistedPageProvenance = {
  pageNumber: number;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
  raw: unknown;
};

type ParsedDocumentPages = {
  html: string;
  markdown:string | null;
  raw: { pages: PersistedPageProvenance[] };
  requestId: string;
  model: string | null;
};

export const MAX_PERSISTED_RAW_PROVENANCE_BYTES = 64 * 1024;

async function* arrayPages(pages: Promise<RenderedPage[]>): AsyncGenerator<RenderedPage> {
  for (const page of await pages) yield page;
}

function boundedRaw(raw: unknown, remainingBytes: number): { value: unknown; byteLength: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    serialized = '';
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (serialized && byteLength <= remainingBytes) return { value: raw, byteLength };
  return {
    value: { omitted: true, reason: 'PERSISTED_RAW_PROVENANCE_LIMIT', byteLength },
    byteLength: 0,
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
      });
  const parsedPages: Array<{ page: PipelinePage; parsed: ParsedPage }> = [];
  let persistedRawBytes = 0;
  const batchSize = dependencies.batchSize ?? Math.max(1, Number(process.env.DOCUMENT_PARSE_BATCH_SIZE ?? 4));
  const concurrency = dependencies.concurrency ?? Math.max(1, Number(process.env.DOCUMENT_PARSE_CONCURRENCY ?? 3));
  let pendingBatch: PipelinePage[] = [];
  let wave: Array<{ index: number; pages: PipelinePage[] }> = [];
  let batchIndex = 0;

  const parseBatch = async (batch: { index: number; pages: PipelinePage[] }) => {
    await dependencies.onEvent?.('DOCUMENT_PARSE_BATCH_STARTED', { batchIndex: batch.index + 1, pageNumbers: batch.pages.map((page) => page.pageNumber), concurrency });
    const results: Array<{ page: PipelinePage; parsed: ParsedPage }> = [];
    for (const page of batch.pages) {
      await dependencies.onEvent?.('DOCUMENT_PAGE_PARSE_STARTED', { pageNumber: page.pageNumber, filename: page.filename, imageBytes: page.bytes.byteLength, batchIndex: batch.index + 1 });
      let parsed: ParsedPage;
      try {
        parsed = await dependencies.parser.parse(page.bytes, page.filename, { mimeType: page.mimeType, pageNumber: page.pageNumber, signal: dependencies.signal });
      } catch (error) {
        if (dependencies.signal?.aborted) throw dependencies.signal.reason;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`DOCUMENT_PARSE_PAGE_${page.pageNumber}: ${message}`, { cause: error });
      }
      results.push({ page, parsed });
      await dependencies.onEvent?.('DOCUMENT_PAGE_PARSE_COMPLETED', { pageNumber: page.pageNumber, requestId: parsed.requestId, model: parsed.model, htmlBytes: Buffer.byteLength(parsed.html, 'utf8'), requestConfig: parsed.requestConfig, batchIndex: batch.index + 1 });
    }
    await dependencies.onEvent?.('DOCUMENT_PARSE_BATCH_COMPLETED', { batchIndex: batch.index + 1, pageNumbers: batch.pages.map((page) => page.pageNumber) });
    return results;
  };
  const flushWave = async () => {
    if (!wave.length) return;
    const waveResults = await mapConcurrentOrdered(wave, concurrency, parseBatch);
    parsedPages.push(...waveResults.flat());
    wave = [];
  };
  const scheduleBatch = async () => {
    if (!pendingBatch.length) return;
    wave.push({ index: batchIndex++, pages: pendingBatch });
    pendingBatch = [];
    if (wave.length >= concurrency) await flushWave();
  };
  for await (const page of pages) {
    pendingBatch.push(page);
    if (pendingBatch.length >= batchSize) await scheduleBatch();
  }
  await scheduleBatch();
  await flushWave();
  parsedPages.sort((left, right) => left.page.pageNumber - right.page.pageNumber);
  for (const item of parsedPages) {
    const safeRaw = boundedRaw(item.parsed.raw, MAX_PERSISTED_RAW_PROVENANCE_BYTES - persistedRawBytes);
    persistedRawBytes += safeRaw.byteLength;
    item.parsed = { ...item.parsed, raw: safeRaw.value };
  }

  return {
    html: parsedPages.map(({ page, parsed }) => `<section data-page="${page.pageNumber}">${parsed.html}</section>`).join(''),
    raw: {
      pages: parsedPages.map(({ page, parsed }) => ({
        pageNumber: page.pageNumber,
        requestId: parsed.requestId,
        model: parsed.model,
        requestConfig: parsed.requestConfig,
        raw: parsed.raw,
      })),
    },
    requestId: parsedPages.map(({ parsed }) => parsed.requestId).join(','),
    model: parsedPages[0]?.parsed.model ?? null,
    markdown:parsedPages.some(({ parsed }) => parsed.markdown != null)
      ? parsedPages.map(({ page, parsed }) =>
        `<!-- page:${page.pageNumber} -->\n${parsed.markdown ?? ''}`).join('\n\n')
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
  options.signal?.throwIfAborted();
  const log = (eventType: string, payload: Record<string, unknown> = {}) =>
    recordSourceEvent(sourceId, options.jobId ?? null, eventType, payload);
  await log('PIPELINE_STARTED', { filename: source.original_name });
  const bytes = new Uint8Array(await readFile(source.storage_path));
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  await db.query("update source_files set status = 'PARSING', failed_stage = null, failure_code = null, failure_message = null, updated_at = now() where id = $1", [sourceId]);
  await log('DOCUMENT_PARSE_STARTED', {
    provider: mock ? 'mock' : 'upstage',
    model:mock ? 'mock-document-parse' : parseSettings.model,
    profileId:executionPins.documentParse.profileId,
    profileHash:executionPins.documentParse.contentHash,
    settings:parseSettings,
    sourceBytes: bytes.byteLength,
  });
  const parsed = mock
    ? {
      html:`<section data-page="1"><h2>로컬 파이프라인 검증</h2><p>${source.original_name} 문서의 실제 내용은 MOCK 모드에서 추출하지 않습니다.</p></section>`,
      markdown:`# 로컬 파이프라인 검증\n\n${source.original_name}`,
      raw:{ mock:true, settings:parseSettings },
      requestId:'mock-document-parse',
      model:'mock-document-parse',
    }
    : await parseDocumentPages(bytes, source.original_name, {
      parser:new UpstageDocumentParser({
        apiKey:process.env.UPSTAGE_API_KEY ?? '',
        model:parseSettings.model,
        baseUrl:process.env.UPSTAGE_BASE_URL,
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
      batchSize:parseSettings.pagesPerBatch,
      concurrency:parseSettings.pageConcurrency,
      rasterization:{
        format:parseSettings.rasterization.format,
        dpi:parseSettings.rasterization.dpi,
        ...(parseSettings.rasterization.format === 'jpeg'
          ? { jpegQuality:parseSettings.rasterization.jpegQuality }
          : {}),
        timeoutMs:parseSettings.requestTimeoutMs,
      },
    });
  options.signal?.throwIfAborted();
  await log('DOCUMENT_PARSE_COMPLETED', { model: parsed.model, requestId: parsed.requestId });
  const parseHtml = /data-page=/.test(parsed.html) ? parsed.html : `<section data-page="1">${parsed.html}</section>`;
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
  const revisionResult = await db.query<{ revision: number }>('select coalesce(max(revision), 0)::int + 1 as revision from source_revisions where source_file_id = $1', [sourceId]);
  const revision = revisionResult.rows[0]!.revision;
  const embeddingModel = mock
    ? 'mock-embedding-3072'
    : embeddingSettings.model;
  if (!mock && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      'EMBEDDING_NOT_CONFIGURED: GOOGLE_API_KEY가 필요합니다.',
    );
  }
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
    await client.query("update source_files set status = 'PARSED', updated_at = now() where id = $1", [sourceId]);
    const sourceRevision = await client.query<{ id: string }>(
      `insert into source_revisions(
         source_file_id, revision, parse_model, parse_request_id,
         raw_response, raw_html, raw_markdown, reviewed_html, review_summary
       )
       values (
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
    await client.query("update source_files set status = 'CHUNKING' where id = $1", [sourceId]);
    const persistedChunks = [];
    for (const [index, chunk] of chunks.entries()) {
      const inserted = await client.query<{ id: string }>(
        `insert into source_chunks(source_file_id, source_revision_id, ordinal, subject, grade, chapter, unit, page_start, page_end, kind, html, content, token_count, embedding, embedding_model, embedding_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector,$15,$16)
         returning id`,
        [
          sourceId,
          sourceRevision.rows[0]!.id,
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
      sourceRevision.rows[0]!.id,
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
  const code = message.split(':', 1)[0] || 'DOCUMENT_PIPELINE_FAILED';
  await db.query("update source_files set status = 'FAILED', failed_stage = status, failure_code = $2, failure_message = $3, updated_at = now() where id = $1", [sourceId, code, message]);
  await recordSourceEvent(sourceId, jobId ?? null, 'PIPELINE_FAILED', { code, message });
}
