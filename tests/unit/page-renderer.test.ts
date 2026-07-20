import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { renderPdfPages } from '@/server/documents/page-renderer';

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
