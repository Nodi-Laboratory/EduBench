import { afterEach, expect, test, vi } from 'vitest';
import { UpstageDocumentParser } from '@/server/providers/upstage-document';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';

afterEach(() => vi.useRealTimers());

test('sends the Upstage Enhanced multipart request for a PNG page', async () => {
  const parser = new UpstageDocumentParser({ apiKey: 'secret', model: 'document-parse-enhanced', baseUrl: 'https://upstage.test/v1/', fetch: async (url, init) => {
    expect(url).toBe('https://upstage.test/v1/document-digitization');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('ocr')).toBe('force');
    expect(form.get('mode')).toBe('enhanced');
    expect(form.get('base64_encoding')).toBe(JSON.stringify(['footnote']));
    expect(form.get('output_formats')).toBe(JSON.stringify(['html']));
    expect(form.get('model')).toBe('document-parse-enhanced');
    const document = form.get('document');
    expect(document).toBeInstanceOf(Blob);
    expect((document as Blob).type).toBe('image/png');
    return new Response(JSON.stringify({ content: { html: '<section data-page="1"><p>원자</p></section>' }, model: 'document-parse-enhanced' }), { headers: { 'x-request-id': 'parse-1' } });
  } });
  await expect(parser.parse(new Uint8Array([1, 2]), 'page-1.png', { mimeType: 'image/png', pageNumber: 1 })).resolves.toMatchObject({
    html: expect.stringContaining('원자'), elements: [], requestId: 'parse-1', model: 'document-parse-enhanced',
    requestConfig: { model: 'document-parse-enhanced', ocr: 'force', mode: 'enhanced', base64_encoding: ['footnote'], output_formats: ['html'], mimeType: 'image/png', pageNumber: 1 },
  });
});

test('normalizes Gemini batch embeddings and uses its normalized base URL override', async () => {
  const embedder = new GeminiEmbedder({ apiKey: 'secret', modelId: 'gemini-embedding-test', dimensions: 3, baseUrl: 'https://gemini.test/', fetch: async (url) => {
    expect(url).toBe('https://gemini.test/v1beta/models/gemini-embedding-test:batchEmbedContents?key=secret');
    return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }] }));
  } });
  await expect(embedder.embed(['원자', '분자'])).resolves.toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
});

test('aborts an Upstage document request at its configured deadline', async () => {
  vi.useFakeTimers();
  const parser = new UpstageDocumentParser({
    apiKey: 'secret',
    timeoutMs: 25,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing timeout signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const parsing = parser.parse(new Uint8Array([1]), 'page-1.png', { mimeType: 'image/png', pageNumber: 1 });
  const assertion = expect(parsing).rejects.toMatchObject({ kind: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(26);
  await assertion;
});

test('preserves the caller cancellation reason', async () => {
  const controller = new AbortController();
  const reason = new Error('lease lost');
  controller.abort(reason);
  const parser = new UpstageDocumentParser({
    apiKey: 'secret',
    fetch: async (_url, init) => Promise.reject(init?.signal?.reason),
  });

  await expect(parser.parse(
    new Uint8Array([1]),
    'page-1.png',
    { mimeType: 'image/png', pageNumber: 1, signal: controller.signal },
  )).rejects.toBe(reason);
});
