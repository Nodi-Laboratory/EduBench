import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { renderPdfPages, streamPdfPages } from '@/server/documents/page-renderer';

test('renders PDF pages as ordered 150-DPI PNG data URLs', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const pages = await renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      if (command === 'pdfinfo') return { stdout: 'Pages:          10\n' };
      const outputPrefix = args.at(-1)!;
      for (const pageNumber of [10, 2, 1, 9, 3, 8, 4, 7, 5, 6]) {
        await writeFile(`${outputPrefix}-${pageNumber}.png`, new Uint8Array([pageNumber]));
      }
    },
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ command: 'pdfinfo' });
  expect(calls[1]).toMatchObject({ command: 'pdftoppm' });
  expect(calls[1]!.args.slice(0, 7)).toEqual(['-f', '1', '-l', '10', '-png', '-r', '150']);
  expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(pages[0]).toEqual({
    pageNumber: 1,
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    filename: 'page-1.png',
    dataUrl: 'data:image/png;base64,AQ==',
  });
  expect(pages.at(-1)).toEqual({
    pageNumber: 10,
    bytes: new Uint8Array([10]),
    mimeType: 'image/png',
    filename: 'page-10.png',
    dataUrl: 'data:image/png;base64,Cg==',
  });
  await expect(access(dirname(calls[1]!.args.at(-1)!))).rejects.toThrow();
});

test('applies pinned JPEG DPI and quality rasterization settings', async () => {
  const calls: string[][] = [];
  const pages = await renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    format:'jpeg',
    dpi:300,
    jpegQuality:92,
    commandRunner:async (_command, args) => {
      calls.push(args);
      if (args.length === 1) return { stdout: 'Pages: 1\n' };
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, new Uint8Array([0xff, 0xd8]));
    },
  });

  expect(calls[1]).toEqual([
    '-f',
    '1',
    '-l',
    '1',
    '-jpeg',
    '-jpegopt',
    'quality=92',
    '-r',
    '300',
    expect.stringContaining('source.pdf'),
    expect.stringContaining('page'),
  ]);
  expect(pages[0]).toMatchObject({
    mimeType:'image/jpeg',
    filename:'page-1.jpg',
    dataUrl:'data:image/jpeg;base64,/9g=',
  });
});

test('cleans up temporary PDF files when rendering fails', async () => {
  let tempDirectory = '';

  await expect(renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    commandRunner: async (command, args) => {
      if (command === 'pdfinfo') return { stdout: 'Pages: 1\n' };
      tempDirectory = dirname(args.at(-1)!);
      throw new Error('pdftoppm failed');
    },
  })).rejects.toThrow('DOCUMENT_RASTERIZATION_FAILED: page range 1-1: pdftoppm failed');

  await expect(access(tempDirectory)).rejects.toThrow();
});

test('streams one spooled PNG at a time without persistent data URLs and cleans up on early return', async () => {
  let tempDirectory = '';
  const controller = new AbortController();
  const pages = streamPdfPages(new Uint8Array([37, 80, 68, 70]), {
    signal: controller.signal,
    timeoutMs: 12_345,
    commandRunner: async (command, args, options) => {
      if (command === 'pdfinfo') return { stdout: 'Pages: 2\n' };
      tempDirectory = dirname(args.at(-1)!);
      expect(options).toEqual({ signal: controller.signal, timeout: 12_345 });
      await writeFile(`${args.at(-1)!}-1.png`, new Uint8Array([1]));
      await writeFile(`${args.at(-1)!}-2.png`, new Uint8Array([2]));
    },
  });

  const first = await pages.next();
  expect(first.value).toEqual({
    pageNumber: 1,
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    filename: 'page-1.png',
    width: null,
    height: null,
  });
  expect(first.value).not.toHaveProperty('dataUrl');
  await expect(access(tempDirectory)).resolves.toBeUndefined();

  await pages.return(undefined);
  await expect(access(tempDirectory)).rejects.toThrow();
});

