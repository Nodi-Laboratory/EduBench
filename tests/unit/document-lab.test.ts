import { afterEach, expect, test, vi } from 'vitest';
import {
  createDocumentLabPostHandler,
  loadActiveDocumentParseProfile,
} from '@/app/api/document-lab/parse/route';
import { DomainError } from '@/domain/errors';
import {
  DOCUMENT_LAB_LIMITS,
  parseDocumentLabFile,
  type DocumentLabProfileConfig,
} from '@/server/documents/lab';
import { ProviderError } from '@/server/providers/types';

const originalMockProviders = process.env.MOCK_PROVIDERS;
const originalUpstageApiKey = process.env.UPSTAGE_API_KEY;

const documentParseProfile: DocumentLabProfileConfig = {
  id: '2d250a46-a96e-4a23-90e8-c32d15b1e0d9',
  version: 'document-parse-lab-test-v2',
  contentHash: 'a'.repeat(64),
  settings: {
    provider: 'upstage',
    model: 'document-parse-profile-model',
    mode: 'standard',
    ocr: 'auto',
    outputFormat: 'both',
    base64Encoding: ['table', 'figure', 'chart', 'equation'],
    rasterization: {
      format: 'jpeg',
      lossless: false,
      dpi: 300,
      jpegQuality: 92,
    },
    pagesPerBatch: 8,
    pageConcurrency: 2,
    requestTimeoutMs: 45_000,
  },
};

function metadataFile(bytes: Uint8Array, size: number, name = 'document.png', type = 'image/png'): File {
  return {
    name,
    size,
    type,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as File;
}

afterEach(() => {
  if (originalMockProviders === undefined) delete process.env.MOCK_PROVIDERS;
  else process.env.MOCK_PROVIDERS = originalMockProviders;
  if (originalUpstageApiKey === undefined) delete process.env.UPSTAGE_API_KEY;
  else process.env.UPSTAGE_API_KEY = originalUpstageApiKey;
  vi.unstubAllGlobals();
});

test('rejects a declared PDF whose bytes are not a supported document', async () => {
  const file = new File([new Uint8Array([0, 1, 2, 3])], 'not-a-pdf.pdf', { type: 'application/pdf' });

  await expect(parseDocumentLabFile(file)).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_DOCUMENT_FILE',
  });
});

test('returns a representative, stateless parsed page for a mock PDF', async () => {
  process.env.MOCK_PROVIDERS = 'true';
  delete process.env.UPSTAGE_API_KEY;
  const pdf = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], 'lesson.pdf', { type: 'application/pdf' });

  const result = await parseDocumentLabFile(pdf, {
    renderPdfPages: async () => [{
      pageNumber: 1,
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: 'image/png',
      filename: 'page-1.png',
      dataUrl: 'data:image/png;base64,iVBORw==',
    }],
  });

  expect(result).toEqual({
    mock: true,
    requestConfig: {
      profile: null,
      provider: 'upstage',
      model: 'document-parse',
      ocr: 'force',
      mode: 'enhanced',
      base64_encoding: ['table', 'figure', 'chart', 'equation'],
      output_formats: ['html'],
      rasterization: { format: 'png', lossless: true, dpi: 300 },
      pages_per_batch: 10,
      page_concurrency: 4,
      request_timeout_ms: 120_000,
    },
    pages: [{
      pageNumber: 1,
      filename: 'page-1.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw==',
      html: '<h2>Document Lab mock page</h2><p>Mock parsing is enabled.</p>',
      elements: [{ type: 'paragraph', content: 'Mock parsing is enabled.' }],
      raw: { mock: true, pageNumber: 1, content: { html: '<h2>Document Lab mock page</h2><p>Mock parsing is enabled.</p>' }, elements: [{ type: 'paragraph', content: 'Mock parsing is enabled.' }] },
      requestId: 'mock-document-lab-page-1',
      model: 'mock-document-parse',
      requestConfig: {
        profile: null,
        provider: 'upstage',
        model: 'mock-document-parse',
        ocr: 'force',
        mode: 'enhanced',
        base64_encoding: ['table', 'figure', 'chart', 'equation'],
        output_formats: ['html'],
        rasterization: { format: 'png', lossless: true, dpi: 300 },
        pages_per_batch: 10,
        page_concurrency: 4,
        request_timeout_ms: 120_000,
        mimeType: 'image/png',
        pageNumber: 1,
        mock: true,
      },
    }],
  });
});

