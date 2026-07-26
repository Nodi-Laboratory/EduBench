import { expect, test } from 'vitest';
import {
  effectiveDocumentParseConcurrency,
  DOCUMENT_PARSE_PAGES_PER_TASK,
  parseDocumentPages,
} from '@/server/documents/pipeline';
import { ProviderError } from '@/server/providers/types';

test('caps Upstage page concurrency at a safe runtime limit while retaining a lower researcher setting', () => {
  expect(effectiveDocumentParseConcurrency(4)).toBe(2);
  expect(effectiveDocumentParseConcurrency(1)).toBe(1);
  expect(effectiveDocumentParseConcurrency(4, '6')).toBe(4);
  expect(effectiveDocumentParseConcurrency(4, 'invalid')).toBe(2);
});

test('renders PDF pages and parses PNG pages in page-number order', async () => {
  const pdf = new Uint8Array([37, 80, 68, 70]);
  const calls: Array<{ bytes: Uint8Array; filename: string; mimeType: string; pageNumber: number }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
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
          markdown: `page ${options.pageNumber}`,
          raw: { request: options.pageNumber },
          requestId: `request-${options.pageNumber}`,
          model: 'document-parse-enhanced',
          requestConfig: { pageNumber: options.pageNumber },
        };
      },
    },
    onEvent: (type, payload) => {
      events.push({ type, payload });
    },
  });

  await firstPageStarted;
  expect(calls).toHaveLength(1);
  resumeFirstPage();
  const result = await resultPromise;

  expect(calls).toEqual([
    { bytes: new Uint8Array([1]), filename: 'page-1.png', mimeType: 'image/png', pageNumber: 1 },
    { bytes: new Uint8Array([2]), filename: 'page-2.png', mimeType: 'image/png', pageNumber: 2 },
  ]);
  expect(result.html).toBe('<section data-page="1"><p>page 1</p></section><section data-page="2"><p>page 2</p></section>');
  expect(result.raw).toEqual({
    pageCount: 2,
    pages: [
      { pageNumber: 1, requestId: 'request-1', model: 'document-parse-enhanced', requestConfig: { pageNumber: 1 } },
      { pageNumber: 2, requestId: 'request-2', model: 'document-parse-enhanced', requestConfig: { pageNumber: 2 } },
    ],
  });
  expect(events.find((event) =>
    event.type === 'DOCUMENT_PAGE_PARSE_COMPLETED'
    && event.payload.pageNumber === 1)).toMatchObject({
    payload: {
      htmlPreview: '<p>page 1</p>',
      markdownPreview: 'page 1',
      rawPreview: '{"request":1}',
      outputTruncated: false,
    },
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

test('retries a rate-limited page inside the page task without rerasterizing the document', async () => {
  let rasterizations = 0;
  let parseAttempts = 0;
  const retryEvents: Array<Record<string, unknown>> = [];
  const delays: number[] = [];

  const result = await parseDocumentPages(
    new Uint8Array([37, 80, 68, 70]),
    'textbook.pdf',
    {
      streamPdfPages:async function* () {
        rasterizations += 1;
        yield {
          pageNumber:1,
          bytes:new Uint8Array([1]),
          mimeType:'image/png',
          filename:'page-1.png',
          width:null,
          height:null,
        };
      },
      parser:{
        parse:async () => {
          parseAttempts += 1;
          if (parseAttempts < 3) {
            throw new ProviderError({
              kind:'RATE_LIMIT',
              message:'limited',
              retryable:true,
              status:429,
            });
          }
          return {
            html:'<p>page 1</p>',
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
      onEvent:(eventType, payload) => {
        if (eventType === 'DOCUMENT_PAGE_PARSE_RETRY') retryEvents.push(payload);
      },
    },
  );

  expect(result.raw.pageCount).toBe(1);
  expect(rasterizations).toBe(1);
  expect(parseAttempts).toBe(3);
  expect(delays).toEqual([1_000, 2_000]);
  expect(retryEvents).toEqual([
    expect.objectContaining({
      pageNumber:1,
      failedAttempt:1,
      nextAttempt:2,
      delayMs:1_000,
      kind:'RATE_LIMIT',
      status:429,
    }),
    expect.objectContaining({
      pageNumber:1,
      failedAttempt:2,
      nextAttempt:3,
      delayMs:2_000,
      kind:'RATE_LIMIT',
      status:429,
    }),
  ]);
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
    batchSize: 1,
    concurrency: 1,
  });

  await Promise.race([started, resultPromise]);
  expect(produced).toEqual([1]);
  releaseFirstPage();
  await expect(resultPromise).resolves.toMatchObject({ html: expect.stringContaining('data-page="2"') });
  expect(produced).toEqual([1, 2]);
});

test('drops the processed high-resolution page bytes before later pages finish parsing', async () => {
  const firstPage = {
    pageNumber: 1,
    bytes: new Uint8Array(8 * 1024 * 1024),
    mimeType: 'image/png' as const,
    filename: 'page-1.png',
    width: null,
    height: null,
  };
  let secondPageStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { secondPageStarted = resolve; });
  let releaseSecondPage!: () => void;
  const secondReleased = new Promise<void>((resolve) => { releaseSecondPage = resolve; });

  const resultPromise = parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      yield firstPage;
      yield {
        pageNumber: 2,
        bytes: new Uint8Array([2]),
        mimeType: 'image/png',
        filename: 'page-2.png',
        width: null,
        height: null,
      };
    },
    batchSize: 1,
    concurrency: 1,
    parser: {
      parse: async (_bytes, _filename, options) => {
        if (options.pageNumber === 2) {
          secondPageStarted();
          await secondReleased;
        }
        return {
          html: `<p>${options.pageNumber}</p>`,
          raw: { page: options.pageNumber },
          requestId: String(options.pageNumber),
          model: 'document-parse',
          requestConfig: {},
        };
      },
    },
  });

  await secondStarted;
  expect(firstPage.bytes.byteLength).toBe(0);
  releaseSecondPage();
  await expect(resultPromise).resolves.toMatchObject({
    html: expect.stringContaining('data-page="2"'),
  });
});

