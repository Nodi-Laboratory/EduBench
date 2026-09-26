import type { Metadata } from 'next';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { db } from '@/server/db/pool';
import { backfillMissingSourceTocEntries } from '@/server/sources/toc';

export const metadata: Metadata = { title: '질문 생성' };
export const dynamic = 'force-dynamic';

export default async function GenerationPage() {
  const sources = await db.query<{ id: string; original_name: string; subject: string | null; grade: string | null }>(`select id, original_name, subject, grade from source_files where status = 'READY' and deleted_at is null order by original_name`);
  await backfillMissingSourceTocEntries(sources.rows.map((source) => source.id));
  const [toc, batches] = await Promise.all([
    db.query<{
      id: string;
      source_file_id: string;
      title: string;
      level: number;
      printed_page: number | null;
      mapping_status: 'MAPPED' | 'UNMAPPED';
      mapped_chunk_count: number;
      mapping_confidence: number | null;
    }>(
      `select entry.id, entry.source_file_id, entry.title, entry.level, entry.printed_page,
              entry.mapping_status, entry.mapping_confidence,
              count(distinct mapping.source_chunk_id)::int as mapped_chunk_count
         from source_toc_entries entry
         join lateral (
           select revision.id
             from source_revisions revision
            where revision.source_file_id = entry.source_file_id
            order by revision.revision desc
            limit 1
         ) latest on latest.id = entry.source_revision_id
         left join source_chunk_toc_entries mapping
           on mapping.source_toc_entry_id = entry.id
          and mapping.source_revision_id = entry.source_revision_id
        where entry.source_file_id = any($1::uuid[])
        group by entry.id
        order by entry.source_file_id, entry.ordinal`,
      [sources.rows.map((source) => source.id)],
    ),
    db.query<{ id: string; state: string; requested_count: number; created_at: string; progress: { completedQuestions?: number; failedQuestions?: number; error?: string } }>(
      `select id, state, requested_count, created_at::text,
         jsonb_build_object(
           'completedQuestions',progress->'completedQuestions',
           'failedQuestions',progress->'failedQuestions',
           'error',progress->'error'
         ) progress
       from generation_batches order by created_at desc limit 10`,
    ),
  ]);
  const hydrated = sources.rows.map((source) => ({ ...source, tocEntries: toc.rows.filter((entry) => entry.source_file_id === source.id) }));
  return <GenerationWorkspace sources={hydrated} batches={batches.rows} />;
}

