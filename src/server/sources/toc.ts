import type { PoolClient } from 'pg';
import { extractTableOfContents, type TocEntry } from '@/domain/toc';
import {
  alignTocEntriesToChunks,
  carryForwardTocChunkHeadings,
  type TocAlignment,
  type TocAlignmentChunk,
} from '@/domain/toc-alignment';
import { db } from '@/server/db/pool';

type PersistedAlignmentChunk = TocAlignmentChunk & { id: string };
type StoredAlignmentChunkRow = {
  id: string;
  ordinal: number;
  page_start: number | null;
  page_end: number | null;
  chapter: string | null;
  unit: string | null;
};
type StoredTocEntryRow = {
  id: string;
  ordinal: number;
  title: string;
  level: number;
  printed_page: number | null;
  parent_id: string | null;
};

export async function replaceSourceTocEntries(
  client: PoolClient,
  sourceId: string,
  sourceRevisionId: string,
  entries: TocEntry[],
  chunks: PersistedAlignmentChunk[],
): Promise<TocAlignment> {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`source-toc:${sourceRevisionId}`]);
  const storedEntries = await client.query<StoredTocEntryRow>(
    `select id, ordinal, title, level, printed_page, parent_id
       from source_toc_entries
      where source_revision_id = $1
      order by ordinal`,
    [sourceRevisionId],
  );
  const alignmentEntries: TocEntry[] = storedEntries.rowCount
    ? storedEntries.rows.map((entry) => ({
      ordinal: entry.ordinal,
      title: entry.title,
      level: entry.level,
      printedPage: entry.printed_page,
    }))
    : entries;
  const alignment = alignTocEntriesToChunks(alignmentEntries, chunks);
  await client.query(
    `delete from source_chunk_toc_entries mapping
      where mapping.source_revision_id = $1`,
    [sourceRevisionId],
  );
  await client.query(
    `update source_toc_entries
        set mapping_status = 'UNMAPPED', mapping_confidence = null
      where source_revision_id = $1`,
    [sourceRevisionId],
  );
  const entryIds = new Map(storedEntries.rows.map((entry) => [entry.ordinal, entry.id]));
  if (storedEntries.rowCount) {
    for (const entry of alignment.entries) {
      await client.query(
        `update source_toc_entries
            set mapping_status = $2, mapping_confidence = $3
          where id = $1 and source_revision_id = $4`,
        [entryIds.get(entry.ordinal), entry.mappingStatus, entry.mappingConfidence, sourceRevisionId],
      );
    }
  } else {
    for (const entry of alignment.entries) {
      const inserted = await client.query<{ id: string }>(
        `insert into source_toc_entries(
           source_file_id, source_revision_id, parent_id, ordinal, title, level, printed_page,
           mapping_status, mapping_confidence
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id`,
        [
          sourceId,
          sourceRevisionId,
          entry.parentOrdinal === null ? null : entryIds.get(entry.parentOrdinal) ?? null,
          entry.ordinal,
          entry.title,
          entry.level,
          entry.printedPage,
          entry.mappingStatus,
          entry.mappingConfidence,
        ],
      );
      entryIds.set(entry.ordinal, inserted.rows[0]!.id);
    }
  }
  for (const entry of alignment.entries) {
    if (entry.parentOrdinal === null) continue;
    const entryId = entryIds.get(entry.ordinal);
    const parentId = entryIds.get(entry.parentOrdinal);
    if (!entryId || !parentId) continue;
    await client.query(
      `update source_toc_entries
          set parent_id = $2
        where id = $1 and source_revision_id = $3 and parent_id is null`,
      [entryId, parentId, sourceRevisionId],
    );
  }
  const chunkIds = new Map(chunks.map((chunk) => [chunk.ordinal, chunk.id]));
  for (const mapping of alignment.mappings) {
    const chunkId = chunkIds.get(mapping.chunkOrdinal);
    const tocEntryId = entryIds.get(mapping.tocOrdinal);
    if (!chunkId || !tocEntryId) continue;
    await client.query(
      `insert into source_chunk_toc_entries(
         source_chunk_id, source_toc_entry_id, source_revision_id, relation, confidence
       ) values ($1,$2,$3,$4,$5)`,
      [chunkId, tocEntryId, sourceRevisionId, mapping.relation, mapping.confidence],
    );
  }
  await client.query(
    `update source_revisions
        set toc_alignment_attempted_at = coalesce(toc_alignment_attempted_at, now())
      where id = $1`,
    [sourceRevisionId],
  );
  return alignment;
}

export async function backfillMissingSourceTocEntries(sourceIds: string[]) {
  if (!sourceIds.length) return;
  const revisions = await db.query<{ id: string; source_file_id: string; raw_html: string | null }>(
    `with latest as (
       select distinct on (revision.source_file_id)
              revision.id, revision.source_file_id, revision.raw_html,
              revision.toc_alignment_attempted_at
         from source_revisions revision
        where revision.source_file_id = any($1::uuid[])
        order by revision.source_file_id, revision.revision desc
     )
     select r.id, r.source_file_id, r.raw_html
       from latest r
      where r.toc_alignment_attempted_at is null`,
    [sourceIds],
  );
  for (const revision of revisions.rows) {
    const entries = extractTableOfContents(revision.raw_html ?? '');
    const chunks = await db.query<StoredAlignmentChunkRow>(
      `select id, ordinal, page_start, page_end, chapter, unit
         from source_chunks
        where source_revision_id = $1
        order by ordinal`,
      [revision.id],
    );
    const client = await db.connect();
    try {
      await client.query('begin');
      const persistedChunks = carryForwardTocChunkHeadings(chunks.rows.map((chunk) => ({
        id: chunk.id,
        ordinal: chunk.ordinal,
        pageStart: chunk.page_start,
        pageEnd: chunk.page_end,
        chapter: chunk.chapter,
        unit: chunk.unit,
      })));
      await replaceSourceTocEntries(
        client,
        revision.source_file_id,
        revision.id,
        entries,
        persistedChunks,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
}
