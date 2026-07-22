import type { Metadata } from 'next';
import { SourcesWorkspace, type SourceListItem } from '@/components/sources/sources-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '교과서 자료 관리' };
export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  const result = await db.query<SourceListItem>(`select s.id, s.original_name, s.subject, s.grade, s.byte_size, s.status, s.failed_stage, s.created_at::text,
    j.id as current_job_id, j.state as current_job_state
    from source_files s left join lateral (
      select id, state from jobs where kind='document.parse' and payload->>'sourceId'=s.id::text order by created_at desc limit 1
    ) j on true where s.deleted_at is null order by s.created_at desc`);
  return <SourcesWorkspace initialSources={result.rows} />;
}

