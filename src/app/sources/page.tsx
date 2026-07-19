import type { Metadata } from 'next';
import { SourcesWorkspace, type SourceListItem } from '@/components/sources/sources-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '교과서 자료 관리' };
export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  const result = await db.query<SourceListItem>(`select id, original_name, subject, grade, byte_size, status, failed_stage, created_at::text from source_files where deleted_at is null order by created_at desc`);
  return <SourcesWorkspace initialSources={result.rows} />;
}

