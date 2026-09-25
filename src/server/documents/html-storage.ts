import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export function sourceHtmlContentHash(html:string):string {
  return createHash('sha256').update(html).digest('hex');
}

export async function ensureSourceHtmlBlob(
  client:Queryable,
  html:string,
):Promise<string> {
  const contentHash = sourceHtmlContentHash(html);
  const byteSize = Buffer.byteLength(html, 'utf8');
  const inserted = await client.query<{ id:string }>(
    `insert into source_html_blobs(content_hash,html,byte_size)
     values($1,$2,$3)
     on conflict (content_hash) do nothing
     returning id`,
    [contentHash, html, byteSize],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  // This must be a separate statement. Under READ COMMITTED, an INSERT that
  // waited for a concurrent conflicting commit cannot see that row through
  // the INSERT statement's original snapshot, while the next statement can.
  const existing = await client.query<{ id:string }>(
    `select id
       from source_html_blobs
      where content_hash=$1
        and html=$2
        and byte_size=$3`,
    [contentHash, html, byteSize],
  );
  if (!existing.rows[0]) {
    throw new Error(
      'SOURCE_HTML_BLOB_INTEGRITY_ERROR: 정규 HTML 블록을 확인할 수 없습니다.',
    );
  }
  return existing.rows[0].id;
}

export async function ensureSourceHtmlBlobs(
  client:Queryable,
  htmlValues:readonly string[],
):Promise<Map<string, string>> {
  const htmlByHash = new Map<string, string>();
  for (const html of htmlValues) {
    const contentHash = sourceHtmlContentHash(html);
    const existing = htmlByHash.get(contentHash);
    if (existing !== undefined && existing !== html) {
      throw new Error(
        'SOURCE_HTML_BLOB_HASH_COLLISION: 서로 다른 HTML이 같은 해시를 가집니다.',
      );
    }
    htmlByHash.set(contentHash, html);
  }

  const idsByHash = new Map<string, string>();
  for (const [contentHash, html] of [...htmlByHash].sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
  )) {
    idsByHash.set(contentHash, await ensureSourceHtmlBlob(client, html));
  }
  return idsByHash;
}
