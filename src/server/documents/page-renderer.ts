import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type RenderedPage = {
  pageNumber: number;
  bytes: Uint8Array;
  mimeType: 'image/png';
  filename: string;
  dataUrl: string;
  width?: number | null;
  height?: number | null;
};

export type StreamedPage = Omit<RenderedPage, 'dataUrl'> & {
  width: number | null;
  height: number | null;
};

type CommandOptions = {
  signal?: AbortSignal;
  timeout?: number;
};

type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<unknown>;

export type RenderPdfPagesOptions = {
  commandRunner?: CommandRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function* streamPdfPages(
  bytes: Uint8Array,
  options: RenderPdfPagesOptions = {},
): AsyncGenerator<StreamedPage, void, undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'edubench-pdf-'));
  const inputPath = join(directory, 'source.pdf');
  const outputPrefix = join(directory, 'page');
  const commandRunner = options.commandRunner ?? ((command, args, commandOptions) => execFile(command, args, commandOptions));

  try {
    await writeFile(inputPath, bytes);
    await commandRunner(
      process.env.PDFTOPPM_PATH || 'pdftoppm',
      ['-png', '-r', '150', inputPath, outputPrefix],
      { signal: options.signal, timeout: options.timeoutMs },
    );

    const files = (await readdir(directory))
      .map((filename) => ({ filename, match: /^page-(\d+)\.png$/.exec(filename) }))
      .filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

    for (const { filename, match } of files) {
      const pageBytes = new Uint8Array(await readFile(join(directory, filename)));
      yield {
        pageNumber: Number(match[1]),
        bytes: pageBytes,
        mimeType: 'image/png' as const,
        filename,
        width: null,
        height: null,
      };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function renderPdfPages(bytes: Uint8Array, options: RenderPdfPagesOptions = {}): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];

  for await (const page of streamPdfPages(bytes, options)) {
    pages.push({
      pageNumber: page.pageNumber,
      bytes: page.bytes,
      mimeType: page.mimeType,
      filename: page.filename,
      dataUrl: `data:image/png;base64,${Buffer.from(page.bytes).toString('base64')}`,
    });
  }

  return pages;
}
