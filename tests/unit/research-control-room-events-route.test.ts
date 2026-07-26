import { expect, test } from 'vitest';
import {
  GET,
} from '@/app/api/research/control-room/events/route';

test('opens the global control-room event stream and closes cleanly for an aborted request', async () => {
  const abort = new AbortController();
  abort.abort();

  const response = await GET(new Request(
    'http://localhost/api/research/control-room/events?after=12',
    { signal: abort.signal },
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
  await expect(response.text()).resolves.toBe('retry: 2000\n\n');
});
