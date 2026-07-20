import { readFile } from 'node:fs/promises';
import { chunkTextbook } from '@/domain/chunking';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { renderPdfPages, type RenderedPage } from '@/server/documents/page-renderer';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';
import { UpstageDocumentParser, type DocumentParseOptions } from '@/server/providers/upstage-document';

function vectorLiteral(values: number[]): string { return `[${values.join(',')}]`; }

type ParsedPage = {
  html: string;
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
  parser: PageParser;
};

export async function parseDocumentPages(bytes: Uint8Array, filename: string, dependencies: ParseDocumentPagesDependencies) {
  const pages = await (dependencies.renderPdfPages ?? renderPdfPages)(bytes);
  const parsedPages: Array<{ page: RenderedPage; parsed: ParsedPage }> = [];

  for (const page of pages) {
    let parsed: ParsedPage;
    try {
      parsed = await dependencies.parser.parse(page.bytes, page.filename, {
        mimeType: page.mimeType,
        pageNumber: page.pageNumber,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DOCUMENT_PARSE_PAGE_${page.pageNumber}: ${message}`, { cause: error });
    }
    parsedPages.push({ page, parsed });
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
  };
}

export async function processDocument(sourceId: string): Promise<{ revision: number; chunks: number; embeddingModel: string }> {
  const sourceResult = await db.query<{ storage_path: string; original_name: string; subject: string | null; grade: string | null }>(
    'select storage_path, original_name, subject, grade from source_files where id = $1 and deleted_at is null', [sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error('SOURCE_NOT_FOUND: 교과서 파일을 찾을 수 없습니다.');
  const bytes = new Uint8Array(await readFile(source.storage_path));
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  await db.query("update source_files set status = 'PARSING', failed_stage = null, failure_code = null, failure_message = null, updated_at = now() where id = $1", [sourceId]);
  const parsed = mock
    ? { html: `<section data-page="1"><h2>로컬 파이프라인 검증</h2><p>${source.original_name} 문서의 실제 내용은 MOCK 모드에서 추출하지 않습니다.</p></section>`, raw: { mock: true }, requestId: 'mock-document-parse', model: 'mock-document-parse' }
    : await parseDocumentPages(bytes, source.original_name, {
      parser: new UpstageDocumentParser({ apiKey: process.env.UPSTAGE_API_KEY ?? '', model: process.env.UPSTAGE_DOCUMENT_PARSE_MODEL ?? 'document-parse', baseUrl: process.env.UPSTAGE_BASE_URL }),
    });
  const parseHtml = /data-page=/.test(parsed.html) ? parsed.html : `<section data-page="1">${parsed.html}</section>`;
  const chunks = chunkTextbook(parseHtml, { maxTokens: 800 });
  if (!chunks.length) throw new Error('DOCUMENT_EMPTY: 문서에서 청크를 만들 수 없습니다.');
  const revisionResult = await db.query<{ revision: number }>('select coalesce(max(revision), 0)::int + 1 as revision from source_revisions where source_file_id = $1', [sourceId]);
  const revision = revisionResult.rows[0]!.revision;
  const embeddingModel = mock ? 'mock-embedding-3072' : (process.env.GEMINI_EMBEDDING_MODEL ?? '');
  if (!mock && (!process.env.GOOGLE_API_KEY || !embeddingModel)) throw new Error('EMBEDDING_NOT_CONFIGURED: GOOGLE_API_KEY와 GEMINI_EMBEDDING_MODEL이 필요합니다.');
  const vectors: number[][] = [];
  if (mock) for (let index = 0; index < chunks.length; index += 1) vectors.push(new Array<number>(3072).fill(0));
  else {
    const embedder = new GeminiEmbedder({ apiKey: process.env.GOOGLE_API_KEY!, modelId: embeddingModel, dimensions: 3072, baseUrl: process.env.GEMINI_BASE_URL });
    for (let start = 0; start < chunks.length; start += 50) vectors.push(...await embedder.embed(chunks.slice(start, start + 50).map((chunk) => chunk.content)));
  }
  await withTransaction(async (client) => {
    await client.query("update source_files set status = 'PARSED', updated_at = now() where id = $1", [sourceId]);
    const sourceRevision = await client.query<{ id: string }>(
      `insert into source_revisions(source_file_id, revision, parse_model, parse_request_id, raw_response, raw_html, reviewed_html, review_summary)
       values ($1,$2,$3,$4,$5::jsonb,$6,$6,'자동 파이프라인 검수: 원문 HTML 보존') returning id`,
      [sourceId, revision, parsed.model, parsed.requestId, JSON.stringify(parsed.raw), parseHtml],
    );
    await client.query("update source_files set status = 'CHUNKING' where id = $1", [sourceId]);
    for (const [index, chunk] of chunks.entries()) await client.query(
      `insert into source_chunks(source_file_id, source_revision_id, ordinal, subject, grade, chapter, unit, page_start, page_end, kind, html, content, token_count, embedding, embedding_model, embedding_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector,$15,'v1')`,
      [sourceId, sourceRevision.rows[0]!.id, chunk.ordinal, source.subject, source.grade, chunk.chapter, chunk.unit, chunk.pageStart, chunk.pageEnd, chunk.kind, chunk.html, chunk.content, chunk.estimatedTokens, vectorLiteral(vectors[index]!), embeddingModel],
    );
    await client.query("update source_files set status = 'READY', updated_at = now() where id = $1", [sourceId]);
  });
  return { revision, chunks: chunks.length, embeddingModel };
}

export async function markDocumentFailed(sourceId: string, error: unknown) {
  const message = error instanceof Error ? error.message : '알 수 없는 문서 처리 오류';
  const code = message.split(':', 1)[0] || 'DOCUMENT_PIPELINE_FAILED';
  await db.query("update source_files set status = 'FAILED', failed_stage = status, failure_code = $2, failure_message = $3, updated_at = now() where id = $1", [sourceId, code, message]);
}
