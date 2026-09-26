import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@/domain/errors';
import {
  createSession, createUser, SESSION_COOKIE, sessionCookieOptions, signupSchema,
} from '@/server/auth/session';

export async function POST(request: Request) {
  try {
    const user = await createUser(signupSchema.parse(await request.json()));
    const session = await createSession(user.id);
    const response = NextResponse.json({ user }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { code: 'INVALID_SIGNUP_INPUT', message: error.issues[0]?.message ?? '입력값을 확인하세요.' },
        { status: 400 },
      );
    }
    if (error instanceof DomainError && error.code === 'USERNAME_TAKEN') {
      return NextResponse.json({ code: error.code, message: '이미 사용 중인 아이디입니다.' }, { status: 409 });
    }
    throw error;
  }
}
