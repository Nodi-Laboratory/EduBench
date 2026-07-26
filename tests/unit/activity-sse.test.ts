import { expect, test, vi } from 'vitest';
import { parseEventCursor } from '@/domain/event-cursor';
import { createActivityEventResponse } from '@/server/activity/event-stream';

test('writes one activity envelope with an exact bigint SSE id and closes on request abort', async () => {
  const abort = new AbortController();
  const readEvents = vi.fn(async () => {
    setTimeout(() => abort.abort(), 0);
    return [{
      id: parseEventCursor('9007199254740993')!,
      eventType: 'RUN_ITEM_COMPLETED',
      payload: { completedItems: 1 },
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
    }];
  });
  const request = new Request(
    'http://localhost/api/events/benchmark_run/11111111-1111-4111-8111-111111111111?after=9007199254740992',
    { signal: abort.signal },
  );

  const response = createActivityEventResponse(request, {
    aggregate: 'benchmark_run',
    aggregateId: '11111111-1111-4111-8111-111111111111',
    readEvents,
    pollIntervalMs: 1,
  });
  const body = await response.text();

  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(body).toContain('retry: 2000\n\n');
  expect(body).toContain('id: 9007199254740993\n');
  expect(body).toContain('event: activity\n');
  expect(body).toContain(`data: ${JSON.stringify({
    id: '9007199254740993',
    aggregate: 'benchmark_run',
    aggregateId: '11111111-1111-4111-8111-111111111111',
    eventType: 'RUN_ITEM_COMPLETED',
    payload: { completedItems: 1 },
    createdAt: '2026-07-26T00:00:00.000Z',
  })}\n\n`);
  expect(readEvents).toHaveBeenCalledWith(
    'benchmark_run',
    '11111111-1111-4111-8111-111111111111',
    '9007199254740992',
    200,
  );
});

test('uses the greater valid Last-Event-ID and query cursor and emits heartbeats', async () => {
  const abort = new AbortController();
  let reads = 0;
  const request = new Request(
    'http://localhost/api/events/source/11111111-1111-4111-8111-111111111111?after=9007199254740993',
    {
      headers: { 'Last-Event-ID': '9223372036854775807' },
      signal: abort.signal,
    },
  );
  const readEvents = vi.fn(async () => {
    reads += 1;
    if (reads === 2) abort.abort();
    return [];
  });

  const response = createActivityEventResponse(request, {
    aggregate: 'source',
    aggregateId: '11111111-1111-4111-8111-111111111111',
    readEvents,
    pollIntervalMs: 1,
    heartbeatIntervalMs: 0,
  });
  const body = await response.text();

  expect(readEvents).toHaveBeenCalledWith(
    'source',
    '11111111-1111-4111-8111-111111111111',
    '9223372036854775807',
    200,
  );
  expect(body).toContain(': heartbeat ');
  expect(readEvents).toHaveBeenCalledTimes(2);
});

test('stops server polling when the response body is cancelled without aborting the request', async () => {
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const readEvents = vi.fn(async () => {
    await firstRead;
    return [];
  });
  const response = createActivityEventResponse(
    new Request('http://localhost/api/events/source/11111111-1111-4111-8111-111111111111'),
    {
      aggregate: 'source',
      aggregateId: '11111111-1111-4111-8111-111111111111',
      readEvents,
      pollIntervalMs: 1,
    },
  );
  const reader = response.body!.getReader();

  await reader.read();
  await reader.cancel();
  releaseFirstRead();
  await new Promise((resolve) => setTimeout(resolve, 15));

  expect(readEvents).toHaveBeenCalledTimes(1);
});
