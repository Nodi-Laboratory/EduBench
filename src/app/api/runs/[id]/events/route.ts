import { getRunEventsAfter } from '@/server/runs/service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const headerId = Number(request.headers.get('last-event-id') ?? 0);
  const queryId = Number(new URL(request.url).searchParams.get('after') ?? 0);
  let cursor = Number.isFinite(headerId) && headerId > 0 ? headerId : queryId;
  const encoder = new TextEncoder();
  let heartbeatAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      while (!request.signal.aborted) {
        const events = await getRunEventsAfter(id, cursor);
        for (const event of events) {
          cursor = Number(event.id);
          controller.enqueue(encoder.encode(
            `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify({ ...event.payload, createdAt: event.created_at })}\n\n`,
          ));
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          heartbeatAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
