import { expect, test } from 'vitest';
import { GET } from '@/app/api/events/[aggregate]/[id]/route';
import { GET as GET_LEGACY_RUN_EVENTS } from '@/app/api/runs/[id]/events/route';

test('rejects an unknown activity aggregate without opening a stream', async () => {
  const response = await GET(
    new Request('http://localhost/api/events/unknown/11111111-1111-4111-8111-111111111111'),
    {
      params: Promise.resolve({
        aggregate: 'unknown',
        id: '11111111-1111-4111-8111-111111111111',
      }),
    },
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ code: 'EVENT_STREAM_NOT_FOUND' });
});

test('opens the common activity stream and the legacy run route delegates compatibly', async () => {
  const aggregateAbort = new AbortController();
  aggregateAbort.abort();
  const common = await GET(
    new Request(
      'http://localhost/api/events/benchmark_run/11111111-1111-4111-8111-111111111111',
      { signal: aggregateAbort.signal },
    ),
    {
      params: Promise.resolve({
        aggregate: 'benchmark_run',
        id: '11111111-1111-4111-8111-111111111111',
      }),
    },
  );

  const legacyAbort = new AbortController();
  legacyAbort.abort();
  const legacy = await GET_LEGACY_RUN_EVENTS(
    new Request(
      'http://localhost/api/runs/11111111-1111-4111-8111-111111111111/events',
      { signal: legacyAbort.signal },
    ),
    { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
  );

  expect(common.headers.get('content-type')).toContain('text/event-stream');
  expect(legacy.headers.get('content-type')).toContain('text/event-stream');
  await expect(common.text()).resolves.toBe('retry: 2000\n\n');
  await expect(legacy.text()).resolves.toBe('retry: 2000\n\n');
});
