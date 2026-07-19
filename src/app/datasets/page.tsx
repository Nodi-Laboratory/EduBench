import type { Metadata } from 'next';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '데이터셋 관리' };
export const dynamic = 'force-dynamic';

export default async function DatasetsPage() {
  const [approved, versions] = await Promise.all([
    db.query<{ count: string }>(`select count(*) from questions where status = 'APPROVED' and deleted_at is null and public_id not like 'SAMPLE-Q-%'`),
    db.query<{ id: string; version: string; title: string; question_count: number; content_hash: string; published_at: string }>(`select id, version, title, question_count, content_hash, published_at::text from dataset_versions order by published_at desc`),
  ]);
  return <DatasetWorkspace approvedCount={Number(approved.rows[0]?.count ?? 0)} versions={versions.rows} />;
}
