import {
  streamPdfPages,
  type RenderedPage,
  type RenderPdfPagesOptions,
  type StreamedPage,
} from '@/server/documents/page-renderer';
import {
  UpstageDocumentParser,
  type DocumentParseOptions,
  type UpstageDocumentParserOptions,
} from '@/server/providers/upstage-document';
import { upstageDocumentParseDistributedGate } from '@/server/providers/postgres-concurrency-gate';
import { ProviderError, type ProviderErrorKind } from '@/server/providers/types';
import {
  withProviderRetry,
  type RetryOptions as ProviderRetryOptions,
} from '@/server/providers/retry';
import {
  defaultResearchConfigDefinitions,
  documentParseResearchConfigSchema,
  type DocumentParseResearchConfig,
} from '@/domain/research-config';
import {
  effectiveDocumentParseConcurrency,
  DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS,
} from '@/domain/document-parse-config';

const MAX_FILE_BYTES = 100 * 1024 * 1024;

export type DocumentLabLimits = {
  maxPages: number;
  maxRenderedBytes: number;
  maxResponseBytes: number;
};

export const DOCUMENT_LAB_LIMITS: DocumentLabLimits = {
  maxPages: 50,
  maxRenderedBytes: 64 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
};

type SupportedMimeType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

type ParsedPage = {
  html: string;
  markdown?: string;
  elements: unknown[];
  raw: unknown;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
};

type PageParser = {
  parse(bytes: Uint8Array, filename: string, options: DocumentParseOptions): Promise<ParsedPage>;
};

type DocumentLabPageInput = {
  pageNumber: number;
  bytes: Uint8Array;
  mimeType: Exclude<SupportedMimeType, 'application/pdf'>;
  filename: string;
  dataUrl: string;
  width?: number | null;
  height?: number | null;
};

export type DocumentLabDependencies = {
  profile?: DocumentLabProfileConfig;
  renderPdfPages?: (bytes: Uint8Array, options: RenderPdfPagesOptions) => Promise<RenderedPage[]>;
  streamPdfPages?: (bytes: Uint8Array, options: RenderPdfPagesOptions) => AsyncIterable<StreamedPage>;
  parser?: PageParser;
  createParser?: (options: UpstageDocumentParserOptions) => PageParser;
  limits?: DocumentLabLimits;
  signal?: AbortSignal;
  /** Upstage key supplied by the browser for this request only. */
  upstageApiKey?: string;
  providerRetry?: Pick<
    ProviderRetryOptions,
    'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random'
  >;
};

export type DocumentLabProfileConfig = {
  id: string;
  version: string;
  contentHash: string;
  settings: DocumentParseResearchConfig['settings'];
};

const defaultDocumentParseSettings = documentParseResearchConfigSchema.parse(
  defaultResearchConfigDefinitions.find((definition) => definition.kind === 'document_parse'),
).settings;

function outputFormatsFor(
  outputFormat: DocumentParseResearchConfig['settings']['outputFormat'],
): readonly ('html' | 'markdown')[] {
  if (outputFormat === 'both') return ['html', 'markdown'];
  return [outputFormat];
}

function renderOptionsFor(
  settings: DocumentParseResearchConfig['settings'],
): RenderPdfPagesOptions {
  return {
    format: settings.rasterization.format,
    dpi: settings.rasterization.dpi,
    ...(settings.rasterization.format === 'jpeg'
      ? { jpegQuality: settings.rasterization.jpegQuality }
      : {}),
    timeoutMs: settings.requestTimeoutMs,
    pagesPerBatch: settings.pagesPerBatch,
  };
}

function requestConfigFor(
  profile: DocumentLabProfileConfig | undefined,
  settings: DocumentParseResearchConfig['settings'],
) {
  return {
    profile: profile
      ? {
          id: profile.id,
          version: profile.version,
          contentHash: profile.contentHash,
        }
      : null,
    provider: settings.provider,
    model: settings.model,
    ocr: settings.ocr,
    mode: settings.mode,
    base64_encoding: [...settings.base64Encoding],
    output_formats: [...outputFormatsFor(settings.outputFormat)],
    rasterization: structuredClone(settings.rasterization),
    pages_per_batch: settings.pagesPerBatch,
    page_concurrency: settings.pageConcurrency,
    request_timeout_ms: settings.requestTimeoutMs,
  };
}

export class DocumentLabError extends Error {
  constructor(
    public readonly code: 'INVALID_DOCUMENT_FILE' | 'FILE_TOO_LARGE' | 'UPSTAGE_NOT_CONFIGURED'
      | 'LAB_PAGE_LIMIT_EXCEEDED' | 'LAB_RENDERED_BYTES_LIMIT_EXCEEDED' | 'LAB_RESPONSE_LIMIT_EXCEEDED'
      | 'DOCUMENT_PARSE_PROFILE_NOT_CONFIGURED' | 'DOCUMENT_PARSE_PROFILE_INTEGRITY_ERROR',
    public readonly status: 400 | 409 | 413 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentLabError';
  }
}

