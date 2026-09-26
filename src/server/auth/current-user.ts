import { cookies } from 'next/headers';
import { getSessionUser, SESSION_COOKIE, type SessionUser } from './session';

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value);
}
