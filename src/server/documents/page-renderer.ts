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
};

type CommandRunner = (command: string, args: string[]) => Promise<unknown>;

export type RenderPdfPagesOptions = {
  commandRunner?: CommandRunner;
};

export async function renderPdfPages(bytes: Uint8Array, options: RenderPdfPagesOptions = {}): Promise<RenderedPage[]> {
  const directory = await mkdtemp(join(tmpdir(), 'edubench-pdf-'));
  const inputPath = join(directory, 'source.pdf');
  const outputPrefix = join(directory, 'page');
  const commandRunner = options.commandRunner ?? ((command, args) => execFile(command, args));

  try {
    await writeFile(inputPath, bytes);
    await commandRunner(process.env.PDFTOPPM_PATH || 'pdftoppm', ['-png', '-r', '150', inputPath, outputPrefix]);

    const files = (await readdir(directory))
      .map((filename) => ({ filename, match: /^page-(\d+)\.png$/.exec(filename) }))
      .filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

    return Promise.all(files.map(async ({ filename, match }) => {
      const pageBytes = new Uint8Array(await readFile(join(directory, filename)));
      return {
        pageNumber: Number(match[1]),
        bytes: pageBytes,
        mimeType: 'image/png' as const,
        filename,
        dataUrl: `data:image/png;base64,${Buffer.from(pageBytes).toString('base64')}`,
      };
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
