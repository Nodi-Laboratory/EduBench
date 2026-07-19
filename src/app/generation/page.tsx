import type { Metadata } from 'next';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '질문 생성' };
export const dynamic = 'force-dynamic';

export default async function GenerationPage() {
  const [sources, batches] = await Promise.all([
    db.query<{ id: string; original_name: string; subject: string | null; grade: string | null }>(`select id, original_name, subject, grade from source_files where status = 'READY' and deleted_at is null order by original_name`),
    db.query<{ id: string; state: string; requested_count: number; created_at: string }>(`select id, state, requested_count, created_at::text from generation_batches order by created_at desc limit 10`),
  ]);
  return <GenerationWorkspace sources={sources.rows} batches={batches.rows} />;
}

