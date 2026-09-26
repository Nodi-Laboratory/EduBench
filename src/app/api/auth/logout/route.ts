import { NextResponse, type NextRequest } from 'next/server';
import { deleteSession, SESSION_COOKIE } from '@/server/auth/session';

export async function POST(request: NextRequest) {
  await deleteSession(request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
