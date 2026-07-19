import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function storageRoot(): string {
  return process.env.STORAGE_ROOT
    ? path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_ROOT)
    : path.join(process.cwd(), 'storage');
}

export async function storeSourceFile(sourceId: string, bytes: Uint8Array): Promise<string> {
  const directory = path.join(storageRoot(), 'sources', sourceId);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'original.pdf');
  const temporary = path.join(directory, `.upload-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return target;
}
