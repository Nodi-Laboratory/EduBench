import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function storageRoot(): string {
  return process.env.STORAGE_ROOT
    ? path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_ROOT)
    : path.join(process.cwd(), 'storage');
}

async function sha256File(filePath:string):Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function storeSourceFile(
  expectedSha256: string,
  bytes: Uint8Array,
): Promise<string> {
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error('SOURCE_HASH_MISMATCH: 업로드 원본의 SHA-256이 일치하지 않습니다.');
  }
  const directory = path.join(
    storageRoot(),
    'sources',
    'blobs',
    actualSha256.slice(0, 2),
  );
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${actualSha256}.pdf`);
  const temporary = path.join(directory, `.upload-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes);
  try {
    await link(temporary, target);
  } catch (error) {
    if (
      !error
      || typeof error !== 'object'
      || !('code' in error)
      || error.code !== 'EEXIST'
    ) {
      throw error;
    }
    let storedSha256:string;
    try {
      storedSha256 = await sha256File(target);
    } catch (cause) {
      throw new Error(
        'SOURCE_BLOB_CORRUPT: 기존 원본 블록의 무결성을 확인할 수 없습니다.',
        { cause },
      );
    }
    if (storedSha256 !== actualSha256) {
      throw new Error(
        'SOURCE_BLOB_CORRUPT: 기존 원본 블록의 SHA-256이 경로와 일치하지 않습니다.',
      );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}