test('parses page batches concurrently and preserves page order', async () => {
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const resultPromise = parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    renderPdfPages: async () => [1, 2, 3].map((pageNumber) => ({
      pageNumber, bytes: new Uint8Array([pageNumber]), mimeType: 'image/png' as const,
      filename: `page-${pageNumber}.png`, dataUrl: '',
    })),
    batchSize: 1,
    concurrency: 2,
    parser: { parse: async (_bytes, _filename, options) => {
      started.push(options.pageNumber);
      await new Promise<void>((resolve) => releases.set(options.pageNumber, resolve));
      return { html: `<p>${options.pageNumber}</p>`, raw: {}, requestId: String(options.pageNumber), model: 'document-parse', requestConfig: {} };
    } },
  });
  await waitUntil(() => started.length === 2);
  expect(started).toEqual([1, 2]);
  releases.get(2)!();
  releases.get(1)!();
  await waitUntil(() => started.length === 3);
  releases.get(3)!();
  const result = await resultPromise;
  expect(result.html).toContain('data-page="1"');
  expect(result.html.indexOf('data-page="1"')).toBeLessThan(result.html.indexOf('data-page="2"'));
  expect(result.html.indexOf('data-page="2"')).toBeLessThan(result.html.indexOf('data-page="3"'));
});

