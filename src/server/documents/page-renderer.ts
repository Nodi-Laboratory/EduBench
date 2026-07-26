import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type RenderedPage = {
  pageNumber: number;
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
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
  format?:'png' | 'jpeg';
  dpi?:number;
  jpegQuality?:number;
};

export async function* streamPdfPages(
  bytes: Uint8Array,
  options: RenderPdfPagesOptions = {},
): AsyncGenerator<StreamedPage, void, undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'edubench-pdf-'));
  const inputPath = join(directory, 'source.pdf');
  const outputPrefix = join(directory, 'page');
  const commandRunner = options.commandRunner ?? ((command, args, commandOptions) => execFile(command, args, commandOptions));
  const format = options.format ?? 'png';
  const dpi = Number.isInteger(options.dpi) && options.dpi! >= 72
    && options.dpi! <= 1_200
    ? options.dpi!
    : 150;
  const jpegQuality = Number.isInteger(options.jpegQuality)
    && options.jpegQuality! >= 1
    && options.jpegQuality! <= 100
    ? options.jpegQuality!
    : 90;
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const rasterArgs = format === 'jpeg'
    ? ['-jpeg', '-jpegopt', `quality=${jpegQuality}`]
    : ['-png'];

  try {
    await writeFile(inputPath, bytes);
    await commandRunner(
      process.env.PDFTOPPM_PATH || 'pdftoppm',
      [...rasterArgs, '-r', String(dpi), inputPath, outputPrefix],
      { signal: options.signal, timeout: options.timeoutMs },
    );

    const files = (await readdir(directory))
      .map((filename) => ({
        filename,
        match:new RegExp(`^page-(\\d+)\\.${extension}$`).exec(filename),
      }))
      .filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

    for (const { filename, match } of files) {
      const pageBytes = new Uint8Array(await readFile(join(directory, filename)));
      yield {
        pageNumber: Number(match[1]),
        bytes: pageBytes,
        mimeType,
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
      dataUrl: `data:${page.mimeType};base64,${Buffer.from(page.bytes).toString('base64')}`,
    });
  }

  return pages;
}
