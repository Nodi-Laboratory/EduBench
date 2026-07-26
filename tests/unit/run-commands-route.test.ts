import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/server/runs/service', () => ({
  commandRun: vi.fn(async (_id: string, command: string) => ({ state: command })),
  retryFailedRunItems: vi.fn(async () => 0),
  retryScoringRun: vi.fn(async () => ({ state: 'SCORING' })),
}));

import { POST } from '@/app/api/runs/[id]/commands/route';
import { commandRun } from '@/server/runs/service';

const context = {
  params: Promise.resolve({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

test.each([
  'FINISH_PAUSE',
  'FINISH_STOP',
  'FINISH_CANCEL',
  'BEGIN_SCORING',
  'COMPLETE',
  'FAIL',
])('rejects worker-owned %s transitions at the public command boundary', async (command) => {
  const response = await POST(new Request('http://localhost/api/runs/id/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  }), context);

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_RUN_COMMAND' });
  expect(commandRun).not.toHaveBeenCalled();
});

test.each(['QUEUE', 'START', 'PAUSE', 'STOP', 'RESUME', 'CANCEL'])(
  'allows the public %s control command',
  async (command) => {
    const response = await POST(new Request('http://localhost/api/runs/id/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    }), context);

    expect(response.status).toBe(200);
    expect(commandRun).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      command,
    );
  },
);
