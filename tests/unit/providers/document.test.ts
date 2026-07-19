import { expect, test } from 'vitest';
import { UpstageDocumentParser } from '@/server/providers/upstage-document';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';

test('normalizes Upstage Document Parse HTML and request id', async () => {
  const parser = new UpstageDocumentParser({ apiKey: 'secret', fetch: async (_url, init) => {
    expect(init?.method).toBe('POST'); expect(init?.body).toBeInstanceOf(FormData);
    return new Response(JSON.stringify({ content: { html: '<section data-page="1"><p>원자</p></section>' }, model: 'document-parse' }), { headers: { 'x-request-id': 'parse-1' } });
  } });
  await expect(parser.parse(new Uint8Array([1, 2]), 'book.pdf')).resolves.toMatchObject({ html: expect.stringContaining('원자'), requestId: 'parse-1', model: 'document-parse' });
});

test('normalizes Gemini batch embeddings', async () => {
  const embedder = new GeminiEmbedder({ apiKey: 'secret', modelId: 'gemini-embedding-test', dimensions: 3, fetch: async () => new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }] })) });
  await expect(embedder.embed(['원자', '분자'])).resolves.toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
});
