import { afterEach, expect, test, vi } from 'vitest';
import { POST } from '@/app/api/document-lab/parse/route';
import { DOCUMENT_LAB_LIMITS, parseDocumentLabFile } from '@/server/documents/lab';

const originalMockProviders = process.env.MOCK_PROVIDERS;
const originalUpstageApiKey = process.env.UPSTAGE_API_KEY;

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
      model: 'mock-document-parse',
      ocr: 'force',
      mode: 'enhanced',
      base64_encoding: ['table', 'figure', 'chart', 'equation'],
      output_formats: ['html'],
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
        model: 'mock-document-parse',
        ocr: 'force',
        mode: 'enhanced',
        base64_encoding: ['table', 'figure', 'chart', 'equation'],
        output_formats: ['html'],
        mimeType: 'image/png',
        pageNumber: 1,
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

  const response = await POST(new Request('http://localhost/api/document-lab/parse', { method: 'POST', body: form }));

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ error: 'Authorization Bearer super-secret-key', image: 'data:image/png;base64,AAAA' }),
    { status: 503, headers: { 'x-request-id': 'provider-request-7' } },
  )));
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'page.png', { type: 'image/png' }));

  const response = await POST(new Request('http://localhost/api/document-lab/parse', { method: 'POST', body: form }));
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
