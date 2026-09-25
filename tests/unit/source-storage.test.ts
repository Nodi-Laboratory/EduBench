import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { storeSourceFile } from '@/server/files/storage';

const roots:string[] = [];
const previousRoot = process.env.STORAGE_ROOT;

afterEach(async () => {
  if (previousRoot == null) delete process.env.STORAGE_ROOT;
  else process.env.STORAGE_ROOT = previousRoot;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive:true, force:true })));
});

test('stores identical source bytes once at a content-addressed path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'edubench-storage-'));
  roots.push(root);
  process.env.STORAGE_ROOT = root;
  const bytes = new TextEncoder().encode('%PDF-1.7\nsame textbook');
  const digest = createHash('sha256').update(bytes).digest('hex');

  const [first, second] = await Promise.all([
    storeSourceFile(digest, bytes),
    storeSourceFile(digest, bytes),
  ]);

  expect(second).toBe(first);
  expect(first).toContain(path.join('sources', 'blobs', digest.slice(0, 2)));
  expect(path.basename(first)).toBe(`${digest}.pdf`);
  expect(new Uint8Array(await readFile(first))).toEqual(bytes);
});

test('rejects a caller hash that does not match the source bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'edubench-storage-'));
  roots.push(root);
  process.env.STORAGE_ROOT = root;

  await expect(storeSourceFile(
    '0'.repeat(64),
    new TextEncoder().encode('%PDF-1.7\ntextbook'),
  )).rejects.toThrow('SOURCE_HASH_MISMATCH');
});

test('rejects and preserves a corrupt preexisting content-addressed target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'edubench-storage-'));
  roots.push(root);
  process.env.STORAGE_ROOT = root;
  const bytes = new TextEncoder().encode('%PDF-1.7\nvalid textbook');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(
    root,
    'sources',
    'blobs',
    digest.slice(0, 2),
  );
  const target = path.join(directory, `${digest}.pdf`);
  const corruptBytes = new TextEncoder().encode('%PDF-1.7\ncorrupt');
  await mkdir(directory, { recursive:true });
  await writeFile(target, corruptBytes);

  await expect(storeSourceFile(digest, bytes))
    .rejects.toThrow('SOURCE_BLOB_CORRUPT');

  expect(new Uint8Array(await readFile(target))).toEqual(corruptBytes);
  expect(await readdir(directory)).toEqual([`${digest}.pdf`]);
});
