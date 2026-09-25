import type { PoolClient } from 'pg';
import { extractTableOfContents, type TocEntry } from '@/domain/toc';
import {
  alignTocEntriesToChunks,
  carryForwardTocChunkHeadings,
  extractPrintedPageLocations,
  type TocAlignment,
  type TocAlignmentChunk,
} from '@/domain/toc-alignment';
import { db } from '@/server/db/pool';

export const TOC_ALIGNMENT_VERSION = 2;

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
type StoredPageArtifactRow = {
  page_number: number;
  raw_response: unknown;
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
  const pageArtifacts = await client.query<StoredPageArtifactRow>(
    `select page_number, raw_response
       from source_revision_page_artifacts
      where source_revision_id = $1
      order by page_number`,
    [sourceRevisionId],
  );
  const printedPageLocations = extractPrintedPageLocations(pageArtifacts.rows.map((page) => ({
    documentPage: page.page_number,
    rawResponse: page.raw_response,
  })));
  const alignment = alignTocEntriesToChunks(alignmentEntries, chunks, printedPageLocations);
  await client.query(
    `update generation_batches batch
        set source_scope = jsonb_set(
              batch.source_scope,
              '{sourceRevisionIds}',
              coalesce((
                select jsonb_agg(latest.id::text order by latest.source_file_id)
                  from (
                    select distinct on (revision.source_file_id)
                           revision.id, revision.source_file_id
                      from source_revisions revision
                     where revision.source_file_id in (
                             select value::uuid
                               from jsonb_array_elements_text(
                                 coalesce(batch.source_scope->'sourceFileIds', '[]'::jsonb)
                               ) selected_source(value)
                           )
                     order by revision.source_file_id, revision.revision desc
                  ) latest
              ), '[]'::jsonb),
              true
            ),
            updated_at = now()
      where not (batch.source_scope ? 'resolvedChunkIds')
        and coalesce(batch.source_scope->'sourceRevisionIds', '[]'::jsonb) = '[]'::jsonb
        and jsonb_array_length(coalesce(batch.source_scope->'tocEntryIds', '[]'::jsonb)) > 0
        and coalesce(batch.source_scope->'sourceFileIds', '[]'::jsonb) ? $2::text
        and exists (
              select 1
                from source_toc_entries entry
               where entry.source_revision_id = $1
                 and coalesce(batch.source_scope->'tocEntryIds', '[]'::jsonb) ? entry.id::text
            )`,
    [sourceRevisionId, sourceId],
  );
  await client.query(
    `update generation_batches batch
        set source_scope = jsonb_set(
              batch.source_scope,
              '{resolvedChunkIds}',
              coalesce((
                select case
                         when count(distinct selected.value)
                              = count(distinct mapping.source_toc_entry_id::text)
                         then to_jsonb(coalesce(
                                array_agg(
                                  distinct mapping.source_chunk_id::text
                                  order by mapping.source_chunk_id::text
                                ) filter (where mapping.source_chunk_id is not null),
                                array[]::text[]
                              ))
                         else '[]'::jsonb
                       end
                  from jsonb_array_elements_text(
                         coalesce(batch.source_scope->'tocEntryIds', '[]'::jsonb)
                       ) selected(value)
                  left join source_chunk_toc_entries mapping
                    on mapping.source_toc_entry_id=selected.value::uuid
                   and mapping.source_revision_id in (
                         select value::uuid
                           from jsonb_array_elements_text(
                             coalesce(batch.source_scope->'sourceRevisionIds', '[]'::jsonb)
                           ) revision(value)
                       )
              ), '[]'::jsonb),
              true
            ),
            updated_at = now()
      where not (batch.source_scope ? 'resolvedChunkIds')
        and jsonb_array_length(coalesce(batch.source_scope->'tocEntryIds', '[]'::jsonb)) > 0
        and coalesce(batch.source_scope->'sourceRevisionIds', '[]'::jsonb) ? $1::text`,
    [sourceRevisionId],
  );
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
  const persistedMappings = new Map<string, {
    chunkId: string;
    tocEntryId: string;
    relation: 'DIRECT' | 'ANCESTOR';
    confidence: number;
  }>();
  for (const mapping of alignment.mappings) {
    const chunkId = chunkIds.get(mapping.chunkOrdinal);
    const tocEntryId = entryIds.get(mapping.tocOrdinal);
    if (!chunkId || !tocEntryId) continue;
    const key = `${chunkId}:${tocEntryId}`;
    const existing = persistedMappings.get(key);
    if (!existing
      || (existing.relation === 'ANCESTOR' && mapping.relation === 'DIRECT')
      || (existing.relation === mapping.relation && mapping.confidence > existing.confidence)) {
      persistedMappings.set(key, {
        chunkId,
        tocEntryId,
        relation: mapping.relation,
        confidence: mapping.confidence,
      });
    }
  }
  if (persistedMappings.size) {
    const rows = [...persistedMappings.values()];
    await client.query(
      `insert into source_chunk_toc_entries(
         source_chunk_id, source_toc_entry_id, source_revision_id, relation, confidence
       )
       select mapping.source_chunk_id,
              mapping.source_toc_entry_id,
              $3::uuid,
              mapping.relation,
              mapping.confidence
         from unnest($1::uuid[], $2::uuid[], $4::text[], $5::real[])
           as mapping(source_chunk_id, source_toc_entry_id, relation, confidence)
       on conflict (source_chunk_id, source_toc_entry_id) do update
         set source_revision_id = excluded.source_revision_id,
             relation = excluded.relation,
             confidence = excluded.confidence`,
      [
        rows.map((row) => row.chunkId),
        rows.map((row) => row.tocEntryId),
        sourceRevisionId,
        rows.map((row) => row.relation),
        rows.map((row) => row.confidence),
      ],
    );
  }
  await client.query(
    `update source_revisions
        set toc_alignment_attempted_at = now(),
            toc_alignment_version = $2
      where id = $1`,
    [sourceRevisionId, TOC_ALIGNMENT_VERSION],
  );
  return alignment;
}

export async function backfillMissingSourceTocEntries(sourceIds: string[]) {
  if (!sourceIds.length) return;
  const revisions = await db.query<{ id: string; source_file_id: string; raw_html: string | null }>(
    `with latest as (
       select distinct on (revision.source_file_id)
              revision.id, revision.source_file_id, revision.raw_html,
              revision.toc_alignment_attempted_at,
              revision.toc_alignment_version
         from source_revisions revision
        where revision.source_file_id = any($1::uuid[])
        order by revision.source_file_id, revision.revision desc
     )
     select r.id, r.source_file_id, r.raw_html
       from latest r
      where r.toc_alignment_attempted_at is null
         or r.toc_alignment_version < $2`,
    [sourceIds, TOC_ALIGNMENT_VERSION],
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
