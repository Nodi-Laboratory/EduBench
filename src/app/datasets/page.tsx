import type { Metadata } from 'next';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { getDatasetAuditData } from '@/server/datasets/audit';

export const metadata: Metadata = { title: '데이터셋 관리' };
export const dynamic = 'force-dynamic';

export default async function DatasetsPage() {
  const audit = await getDatasetAuditData();
  const countBy = (key: 'purpose' | 'questionType' | 'evidenceMode') => audit.workingQuestions.reduce<Record<string, number>>((result, row) => {
    result[row[key]] = (result[row[key]] ?? 0) + 1;
    return result;
  }, {});
  return <DatasetWorkspace
    approvedQuestionIds={audit.workingQuestions.map((row) => row.id)}
    workingDistribution={{ capabilities: countBy('purpose'), responseFormats: countBy('questionType'), evidenceModes: countBy('evidenceMode') }}
    workingQuestions={audit.workingQuestions}
    versions={audit.versions}
  />;
}
