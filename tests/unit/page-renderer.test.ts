import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { renderPdfPages, streamPdfPages } from '@/server/documents/page-renderer';

test('renders PDF pages as ordered 150-DPI PNG data URLs', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const pages = await renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-10.png`, new Uint8Array([10]));
      await writeFile(`${outputPrefix}-2.png`, new Uint8Array([2]));
      await writeFile(`${outputPrefix}-1.png`, new Uint8Array([1]));
    },
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: 'pdftoppm' });
  expect(calls[0]!.args.slice(0, 3)).toEqual(['-png', '-r', '150']);
  expect(pages).toEqual([
    { pageNumber: 1, bytes: new Uint8Array([1]), mimeType: 'image/png', filename: 'page-1.png', dataUrl: 'data:image/png;base64,AQ==' },
    { pageNumber: 2, bytes: new Uint8Array([2]), mimeType: 'image/png', filename: 'page-2.png', dataUrl: 'data:image/png;base64,Ag==' },
    { pageNumber: 10, bytes: new Uint8Array([10]), mimeType: 'image/png', filename: 'page-10.png', dataUrl: 'data:image/png;base64,Cg==' },
  ]);
  await expect(access(dirname(calls[0]!.args.at(-1)!))).rejects.toThrow();
});

test('applies pinned JPEG DPI and quality rasterization settings', async () => {
  const calls: string[][] = [];
  const pages = await renderPdfPages(new Uint8Array([37, 80, 68, 70]), {
    format:'jpeg',
    dpi:300,
    jpegQuality:92,
    commandRunner:async (_command, args) => {
      calls.push(args);
      const outputPrefix = args.at(-1)!;
      await writeFile(`${outputPrefix}-1.jpg`, new Uint8Array([0xff, 0xd8]));
    },
  });

  expect(calls[0]).toEqual([
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
    commandRunner: async (_command, args) => {
      tempDirectory = dirname(args.at(-1)!);
      throw new Error('pdftoppm failed');
    },
  })).rejects.toThrow('pdftoppm failed');

  await expect(access(tempDirectory)).rejects.toThrow();
});

test('streams one spooled PNG at a time without persistent data URLs and cleans up on early return', async () => {
  let tempDirectory = '';
  const controller = new AbortController();
  const pages = streamPdfPages(new Uint8Array([37, 80, 68, 70]), {
    signal: controller.signal,
    timeoutMs: 12_345,
    commandRunner: async (_command, args, options) => {
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
      commandRunner: async (_command, args) => {
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
