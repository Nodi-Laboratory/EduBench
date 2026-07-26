import {
  getControlRoomSnapshot,
  type ControlRoomSnapshot,
} from '@/server/research/control-room-snapshot';

export const dynamic = 'force-dynamic';

export function createControlRoomGetHandler(input: {
  readSnapshot?: () => Promise<ControlRoomSnapshot>;
} = {}) {
  const readSnapshot = input.readSnapshot ?? getControlRoomSnapshot;
  return async function GET() {
    return Response.json(await readSnapshot(), {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  };
}

export const GET = createControlRoomGetHandler();
