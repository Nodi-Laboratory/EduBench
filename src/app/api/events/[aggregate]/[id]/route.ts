import {
  activityAggregates,
  createActivityEventResponse,
  type ActivityAggregate,
} from '@/server/activity/event-stream';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ aggregate: string; id: string }> },
) {
  const { aggregate, id } = await context.params;
  if (!activityAggregates.includes(aggregate as ActivityAggregate)) {
    return Response.json({ code: 'EVENT_STREAM_NOT_FOUND' }, { status: 404 });
  }
  return createActivityEventResponse(request, {
    aggregate: aggregate as ActivityAggregate,
    aggregateId: id,
  });
}
