import { afterEach, expect, test } from 'vitest';
import { POST } from '@/app/api/document-lab/parse/route';
import { parseDocumentLabFile } from '@/server/documents/lab';

const originalMockProviders = process.env.MOCK_PROVIDERS;
const originalUpstageApiKey = process.env.UPSTAGE_API_KEY;

afterEach(() => {
  if (originalMockProviders === undefined) delete process.env.MOCK_PROVIDERS;
  else process.env.MOCK_PROVIDERS = originalMockProviders;
  if (originalUpstageApiKey === undefined) delete process.env.UPSTAGE_API_KEY;
  else process.env.UPSTAGE_API_KEY = originalUpstageApiKey;
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
      base64_encoding: ['footnote'],
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
        base64_encoding: ['footnote'],
        output_formats: ['html'],
        mimeType: 'image/png',
        pageNumber: 1,
      },
    }],
  });
});

test('parses a JPEG directly using its detected mime type and data URL', async () => {
  delete process.env.MOCK_PROVIDERS;
  process.env.UPSTAGE_API_KEY = 'server-only-key';
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.bin', { type: 'application/octet-stream' });
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
