import { expect, test } from 'vitest';
import { MAX_PERSISTED_RAW_PROVENANCE_BYTES, parseDocumentPages } from '@/server/documents/pipeline';

test('renders PDF pages and parses PNG pages in page-number order', async () => {
  const pdf = new Uint8Array([37, 80, 68, 70]);
  const calls: Array<{ bytes: Uint8Array; filename: string; mimeType: string; pageNumber: number }> = [];
  let signalFirstPageStarted: () => void = () => {};
  const firstPageStarted = new Promise<void>((resolve) => { signalFirstPageStarted = resolve; });
  let resumeFirstPage: () => void = () => {};
  const firstPageComplete = new Promise<void>((resolve) => { resumeFirstPage = resolve; });
  const pages = [
    { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png' as const, filename: 'page-1.png', dataUrl: 'data:image/png;base64,AQ==' },
    { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png' as const, filename: 'page-2.png', dataUrl: 'data:image/png;base64,Ag==' },
  ];

  const resultPromise = parseDocumentPages(pdf, 'textbook.pdf', {
    renderPdfPages: async (bytes) => {
      expect(bytes).toBe(pdf);
      return pages;
    },
    parser: {
      parse: async (bytes, filename, options) => {
        calls.push({ bytes, filename, mimeType: options.mimeType, pageNumber: options.pageNumber });
        if (options.pageNumber === 1) {
          signalFirstPageStarted();
          await firstPageComplete;
        }
        return {
          html: `<p>page ${options.pageNumber}</p>`,
          raw: { request: options.pageNumber },
          requestId: `request-${options.pageNumber}`,
          model: 'document-parse-enhanced',
          requestConfig: { pageNumber: options.pageNumber },
        };
      },
    },
  });

  await firstPageStarted;
  expect(calls).toHaveLength(1);
  resumeFirstPage();
  const result = await resultPromise;

  expect(calls).toEqual([
    { bytes: pages[0]!.bytes, filename: 'page-1.png', mimeType: 'image/png', pageNumber: 1 },
    { bytes: pages[1]!.bytes, filename: 'page-2.png', mimeType: 'image/png', pageNumber: 2 },
  ]);
  expect(result.html).toBe('<section data-page="1"><p>page 1</p></section><section data-page="2"><p>page 2</p></section>');
  expect(result.raw).toEqual({
    pages: [
      { pageNumber: 1, requestId: 'request-1', model: 'document-parse-enhanced', requestConfig: { pageNumber: 1 }, raw: { request: 1 } },
      { pageNumber: 2, requestId: 'request-2', model: 'document-parse-enhanced', requestConfig: { pageNumber: 2 }, raw: { request: 2 } },
    ],
  });
});

test('names the failed page while preserving the parser error', async () => {
  await expect(parseDocumentPages(new Uint8Array([37, 80, 68, 70]), 'textbook.pdf', {
    renderPdfPages: async () => [
      { pageNumber: 3, bytes: new Uint8Array([3]), mimeType: 'image/png', filename: 'page-3.png', dataUrl: 'data:image/png;base64,Aw==' },
    ],
    parser: {
      parse: async () => {
        throw new Error('provider temporarily unavailable');
      },
    },
  })).rejects.toThrow('DOCUMENT_PARSE_PAGE_3: provider temporarily unavailable');
});

test('consumes the PDF spool one page at a time and releases each page before requesting the next', async () => {
  const produced: number[] = [];
  let firstPageStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstPageStarted = resolve; });
  let releaseFirstPage!: () => void;
  const released = new Promise<void>((resolve) => { releaseFirstPage = resolve; });

  const resultPromise = parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      produced.push(1);
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: 100, height: 200 };
      produced.push(2);
      yield { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png', filename: 'page-2.png', width: 100, height: 200 };
    },
    parser: {
      parse: async (_bytes, _filename, options) => {
        if (options.pageNumber === 1) {
          firstPageStarted();
          await released;
        }
        return { html: `<p>${options.pageNumber}</p>`, raw: {}, requestId: null, model: 'document-parse', requestConfig: {} };
      },
    },
  });

  await Promise.race([started, resultPromise]);
  expect(produced).toEqual([1]);
  releaseFirstPage();
  await expect(resultPromise).resolves.toMatchObject({ html: expect.stringContaining('data-page="2"') });
  expect(produced).toEqual([1, 2]);
});

test('bounds aggregate persistent raw provenance without retaining oversized provider payloads', async () => {
  const oversizedRaw = { duplicatedBase64: 'A'.repeat(MAX_PERSISTED_RAW_PROVENANCE_BYTES + 1) };

  const result = await parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
    },
    parser: {
      parse: async () => ({ html: '<p>page</p>', raw: oversizedRaw, requestId: 'request-1', model: 'document-parse', requestConfig: {} }),
    },
  });

  expect(result.raw.pages[0]?.raw).toEqual({
    omitted: true,
    reason: 'PERSISTED_RAW_PROVENANCE_LIMIT',
    byteLength: expect.any(Number),
  });
  expect(JSON.stringify(result.raw)).not.toContain(oversizedRaw.duplicatedBase64);
});

test('preserves the document cancellation reason instead of wrapping it as a page failure', async () => {
  const controller = new AbortController();
  const reason = new Error('lease lost');

  await expect(parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    signal: controller.signal,
    streamPdfPages: async function* () {
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
    },
    parser: {
      parse: async () => {
        controller.abort(reason);
        throw reason;
      },
    },
  })).rejects.toBe(reason);
});
