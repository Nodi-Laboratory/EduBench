import type { Metadata } from 'next';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { getDatasetAuditData } from '@/server/datasets/audit';

export const metadata: Metadata = { title: '데이터셋 관리' };
export const dynamic = 'force-dynamic';

export default async function DatasetsPage() {
  const audit = await getDatasetAuditData();
  return <DatasetWorkspace
    approvedQuestionIds={audit.workingQuestions.map((row) => row.id)}
    workingDistribution={{ capabilities: {}, responseFormats: {}, evidenceModes: {} }}
    workingQuestions={audit.workingQuestions}
    questionSets={audit.questionSets}
    versions={audit.versions}
  />;
}
