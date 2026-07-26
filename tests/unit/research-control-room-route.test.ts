import { expect, test, vi } from 'vitest';
import {
  createControlRoomGetHandler,
} from '@/app/api/research/control-room/route';
import type {
  ControlRoomSnapshot,
} from '@/server/research/control-room-snapshot';

test('returns the database-backed control-room contract without filling empty records', async () => {
  const snapshot: ControlRoomSnapshot = {
    eventCursor: '0',
    generatedAt: '2026-07-27T03:00:00.000Z',
    system: {
      database: { state: 'HEALTHY', latencyMs: 7 },
      worker: {
        state: 'IDLE',
        activeLeases: 0,
        staleLeases: 0,
      },
      queue: {
        pending: 0,
        retryWait: 0,
        leased: 0,
      },
    },
    pipelineStages: [],
    activeOperations: [],
    failures: [],
    failureTotal: 0,
    recentEvents: [],
    profiles: [],
    scoreboard: [],
    scoreboardTotal: 0,
  };
  const readSnapshot = vi.fn(async () => snapshot);

  const response = await createControlRoomGetHandler({ readSnapshot })();

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual(snapshot);
  expect(readSnapshot).toHaveBeenCalledTimes(1);
});
