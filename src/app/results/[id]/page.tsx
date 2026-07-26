import { notFound } from 'next/navigation';
import { ResultDetailLive } from '@/components/results/result-detail-live';
import { getResultDetails } from '@/server/results/details';

export const dynamic = 'force-dynamic';

export default async function ResultDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const details = await getResultDetails(id);
  if (!details) notFound();
  return <ResultDetailLive initialDetails={details} />;
}
