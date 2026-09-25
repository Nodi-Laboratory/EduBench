import { createHash } from 'node:crypto';
import { readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@/server/db/pool';
import { storageRoot, storeSourceFile } from '@/server/files/storage';

type SourceStorageRow = {
  id:string;
  sha256:string;
  storage_path:string;
};

function insideSourceStorage(candidate:string):boolean {
  const root = path.resolve(storageRoot(), 'sources');
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

export async function deduplicateSourceStorage() {
  const rows = await db.query<SourceStorageRow>(
    `select id,sha256,storage_path
       from source_files
      order by sha256,created_at,id`,
  );
  const canonicalByHash = new Map<string, string>();
  const oldPaths = new Set<string>();
  let updatedRows = 0;

  for (const row of rows.rows) {
    const bytes = new Uint8Array(await readFile(row.storage_path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== row.sha256) {
      throw new Error(
        `SOURCE_HASH_MISMATCH: ${row.id}의 저장 원본 해시가 DB와 다릅니다.`,
      );
    }
    const canonical = canonicalByHash.get(row.sha256)
      ?? await storeSourceFile(row.sha256, bytes);
    canonicalByHash.set(row.sha256, canonical);
    if (path.resolve(row.storage_path) === path.resolve(canonical)) continue;
    oldPaths.add(row.storage_path);
    const updated = await db.query(
      `update source_files
          set storage_path=$2,updated_at=now()
        where id=$1 and storage_path=$3`,
      [row.id, canonical, row.storage_path],
    );
    updatedRows += updated.rowCount ?? 0;
  }

  let removedFiles = 0;
  for (const oldPath of oldPaths) {
    const references = await db.query<{ count:string }>(
      'select count(*) from source_files where storage_path=$1',
      [oldPath],
    );
    if (Number(references.rows[0]?.count ?? 0) > 0) continue;
    if (!insideSourceStorage(oldPath)) {
      throw new Error(`SOURCE_STORAGE_PATH_OUTSIDE_ROOT: ${oldPath}`);
    }
    await unlink(oldPath);
    await rmdir(path.dirname(oldPath)).catch(() => undefined);
    removedFiles += 1;
  }

  return {
    sourceRows:rows.rowCount,
    canonicalFiles:canonicalByHash.size,
    updatedRows,
    removedFiles,
  };
}

const isEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  deduplicateSourceStorage()
    .then(async (result) => {
      console.log(JSON.stringify(result));
      await db.end();
    })
    .catch(async (error:unknown) => {
      console.error(error);
      await db.end();
      process.exitCode = 1;
    });
}
