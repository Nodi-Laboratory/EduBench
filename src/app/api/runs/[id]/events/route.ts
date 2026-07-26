import { createActivityEventResponse } from '@/server/activity/event-stream';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createActivityEventResponse(request, {
    aggregate: 'benchmark_run',
    aggregateId: id,
  });
}
