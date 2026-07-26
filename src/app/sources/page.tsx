import type { Metadata } from 'next';
import { SourcesWorkspace, type SourceListItem } from '@/components/sources/sources-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '교과서 자료 관리' };
export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  const result = await db.query<SourceListItem>(`with active_source_profiles as (
      select
        max(profile.content_hash) filter(where active.kind='document_parse') document_parse_hash,
        max(profile.content_hash) filter(where active.kind='embedding_rag') embedding_rag_hash
      from research_config_active_profiles active
      join research_config_profiles profile on profile.id=active.profile_id
      where active.kind in ('document_parse','embedding_rag')
    )
    select s.id, s.original_name, s.subject, s.grade, s.byte_size, s.status,
    s.failed_stage, s.created_at::text,s.source_lineage_id,
    s.reprocessed_from_source_file_id,
    j.id as current_job_id, j.state as current_job_state,
    not coalesce(
      s.document_parse_profile_snapshot_provenance='AT_CREATION_VERIFIED'
      and s.embedding_rag_profile_snapshot_provenance='AT_CREATION_VERIFIED'
      and s.document_parse_profile_hash=active.document_parse_hash
      and s.embedding_rag_profile_hash=active.embedding_rag_hash,
      false
    ) reprocess_required
    from source_files s left join lateral (
      select id, state from jobs where kind='document.parse' and payload->>'sourceId'=s.id::text order by created_at desc limit 1
    ) j on true
    cross join active_source_profiles active
    where s.deleted_at is null order by s.created_at desc`);
  return <SourcesWorkspace initialSources={result.rows} />;
}

