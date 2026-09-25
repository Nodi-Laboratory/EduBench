import { notFound } from 'next/navigation';
import { RunController } from '@/components/runs/run-controller';
import { getRunDetails } from '@/server/runs/details';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const details = await getRunDetails(id);
  if (!details) notFound();
  return <RunController
    initialRun={details.run}
    models={details.models}
    profile={details.profile}
    scoringEngine={details.scoringEngine}
    initialItems={details.items}
    initialItemPagination={details.itemPagination}
    initialCounters={details.counters}
    initialItemFilters={details.itemFilters}
    initialItemFilterOptions={details.itemFilterOptions}
    initialProviderCooldowns={details.providerCooldowns}
    initialEvents={details.events}
    initialEventCursor={details.eventCursor}
  />;
}
