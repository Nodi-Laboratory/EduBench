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
  format?: 'png' | 'jpeg';
  dpi?: number;
  jpegQuality?: number;
  pagesPerBatch?: number;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => Promise<void> | void;
};

function commandStdout(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || !('stdout' in result)) return '';
  const stdout = result.stdout;
  if (typeof stdout === 'string') return stdout;
  if (stdout instanceof Uint8Array) return Buffer.from(stdout).toString('utf8');
  return '';
}

function pageCountFromPdfInfo(stdout: string): number {
  const match = /^\s*Pages:\s+(\d+)\s*$/im.exec(stdout);
  const pageCount = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error('DOCUMENT_PAGE_COUNT_INVALID: pdfinfo did not return a valid page count');
  }
  return pageCount;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wasKilled(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'killed' in error && error.killed);
}

function pngDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
    || bytes[4] !== 0x0d
    || bytes[5] !== 0x0a
    || bytes[6] !== 0x1a
    || bytes[7] !== 0x0a
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function rasterDimensions(
  bytes: Uint8Array,
  mimeType: StreamedPage['mimeType'],
) {
  return mimeType === 'image/png'
    ? pngDimensions(bytes)
    : jpegDimensions(bytes);
}

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
  const pagesPerBatch = Number.isInteger(options.pagesPerBatch)
    && options.pagesPerBatch! >= 1
    && options.pagesPerBatch! <= 100
    ? options.pagesPerBatch!
    : 10;
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const rasterArgs = format === 'jpeg'
    ? ['-jpeg', '-jpegopt', `quality=${jpegQuality}`]
    : ['-png'];

  try {
    await writeFile(inputPath, bytes);
    options.signal?.throwIfAborted();
    let pageCount: number;
    try {
      const result = await commandRunner(
        process.env.PDFINFO_PATH || 'pdfinfo',
        [inputPath],
        { signal: options.signal, timeout: options.timeoutMs },
      );
      pageCount = pageCountFromPdfInfo(commandStdout(result));
    } catch (error) {
      options.signal?.throwIfAborted();
      if (wasKilled(error) && options.timeoutMs) {
        throw new Error(
          `DOCUMENT_PAGE_COUNT_TIMEOUT: pdfinfo exceeded ${options.timeoutMs}ms`,
          { cause: error },
        );
      }
      if (error instanceof Error && error.message.startsWith('DOCUMENT_PAGE_COUNT_')) throw error;
      throw new Error(`DOCUMENT_PAGE_COUNT_FAILED: ${errorMessage(error)}`, { cause: error });
    }

    const batchCount = Math.ceil(pageCount / pagesPerBatch);
    await options.onEvent?.('DOCUMENT_RASTERIZATION_STARTED', {
      pageCount,
      pagesPerBatch,
      batchCount,
      dpi,
      format,
    });

    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      options.signal?.throwIfAborted();
      const pageStart = batchIndex * pagesPerBatch + 1;
      const pageEnd = Math.min(pageCount, pageStart + pagesPerBatch - 1);
      const startedAt = Date.now();
      await options.onEvent?.('DOCUMENT_RASTER_BATCH_STARTED', {
        batchIndex: batchIndex + 1,
        batchCount,
        pageStart,
        pageEnd,
      });
      try {
        await commandRunner(
          process.env.PDFTOPPM_PATH || 'pdftoppm',
          [
            '-f',
            String(pageStart),
            '-l',
            String(pageEnd),
            ...rasterArgs,
            '-r',
            String(dpi),
            inputPath,
            outputPrefix,
          ],
          { signal: options.signal, timeout: options.timeoutMs },
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        if (wasKilled(error) && options.timeoutMs) {
          throw new Error(
            `DOCUMENT_RASTERIZATION_TIMEOUT: page range ${pageStart}-${pageEnd} exceeded ${options.timeoutMs}ms`,
            { cause: error },
          );
        }
        throw new Error(
          `DOCUMENT_RASTERIZATION_FAILED: page range ${pageStart}-${pageEnd}: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      const rasterFiles = (await readdir(directory))
        .map((filename) => ({
          filename,
          match: new RegExp(`^page-(\\d+)\\.${extension}$`).exec(filename),
        }))
        .filter((entry): entry is { filename: string; match: RegExpExecArray } =>
          entry.match !== null);
      const actualPageNumbers = new Set(
        rasterFiles.map((entry) => Number(entry.match[1])),
      );
      const missingPageNumbers = Array.from(
        { length: pageEnd - pageStart + 1 },
        (_, index) => pageStart + index,
      ).filter((pageNumber) => !actualPageNumbers.has(pageNumber));
      if (missingPageNumbers.length) {
        throw new Error(
          `DOCUMENT_RASTERIZATION_MISSING_PAGES: page range ${pageStart}-${pageEnd} missing pages ${missingPageNumbers.join(',')}`,
        );
      }
      const unexpectedPageNumbers = [...actualPageNumbers]
        .filter((pageNumber) => pageNumber < pageStart || pageNumber > pageEnd)
        .sort((left, right) => left - right);
      if (unexpectedPageNumbers.length) {
        throw new Error(
          `DOCUMENT_RASTERIZATION_UNEXPECTED_PAGES: page range ${pageStart}-${pageEnd} produced pages ${unexpectedPageNumbers.join(',')}`,
        );
      }
      const files = rasterFiles
        .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));

      let renderedBytes = 0;
      for (const { filename, match } of files) {
        const filePath = join(directory, filename);
        const pageBytes = new Uint8Array(await readFile(filePath));
        await rm(filePath, { force: true });
        const pageNumber = Number(match[1]);
        const dimensions = rasterDimensions(pageBytes, mimeType);
        renderedBytes += pageBytes.byteLength;
        await options.onEvent?.('DOCUMENT_PAGE_RENDERED', {
          pageNumber,
          batchIndex: batchIndex + 1,
          batchCount,
          imageBytes: pageBytes.byteLength,
          mimeType,
          width:dimensions?.width ?? null,
          height:dimensions?.height ?? null,
        });
        yield {
          pageNumber,
          bytes: pageBytes,
          mimeType,
          filename,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
        };
      }
      await options.onEvent?.('DOCUMENT_RASTER_BATCH_COMPLETED', {
        batchIndex: batchIndex + 1,
        batchCount,
        pageStart,
        pageEnd,
        renderedPages: files.length,
        renderedBytes,
        durationMs: Date.now() - startedAt,
      });
    }
    await options.onEvent?.('DOCUMENT_RASTERIZATION_COMPLETED', {
      pageCount,
      batchCount,
    });
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
      ...(page.width == null ? {} : { width:page.width }),
      ...(page.height == null ? {} : { height:page.height }),
    });
  }

  return pages;
}
