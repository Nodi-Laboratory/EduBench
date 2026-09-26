import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser, SESSION_COOKIE } from '@/server/auth/session';

// Replaces what row-level security would otherwise guard: every page and API
// route requires a valid server-side session, except the sign-in surface.
const PUBLIC_PATHS = new Set(['/login', '/signup']);

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname) || pathname.startsWith('/api/auth/');
  const user = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);

  if (user && PUBLIC_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  if (user || isPublic) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  if (pathname !== '/' && pathname !== '/dashboard') login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
