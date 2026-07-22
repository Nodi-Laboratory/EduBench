import type { PoolClient } from 'pg';
import { extractTableOfContents, type TocEntry } from '@/domain/toc';
import { db } from '@/server/db/pool';

export async function replaceSourceTocEntries(client: PoolClient, sourceId: string, entries: TocEntry[]) {
  await client.query('delete from source_toc_entries where source_file_id = $1', [sourceId]);
  for (const entry of entries) await client.query(
    `insert into source_toc_entries(source_file_id, ordinal, title, level, printed_page)
     values ($1,$2,$3,$4,$5)`,
    [sourceId, entry.ordinal, entry.title, entry.level, entry.printedPage],
  );
}

export async function backfillMissingSourceTocEntries(sourceIds: string[]) {
  if (!sourceIds.length) return;
  const revisions = await db.query<{ source_file_id: string; raw_html: string }>(
    `select distinct on (r.source_file_id) r.source_file_id, r.raw_html
       from source_revisions r
      where r.source_file_id = any($1::uuid[])
        and not exists (select 1 from source_toc_entries t where t.source_file_id = r.source_file_id)
      order by r.source_file_id, r.revision desc`,
    [sourceIds],
  );
  for (const revision of revisions.rows) {
    const entries = extractTableOfContents(revision.raw_html);
    if (!entries.length) continue;
    const client = await db.connect();
    try {
      await client.query('begin');
      await replaceSourceTocEntries(client, revision.source_file_id, entries);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}
