import { expect, test } from 'vitest';
import { UpstageDocumentParser } from '@/server/providers/upstage-document';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';

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
