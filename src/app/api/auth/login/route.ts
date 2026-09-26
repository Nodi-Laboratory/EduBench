import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createSession, credentialsSchema, SESSION_COOKIE, sessionCookieOptions, verifyCredentials,
} from '@/server/auth/session';

export async function POST(request: Request) {
  try {
    const input = credentialsSchema.parse(await request.json());
    const user = await verifyCredentials(input);
    if (!user) {
      return NextResponse.json(
        { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 },
      );
    }
    const session = await createSession(user.id);
    const response = NextResponse.json({ user });
    response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 },
      );
    }
    throw error;
  }
}