test('parses a JPEG when its declared and detected MIME types match', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', { type: 'image/jpeg' });
  const parseCalls: Array<{ mimeType: string; pageNumber: number }> = [];

  const result = await parseDocumentLabFile(jpeg, {
    parser: {
      parse: async (_bytes, _filename, options) => {
        parseCalls.push({ mimeType: options.mimeType, pageNumber: options.pageNumber });
        return {
          html: '<p>JPEG page</p>',
          elements: [],
          raw: { html: '<p>JPEG page</p>' },
          requestId: 'jpeg-request',
          model: 'document-parse',
          requestConfig: { mimeType: options.mimeType, pageNumber: options.pageNumber },
        };
      },
    },
  });

  expect(parseCalls).toEqual([{ mimeType: 'image/jpeg', pageNumber: 1 }]);
  expect(result.pages[0]).toMatchObject({
    mimeType: 'image/jpeg',
    dataUrl: 'data:image/jpeg;base64,/9j/4A==',
  });
});

test.each([
  { name: 'PNG', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimeType: 'image/png' },
  { name: 'WebP', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), mimeType: 'image/webp' },
])('parses a valid $name signature directly', async ({ bytes, mimeType }) => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const calls: string[] = [];

  const result = await parseDocumentLabFile(new File([bytes], 'image.bin', { type: mimeType }), {
    parser: {
      parse: async (_bytes, _filename, options) => {
        calls.push(options.mimeType);
        return { html: '<p>image</p>', elements: [], raw: {}, requestId: 'image-request', model: 'document-parse', requestConfig: {} };
      },
    },
  });

  expect(calls).toEqual([mimeType]);
  expect(result.pages[0]).toMatchObject({ mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` });
});

test('rejects supported magic bytes when the declared MIME type does not match', async () => {
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', { type: 'image/png' });

  await expect(parseDocumentLabFile(jpeg)).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_DOCUMENT_FILE',
  });
});

test('hands each rendered PDF page to the parser as a complete PNG image', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const rendererCalls: Uint8Array[] = [];
  const parserCalls: Array<{ bytes: Uint8Array; filename: string; mimeType: string; pageNumber: number }> = [];

  await parseDocumentLabFile(new File([pdfBytes], 'lesson.pdf'), {
    renderPdfPages: async (bytes) => {
      rendererCalls.push(bytes);
      return [{ pageNumber: 1, bytes: pngBytes, mimeType: 'image/png', filename: 'page-1.png', dataUrl: 'data:image/png;base64,iVBORw==' }];
    },
    parser: {
      parse: async (bytes, filename, options) => {
        parserCalls.push({ bytes, filename, mimeType: options.mimeType, pageNumber: options.pageNumber });
        return { html: '<p>page</p>', elements: [], raw: {}, requestId: 'pdf-request', model: 'document-parse', requestConfig: {} };
      },
    },
  });

  expect(rendererCalls).toEqual([pdfBytes]);
  expect(parserCalls).toEqual([{ bytes: pngBytes, filename: 'page-1.png', mimeType: 'image/png', pageNumber: 1 }]);
});

test('accepts exactly 100 MiB and rejects one additional byte based on file metadata', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const oneHundredMiB = 100 * 1024 * 1024;
  let parsed = false;

  await expect(parseDocumentLabFile(metadataFile(pngBytes, oneHundredMiB), {
    parser: {
      parse: async () => {
        parsed = true;
        return { html: '<p>page</p>', elements: [], raw: {}, requestId: 'size-request', model: 'document-parse', requestConfig: {} };
      },
    },
  })).resolves.toMatchObject({ mock: false });
  expect(parsed).toBe(true);
  await expect(parseDocumentLabFile(metadataFile(pngBytes, oneHundredMiB + 1))).rejects.toMatchObject({
    status: 400,
    code: 'FILE_TOO_LARGE',
  });
});

test('returns missing-key configuration error for a valid PDF before rendering', async () => {
  delete process.env.MOCK_PROVIDERS;
  delete process.env.UPSTAGE_API_KEY;
  let rendererCalled = false;

  await expect(parseDocumentLabFile(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'lesson.pdf'), {
    renderPdfPages: async () => {
      rendererCalled = true;
      throw new Error('Poppler should not run');
    },
  })).rejects.toMatchObject({ status: 409, code: 'UPSTAGE_NOT_CONFIGURED' });
  expect(rendererCalled).toBe(false);
});

test('returns a typed configured error without exposing credentials', async () => {
  delete process.env.MOCK_PROVIDERS;
  delete process.env.UPSTAGE_API_KEY;
  const form = new FormData();
  form.set('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'page.png', { type: 'image/png' }));

  const response = await createDocumentLabPostHandler({
    loadActiveProfile: async () => documentParseProfile,
  })(new Request('http://localhost/api/document-lab/parse', { method: 'POST', body: form }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    code: 'UPSTAGE_NOT_CONFIGURED',
    message: 'UPSTAGE_API_KEY is required to parse documents.',
  });
});

test('stops streamed PDF accumulation at the page limit and closes the renderer', async () => {
  process.env.MOCK_PROVIDERS = 'true';
  let cleaned = false;
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'lesson.pdf', { type: 'application/pdf' });

  const parsing = parseDocumentLabFile(pdf, {
    limits: { ...DOCUMENT_LAB_LIMITS, maxPages: 1 },
    streamPdfPages: async function* () {
      try {
        yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
        yield { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png', filename: 'page-2.png', width: null, height: null };
      } finally {
        cleaned = true;
      }
    },
  });

  await expect(parsing).rejects.toMatchObject({ status: 413, code: 'LAB_PAGE_LIMIT_EXCEEDED' });
  expect(cleaned).toBe(true);
});

test('rejects expanded rendered bytes before building an unbounded Lab response', async () => {
  process.env.MOCK_PROVIDERS = 'true';
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'lesson.pdf', { type: 'application/pdf' });

  await expect(parseDocumentLabFile(pdf, {
    limits: { ...DOCUMENT_LAB_LIMITS, maxRenderedBytes: 1 },
    streamPdfPages: async function* () {
      yield { pageNumber: 1, bytes: new Uint8Array([1, 2]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
    },
  })).rejects.toMatchObject({ status: 413, code: 'LAB_RENDERED_BYTES_LIMIT_EXCEEDED' });
});

test('rejects an oversized serialized Lab response with a typed 4xx error', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'page.png', { type: 'image/png' });

  await expect(parseDocumentLabFile(png, {
    limits: { ...DOCUMENT_LAB_LIMITS, maxResponseBytes: 128 },
    parser: {
      parse: async () => ({
        html: `<p>${'x'.repeat(256)}</p>`, elements: [], raw: {}, requestId: 'large-response', model: 'document-parse', requestConfig: {},
      }),
    },
  })).rejects.toMatchObject({ status: 413, code: 'LAB_RESPONSE_LIMIT_EXCEEDED' });
});

test('returns safe page and request provenance while redacting provider bodies and credentials', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'super-secret-key';
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({ error: 'Authorization Bearer super-secret-key', image: 'data:image/png;base64,AAAA' }),
    { status: 503, headers: { 'x-request-id': 'provider-request-7' } },
  )));
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'page.png', { type: 'image/png' }));

  const response = await createDocumentLabPostHandler({
    loadActiveProfile: async () => documentParseProfile,
    parseFile: (file, dependencies) => parseDocumentLabFile(file, {
      ...dependencies,
      providerRetry:{
        maxAttempts:2,
        baseDelayMs:1,
        maxDelayMs:1,
        random:() => 0.5,
        sleep:async () => undefined,
      },
    }),
  })(new Request('http://localhost/api/document-lab/parse', { method: 'POST', body: form }));
  const body = await response.json();

  expect(response.status).toBe(502);
  expect(body).toEqual({
    code: 'DOCUMENT_PAGE_PARSE_FAILED',
    message: 'Unable to parse document page 1.',
    pageNumber: 1,
    provider: 'upstage',
    category: 'PROVIDER_5XX',
    status: 503,
    requestId: 'provider-request-7',
  });
  expect(JSON.stringify(body)).not.toMatch(/super-secret|authorization|base64|AAAA|stack/i);
});

test('extracts original PNG dimensions for the page-coordinate signature', async () => {
  process.env.MOCK_PROVIDERS = 'true';
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 480);

  const result = await parseDocumentLabFile(new File([png], 'page.png', { type: 'image/png' }));

  expect(result.pages[0]).toMatchObject({ width: 640, height: 480 });
});

test('retries a rate-limited Document Lab page without rerendering the file', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const png = new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], 'page.png', { type:'image/png' });
  let attempts = 0;
  const delays: number[] = [];

  const result = await parseDocumentLabFile(png, {
    parser:{
      parse:async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderError({
            kind:'RATE_LIMIT',
            message:'limited',
            retryable:true,
            status:429,
          });
        }
        return {
          html:'<p>page</p>',
          elements:[],
          raw:{},
          requestId:'request-1',
          model:'document-parse',
          requestConfig:{},
        };
      },
    },
    providerRetry:{
      maxAttempts:3,
      baseDelayMs:1_000,
      maxDelayMs:60_000,
      random:() => 0.5,
      sleep:async (delayMs) => {
        delays.push(delayMs);
      },
    },
  });

  expect(attempts).toBe(3);
  expect(delays).toEqual([1_000, 2_000]);
  expect(result.pages[0]?.html).toBe('<p>page</p>');
});

test('stops a Document Lab retry backoff when the browser request is cancelled', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const png = new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], 'page.png', { type:'image/png' });
  const controller = new AbortController();
  const reason = new Error('browser request cancelled');
  let sleepStarted!: () => void;
  const sleeping = new Promise<void>((resolve) => {
    sleepStarted = resolve;
  });
  const neverFinishes = new Promise<void>(() => undefined);

  const parsing = parseDocumentLabFile(png, {
    signal:controller.signal,
    parser:{
      parse:async () => {
        throw new ProviderError({
          kind:'RATE_LIMIT',
          message:'limited',
          retryable:true,
          status:429,
        });
      },
    },
    providerRetry:{
      maxAttempts:3,
      sleep:async () => {
        sleepStarted();
        await neverFinishes;
      },
    },
  });

  await sleeping;
  controller.abort(reason);
  await expect(parsing).rejects.toBe(reason);
});

test('applies the explicit active profile to rasterization and concurrent parsing while preserving page order', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const pdf = new File(
    [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])],
    'lesson.pdf',
    { type: 'application/pdf' },
  );
  const releases = new Map<number, () => void>();
  const parserCalls: number[] = [];
  let activeParsers = 0;
  let maximumActiveParsers = 0;
  let renderOptions: unknown;
  let parserOptions: unknown;

  const parsing = parseDocumentLabFile(pdf, {
    profile: documentParseProfile,
    streamPdfPages: async function* (_bytes, options) {
      renderOptions = options;
      for (const pageNumber of [1, 2, 3]) {
        yield {
          pageNumber,
          bytes: new Uint8Array([pageNumber]),
          mimeType: 'image/jpeg',
          filename: `page-${pageNumber}.jpg`,
          width: null,
          height: null,
        };
      }
    },
    createParser: (options) => {
      parserOptions = options;
      return {
        parse: async (_bytes, _filename, parseOptions) => {
          parserCalls.push(parseOptions.pageNumber);
          activeParsers += 1;
          maximumActiveParsers = Math.max(maximumActiveParsers, activeParsers);
          await new Promise<void>((resolve) => releases.set(parseOptions.pageNumber, resolve));
          activeParsers -= 1;
          return {
            html: `<p>page ${parseOptions.pageNumber}</p>`,
            markdown: `page ${parseOptions.pageNumber}`,
            elements: [],
            raw: { pageNumber: parseOptions.pageNumber },
            requestId: `request-${parseOptions.pageNumber}`,
            model: documentParseProfile.settings.model,
            requestConfig: { pageNumber: parseOptions.pageNumber },
          };
        },
      };
    },
  });

  await vi.waitFor(() => expect(parserCalls).toEqual([1, 2]));
  releases.get(2)!();
  await vi.waitFor(() => expect(parserCalls).toEqual([1, 2, 3]));
  releases.get(3)!();
  releases.get(1)!();
  const result = await parsing;

  expect(maximumActiveParsers).toBe(2);
  expect(renderOptions).toEqual({
    format: 'jpeg',
    dpi: 300,
    jpegQuality: 92,
    pagesPerBatch: 8,
    timeoutMs: 45_000,
  });
  expect(parserOptions).toMatchObject({
    apiKey: 'server-only-key',
    model: 'document-parse-profile-model',
    mode: 'standard',
    ocr: 'auto',
    base64Encoding: ['table', 'figure', 'chart', 'equation'],
    outputFormats: ['html', 'markdown'],
    timeoutMs: 45_000,
  });
  expect(result.requestConfig).toEqual({
    profile: {
      id: documentParseProfile.id,
      version: documentParseProfile.version,
      contentHash: documentParseProfile.contentHash,
    },
    provider: 'upstage',
    model: 'document-parse-profile-model',
    ocr: 'auto',
    mode: 'standard',
    base64_encoding: ['table', 'figure', 'chart', 'equation'],
    output_formats: ['html', 'markdown'],
    rasterization: {
      format: 'jpeg',
      lossless: false,
      dpi: 300,
      jpegQuality: 92,
    },
    pages_per_batch: 8,
    page_concurrency: 2,
    request_timeout_ms: 45_000,
  });
  expect(result.pages.map((page) => ({
    pageNumber: page.pageNumber,
    html: page.html,
    markdown: page.markdown,
  }))).toEqual([
    { pageNumber: 1, html: '<p>page 1</p>', markdown: 'page 1' },
    { pageNumber: 2, html: '<p>page 2</p>', markdown: 'page 2' },
    { pageNumber: 3, html: '<p>page 3</p>', markdown: 'page 3' },
  ]);
});

test('strictly resolves exactly one active document parse profile', async () => {
  const loaded = await loadActiveDocumentParseProfile(async () => ({
    items: [{
      id: documentParseProfile.id,
      kind: 'document_parse',
      version: documentParseProfile.version,
      title: 'Document Lab test profile',
      definition: {
        schemaVersion: 1,
        kind: 'document_parse',
        version: documentParseProfile.version,
        title: 'Document Lab test profile',
        description: 'Document Lab에서 활성 프로필을 엄격히 읽는 동작을 검증하기 위한 설정입니다.',
        applyScope: '활성화한 이후의 Document Lab 분석 요청에만 해당 설정이 적용됩니다.',
        reprocessingImpact: 'Document Lab은 결과를 저장하지 않으므로 기존 문서를 다시 처리할 필요가 없습니다.',
        settings: documentParseProfile.settings,
      },
      contentHash: documentParseProfile.contentHash,
      createdAt: '2026-07-26T00:00:00.000Z',
      active: true,
    }],
    activeByKind: { document_parse: documentParseProfile.id },
  }));

  expect(loaded).toEqual(documentParseProfile);
});

test('returns a typed configuration error when no active document parse profile exists', async () => {
  const post = createDocumentLabPostHandler({
    loadActiveProfile: () => loadActiveDocumentParseProfile(async () => ({
      items: [],
      activeByKind: {},
    })),
  });
  const form = new FormData();
  form.set(
    'file',
    new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      'page.png',
      { type: 'image/png' },
    ),
  );

  const response = await post(new Request(
    'http://localhost/api/document-lab/parse',
    { method: 'POST', body: form },
  ));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    code: 'DOCUMENT_PARSE_PROFILE_NOT_CONFIGURED',
    message: '활성 문서 파싱 연구 프로필이 없습니다.',
  });
});

test('returns a typed integrity error when the stored active profile fails verification', async () => {
  const post = createDocumentLabPostHandler({
    loadActiveProfile: async () => {
      throw new DomainError(
        'RESEARCH_PROFILE_INTEGRITY_ERROR',
        '저장된 프로필 정의와 해시가 일치하지 않습니다.',
      );
    },
  });
  const form = new FormData();
  form.set(
    'file',
    new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      'page.png',
      { type: 'image/png' },
    ),
  );

  const response = await post(new Request(
    'http://localhost/api/document-lab/parse',
    { method: 'POST', body: form },
  ));

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    code: 'DOCUMENT_PARSE_PROFILE_INTEGRITY_ERROR',
    message: '활성 문서 파싱 연구 프로필의 무결성을 확인하지 못했습니다.',
  });
});
