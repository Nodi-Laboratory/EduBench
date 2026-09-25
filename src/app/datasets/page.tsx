import type { Metadata } from 'next';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { getDatasetAuditIndex } from '@/server/datasets/audit';

export const metadata: Metadata = { title: '데이터셋 관리' };
export const dynamic = 'force-dynamic';

export default async function DatasetsPage() {
  const audit = await getDatasetAuditIndex();
  return <DatasetWorkspace {...audit} />;
}
