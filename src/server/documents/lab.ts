import { renderPdfPages, type RenderedPage } from '@/server/documents/page-renderer';
import { UpstageDocumentParser, type DocumentParseOptions } from '@/server/providers/upstage-document';

const MAX_FILE_BYTES = 100 * 1024 * 1024;

type SupportedMimeType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

type ParsedPage = {
  html: string;
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
};

export type DocumentLabDependencies = {
  renderPdfPages?: (bytes: Uint8Array) => Promise<RenderedPage[]>;
  parser?: PageParser;
};

export class DocumentLabError extends Error {
  constructor(
    public readonly code: 'INVALID_DOCUMENT_FILE' | 'FILE_TOO_LARGE' | 'UPSTAGE_NOT_CONFIGURED',
    public readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentLabError';
  }
}

type LabPage = {
  pageNumber: number;
  filename: string;
  mimeType: string;
  dataUrl: string;
  html: string;
  elements: unknown[];
  raw: unknown;
  requestId: string | null;
  model: string;
  requestConfig: unknown;
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

function imagePage(file: File, bytes: Uint8Array, mimeType: Exclude<SupportedMimeType, 'application/pdf'>): DocumentLabPageInput {
  const extension = extensionFor(mimeType);
  const filename = file.name || `page-1.${extension}`;
  return {
    pageNumber: 1,
    bytes,
    mimeType,
    filename,
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
  };
}

function mockPage(page: DocumentLabPageInput): LabPage {
  const html = '<h2>Document Lab mock page</h2><p>Mock parsing is enabled.</p>';
  const elements = [{ type: 'paragraph', content: 'Mock parsing is enabled.' }];
  const requestConfig = {
    model: 'mock-document-parse',
    ocr: 'force',
    mode: 'enhanced',
    base64_encoding: ['footnote'],
    output_formats: ['html'],
    mimeType: page.mimeType,
    pageNumber: page.pageNumber,
  };
  return {
    pageNumber: page.pageNumber,
    filename: page.filename,
    mimeType: page.mimeType,
    dataUrl: page.dataUrl,
    html,
    elements,
    raw: { mock: true, pageNumber: page.pageNumber, content: { html }, elements },
    requestId: `mock-document-lab-page-${page.pageNumber}`,
    model: 'mock-document-parse',
    requestConfig,
  };
}

function toLabPage(page: DocumentLabPageInput, parsed: ParsedPage): LabPage {
  return {
    pageNumber: page.pageNumber,
    filename: page.filename,
    mimeType: page.mimeType,
    dataUrl: page.dataUrl,
    html: parsed.html,
    elements: parsed.elements,
    raw: parsed.raw,
    requestId: parsed.requestId,
    model: parsed.model,
    requestConfig: parsed.requestConfig,
  };
}

export async function parseDocumentLabFile(file: File, dependencies: DocumentLabDependencies = {}) {
  if (file.size > MAX_FILE_BYTES) throw new DocumentLabError('FILE_TOO_LARGE', 400, 'Document files must be 100MB or smaller.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = detectMimeType(bytes);
  if (!mimeType) throw new DocumentLabError('INVALID_DOCUMENT_FILE', 400, 'Upload a PDF, PNG, JPEG, or WebP file with valid file bytes.');

  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const requestConfig = mock
    ? { model: 'mock-document-parse', ocr: 'force', mode: 'enhanced', base64_encoding: ['footnote'], output_formats: ['html'] }
    : { model: process.env.UPSTAGE_DOCUMENT_PARSE_MODEL ?? 'document-parse', ocr: 'force', mode: 'enhanced', base64_encoding: ['footnote'], output_formats: ['html'] };
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!mock && !apiKey) throw new DocumentLabError('UPSTAGE_NOT_CONFIGURED', 409, 'UPSTAGE_API_KEY is required to parse documents.');

  const pages = mimeType === 'application/pdf'
    ? await (dependencies.renderPdfPages ?? renderPdfPages)(bytes)
    : [imagePage(file, bytes, mimeType)];
  if (mock) return { pages: pages.map(mockPage), requestConfig, mock: true };

  const parser = dependencies.parser ?? new UpstageDocumentParser({
    apiKey: apiKey!,
    model: requestConfig.model,
    baseUrl: process.env.UPSTAGE_BASE_URL,
  });
  const parsedPages: LabPage[] = [];
  for (const page of pages) {
    const parsed = await parser.parse(page.bytes, page.filename, { mimeType: page.mimeType, pageNumber: page.pageNumber });
    parsedPages.push(toLabPage(page, parsed));
  }
  return { pages: parsedPages, requestConfig, mock: false };
}