export class DocumentPageParseError extends Error {
  readonly code = 'DOCUMENT_PAGE_PARSE_FAILED';
  readonly provider = 'upstage';

  constructor(
    public readonly pageNumber: number,
    public readonly category: ProviderErrorKind,
    public readonly providerStatus: number | null,
    public readonly requestId: string | null,
    options: { cause?: unknown } = {},
  ) {
    super(`Unable to parse document page ${pageNumber}.`, options);
    this.name = 'DocumentPageParseError';
  }
}

type LabPage = {
  pageNumber: number;
  filename: string;
  mimeType: string;
  dataUrl: string;
  html: string;
  markdown?: string;
  elements: unknown[];
  raw: unknown;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
  width?: number | null;
  height?: number | null;
};

function detectMimeType(bytes: Uint8Array): SupportedMimeType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'application/pdf';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function extensionFor(mimeType: Exclude<SupportedMimeType, 'application/pdf'>) {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
}

function imageDimensions(bytes: Uint8Array, mimeType: Exclude<SupportedMimeType, 'application/pdf'>) {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  return {};
}

function imagePage(file: File, bytes: Uint8Array, mimeType: Exclude<SupportedMimeType, 'application/pdf'>): DocumentLabPageInput {
  const extension = extensionFor(mimeType);
  const filename = file.name || `page-1.${extension}`;
  return {
    pageNumber: 1,
    bytes,
    mimeType,
    filename,
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    ...imageDimensions(bytes, mimeType),
  };
}

function mockPage(
  page: DocumentLabPageInput,
  requestConfig: ReturnType<typeof requestConfigFor>,
): LabPage {
  const html = '<h2>Document Lab mock page</h2><p>Mock parsing is enabled.</p>';
  const markdown = '# Document Lab mock page\n\nMock parsing is enabled.';
  const elements = [{ type: 'paragraph', content: 'Mock parsing is enabled.' }];
  const pageRequestConfig = {
    ...requestConfig,
    model: 'mock-document-parse',
    mimeType: page.mimeType,
    pageNumber: page.pageNumber,
    mock: true,
  };
  return {
    pageNumber: page.pageNumber,
    filename: page.filename,
    mimeType: page.mimeType,
    dataUrl: page.dataUrl,
    html,
    ...(requestConfig.output_formats.includes('markdown') ? { markdown } : {}),
    elements,
    raw: {
      mock: true,
      pageNumber: page.pageNumber,
      content: {
        html,
        ...(requestConfig.output_formats.includes('markdown') ? { markdown } : {}),
      },
      elements,
    },
    requestId: `mock-document-lab-page-${page.pageNumber}`,
    model: 'mock-document-parse',
    requestConfig: pageRequestConfig,
    ...(page.width == null ? {} : { width: page.width }),
    ...(page.height == null ? {} : { height: page.height }),
  };
}

function toLabPage(page: DocumentLabPageInput, parsed: ParsedPage): LabPage {
  return {
    pageNumber: page.pageNumber,
    filename: page.filename,
    mimeType: page.mimeType,
    dataUrl: page.dataUrl,
    html: parsed.html,
    ...(parsed.markdown == null ? {} : { markdown: parsed.markdown }),
    elements: parsed.elements,
    raw: parsed.raw,
    requestId: parsed.requestId,
    model: parsed.model,
    requestConfig: parsed.requestConfig,
    ...(page.width == null ? {} : { width: page.width }),
    ...(page.height == null ? {} : { height: page.height }),
  };
}

async function* legacyPages(pages: Promise<RenderedPage[]>): AsyncGenerator<RenderedPage> {
  for (const page of await pages) yield page;
}

async function mapConcurrentInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  transform: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await transform(items[index]!);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}

function labResult<T extends { pages: LabPage[] }>(result: T, maxResponseBytes: number): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxResponseBytes) {
    throw new DocumentLabError('LAB_RESPONSE_LIMIT_EXCEEDED', 413, 'The parsed Lab response exceeds the configured response limit.');
  }
  return result;
}