test('cleans up the spool when streaming iteration throws during page processing', async () => {
  let tempDirectory = '';

  await expect((async () => {
    for await (const page of streamPdfPages(new Uint8Array([37, 80, 68, 70]), {
      commandRunner: async (command, args) => {
        if (command === 'pdfinfo') return { stdout: 'Pages: 1\n' };
        tempDirectory = dirname(args.at(-1)!);
        await writeFile(`${args.at(-1)!}-1.png`, new Uint8Array([1]));
      },
    })) {
      expect(page.pageNumber).toBe(1);
      throw new Error('consumer failed');
    }
  })()).rejects.toThrow('consumer failed');

  await expect(access(tempDirectory)).rejects.toThrow();
});

test('extracts PNG raster dimensions into streamed page metadata', async () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer);
  view.setUint32(16, 3_340);
  view.setUint32(20, 2_189);

  const pages = streamPdfPages(new Uint8Array([37, 80, 68, 70]), {
    commandRunner: async (command, args) => {
      if (command === 'pdfinfo') return { stdout: 'Pages: 1\n' };
      await writeFile(`${args.at(-1)!}-1.png`, png);
    },
  });

  await expect(pages.next()).resolves.toMatchObject({
    value: {
      pageNumber: 1,
      width: 3_340,
      height: 2_189,
    },
  });
  await pages.return(undefined);
});

test('renders a large PDF in bounded page ranges and reports live rasterization progress', async () => {
  const ranges: Array<[number, number]> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const pages = await renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    dpi: 300,
    pagesPerBatch: 10,
    onEvent: (type, payload) => {
      events.push({ type, payload });
    },
    commandRunner: async (command, args) => {
      if (command === 'pdfinfo') return { stdout: 'Title: fixture\nPages:          23\n' };
      const start = Number(args[args.indexOf('-f') + 1]);
      const end = Number(args[args.indexOf('-l') + 1]);
      ranges.push([start, end]);
      const outputPrefix = args.at(-1)!;
      for (let pageNumber = end; pageNumber >= start; pageNumber -= 1) {
        await writeFile(`${outputPrefix}-${pageNumber}.png`, new Uint8Array([pageNumber]));
      }
    },
  });

  expect(ranges).toEqual([[1, 10], [11, 20], [21, 23]]);
  expect(pages.map((page) => page.pageNumber)).toEqual(
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
  expect(events[0]).toEqual({
    type: 'DOCUMENT_RASTERIZATION_STARTED',
    payload: {
      pageCount: 23,
      pagesPerBatch: 10,
      batchCount: 3,
      dpi: 300,
      format: 'png',
    },
  });
  expect(events.filter((event) => event.type === 'DOCUMENT_RASTER_BATCH_COMPLETED'))
    .toHaveLength(3);
  expect(events.filter((event) => event.type === 'DOCUMENT_PAGE_RENDERED'))
    .toHaveLength(23);
  expect(events.at(-1)).toMatchObject({
    type: 'DOCUMENT_RASTERIZATION_COMPLETED',
    payload: { pageCount: 23, batchCount: 3 },
  });
});

test('identifies the exact page range when a raster batch times out', async () => {
  await expect(renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    pagesPerBatch: 10,
    timeoutMs: 120_000,
    commandRunner: async (command) => {
      if (command === 'pdfinfo') return { stdout: 'Pages: 173\n' };
      throw Object.assign(new Error('Command failed: pdftoppm'), {
        killed: true,
        signal: 'SIGTERM',
      });
    },
  })).rejects.toThrow(
    'DOCUMENT_RASTERIZATION_TIMEOUT: page range 1-10 exceeded 120000ms',
  );
});

test('rejects a raster batch with a stable error when any expected page is missing', async () => {
  await expect(renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    commandRunner: async (command, args) => {
      if (command === 'pdfinfo') return { stdout: 'Pages: 3\n' };
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.png`, new Uint8Array([1]));
      await writeFile(`${outputPrefix}-3.png`, new Uint8Array([3]));
    },
  })).rejects.toThrow(
    'DOCUMENT_RASTERIZATION_MISSING_PAGES: page range 1-3 missing pages 2',
  );
});
