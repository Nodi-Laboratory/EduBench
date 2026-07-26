import {
  createControlRoomEventResponse,
} from '@/server/research/control-room-events';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return createControlRoomEventResponse(request);
}