export async function parseDocumentLabFile(file: File, dependencies: DocumentLabDependencies = {}) {
  dependencies.signal?.throwIfAborted();
  if (file.size > MAX_FILE_BYTES) throw new DocumentLabError('FILE_TOO_LARGE', 400, 'Document files must be 100MB or smaller.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = detectMimeType(bytes);
  if (!mimeType) throw new DocumentLabError('INVALID_DOCUMENT_FILE', 400, 'Upload a PDF, PNG, JPEG, or WebP file with valid file bytes.');
  const declaredMimeType = file.type?.toLowerCase();
  if (declaredMimeType && declaredMimeType !== 'application/octet-stream' && declaredMimeType !== mimeType) {
    throw new DocumentLabError('INVALID_DOCUMENT_FILE', 400, 'The declared file type does not match the document bytes.');
  }

  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const settings = dependencies.profile?.settings ?? defaultDocumentParseSettings;
  const requestConfig = requestConfigFor(dependencies.profile, settings);
  const apiKey = dependencies.upstageApiKey;
  if (!mock && !apiKey) throw new DocumentLabError('UPSTAGE_NOT_CONFIGURED', 409, 'Upstage API 키가 필요합니다. 설정 화면에서 키를 입력하세요.');

  const limits = dependencies.limits ?? DOCUMENT_LAB_LIMITS;
  const renderOptions = {
    ...renderOptionsFor(settings),
    ...(dependencies.signal ? { signal:dependencies.signal } : {}),
  };
  const pages: DocumentLabPageInput[] = [];
  const pageStream: AsyncIterable<RenderedPage | StreamedPage | DocumentLabPageInput> = mimeType === 'application/pdf'
    ? dependencies.streamPdfPages
      ? dependencies.streamPdfPages(bytes, renderOptions)
      : dependencies.renderPdfPages
        ? legacyPages(dependencies.renderPdfPages(bytes, renderOptions))
        : streamPdfPages(bytes, renderOptions)
    : legacyPages(Promise.resolve([imagePage(file, bytes, mimeType)] as RenderedPage[]));
  let renderedBytes = 0;
  for await (const page of pageStream) {
    dependencies.signal?.throwIfAborted();
    if (pages.length >= limits.maxPages) {
      throw new DocumentLabError('LAB_PAGE_LIMIT_EXCEEDED', 413, `Document Lab accepts at most ${limits.maxPages} pages.`);
    }
    renderedBytes += page.bytes.byteLength;
    if (renderedBytes > limits.maxRenderedBytes) {
      throw new DocumentLabError('LAB_RENDERED_BYTES_LIMIT_EXCEEDED', 413, 'Rendered document images exceed the configured byte limit.');
    }
    pages.push({
      ...page,
      dataUrl: 'dataUrl' in page ? page.dataUrl : `data:${page.mimeType};base64,${Buffer.from(page.bytes).toString('base64')}`,
    });
  }
  if (mock) {
    return labResult({
      pages: pages.map((page) => mockPage(page, requestConfig)),
      requestConfig,
      mock: true,
    }, limits.maxResponseBytes);
  }

  const parserOptions: UpstageDocumentParserOptions = {
    apiKey: apiKey!,
    model: settings.model,
    baseUrl: process.env.UPSTAGE_BASE_URL,
    mode: settings.mode,
    ocr: settings.ocr,
    base64Encoding: settings.base64Encoding,
    outputFormats: outputFormatsFor(settings.outputFormat),
    timeoutMs: settings.requestTimeoutMs,
    requestGate: upstageDocumentParseDistributedGate,
  };
  const parser = dependencies.parser
    ?? (dependencies.createParser ?? ((options) => new UpstageDocumentParser(options)))(
      parserOptions,
    );
  const parsedPages = await mapConcurrentInOrder(
    pages,
    effectiveDocumentParseConcurrency(settings.pageConcurrency),
    async (page): Promise<LabPage> => {
    let parsed: ParsedPage;
    try {
      parsed = await withProviderRetry(
        () => parser.parse(
          page.bytes,
          page.filename,
          {
            mimeType:page.mimeType,
            pageNumber:page.pageNumber,
            signal:dependencies.signal,
          },
        ),
        {
          ...(dependencies.providerRetry ?? {
            maxAttempts:DEFAULT_DOCUMENT_PARSE_PROVIDER_MAX_ATTEMPTS,
            baseDelayMs:2_000,
            maxDelayMs:60_000,
          }),
          signal:dependencies.signal,
        },
      );
    } catch (error) {
      if (dependencies.signal?.aborted) throw dependencies.signal.reason;
      const providerError = error instanceof ProviderError ? error : null;
      throw new DocumentPageParseError(
        page.pageNumber,
        providerError?.kind ?? 'UNKNOWN',
        providerError?.status ?? null,
        providerError?.requestId ?? null,
        { cause: error },
      );
    }
      return toLabPage(page, parsed);
    },
  );
  return labResult({ pages: parsedPages, requestConfig, mock: false }, limits.maxResponseBytes);
}