test('never retains more raster page buffers than the configured page concurrency', async () => {
  const concurrency = 2;
  const produced: Array<{ pageNumber: number; bytes: Uint8Array }> = [];
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const resultPromise = parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
        const page = {
          pageNumber,
          bytes: new Uint8Array([pageNumber]),
          mimeType: 'image/png' as const,
          filename: `page-${pageNumber}.png`,
          width: null,
          height: null,
        };
        produced.push(page);
        yield page;
      }
    },
    batchSize: DOCUMENT_PARSE_PAGES_PER_TASK,
    concurrency,
    parser: {
      parse: async (_bytes, _filename, options) => {
        started.push(options.pageNumber);
        await new Promise<void>((resolve) => releases.set(options.pageNumber, resolve));
        return {
          html: `<p>${options.pageNumber}</p>`,
          raw: {},
          requestId: String(options.pageNumber),
          model: 'document-parse',
          requestConfig: {},
        };
      },
    },
  });

  await waitUntil(() => started.length === concurrency);
  expect(produced.filter((page) => page.bytes.byteLength > 0).length)
    .toBeLessThanOrEqual(concurrency);

  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    releases.get(pageNumber)!();
    if (pageNumber + concurrency <= 5) {
      await waitUntil(() => started.includes(pageNumber + concurrency));
      expect(produced.filter((page) => page.bytes.byteLength > 0).length)
        .toBeLessThanOrEqual(concurrency);
    }
  }
  await expect(resultPromise).resolves.toMatchObject({
    raw: { pageCount: 5 },
  });
});

test('starts parsing the first rendered batch while the next raster batch is still being produced', async () => {
  const produced: number[] = [];
  const started: number[] = [];
  const order: string[] = [];
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const resultPromise = parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      produced.push(1);
      order.push('render:1');
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
      await firstStarted;
      produced.push(2);
      order.push('render:2');
      yield { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png', filename: 'page-2.png', width: null, height: null };
    },
    batchSize: 1,
    concurrency: 2,
    parser: {
      parse: async (_bytes, _filename, options) => {
        started.push(options.pageNumber);
        order.push(`parse:${options.pageNumber}`);
        if (options.pageNumber === 1) {
          signalFirstStarted();
          await firstReleased;
        }
        return {
          html: `<p>${options.pageNumber}</p>`,
          raw: {},
          requestId: String(options.pageNumber),
          model: 'document-parse',
          requestConfig: {},
        };
      },
    },
  });

  await waitUntil(() => started.includes(1));
  await waitUntil(() => produced.includes(2));
  expect(order.indexOf('parse:1')).toBeLessThan(order.indexOf('render:2'));
  await waitUntil(() => started.includes(2));
  expect(started).toEqual([1, 2]);
  releaseFirst();
  await expect(resultPromise).resolves.toMatchObject({
    html: expect.stringContaining('data-page="2"'),
  });
});

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

test('keeps complete page raw responses without duplicating them in revision summary provenance', async () => {
  const oversizedRaw = { duplicatedBase64: 'A'.repeat(64 * 1024 + 1) };
  const fullMarkdown = `# 원문\n\n${'문'.repeat(64 * 1024 + 1)}`;

  const result = await parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: null, height: null };
    },
    parser: {
      parse: async () => ({
        html: '<p>page</p>',
        markdown: fullMarkdown,
        raw: oversizedRaw,
        requestId: 'request-1',
        model: 'document-parse',
        requestConfig: {},
      }),
    },
  });

  expect(result).toMatchObject({
    pageArtifacts: [{
      pageNumber: 1,
      html: '<p>page</p>',
      markdown: fullMarkdown,
      raw: oversizedRaw,
      requestId: 'request-1',
      model: 'document-parse',
      requestConfig: {},
    }],
    raw: {
      pageCount: 1,
      pages: [{
        pageNumber: 1,
        requestId: 'request-1',
        model: 'document-parse',
        requestConfig: {},
      }],
    },
  });
  expect(JSON.stringify(result.raw)).not.toContain(oversizedRaw.duplicatedBase64);
  expect(result.markdown).toBe(`<!-- page:1 -->\n${fullMarkdown}`);
});

test('does not manufacture request ids or markdown bodies from empty provider fields', async () => {
  const result = await parseDocumentPages(new Uint8Array([37, 80, 68, 70]), {
    streamPdfPages: async function* () {
      yield { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', width: 10, height: 20 };
      yield { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png', filename: 'page-2.png', width: 10, height: 20 };
    },
    parser: {
      parse: async () => ({
        html: '<p>page</p>',
        markdown: '',
        raw: {},
        requestId: null,
        model: 'document-parse',
        requestConfig: {},
      }),
    },
  });

  expect(result.requestId).toBeNull();
  expect(result.markdown).toBeNull();
  expect(result.pageArtifacts.map((page) => page.markdown)).toEqual([null, null]);
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
