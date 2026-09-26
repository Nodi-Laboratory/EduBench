import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { DomainError } from '@/domain/errors';

export const SESSION_COOKIE = 'edubench_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const BCRYPT_ROUNDS = 12;

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
};

export const credentialsSchema = z.object({
  username: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '아이디는 3~32자의 영문 소문자, 숫자, . _ - 만 사용할 수 있습니다.'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(128),
});

export const signupSchema = credentialsSchema.extend({
  displayName: z.string().trim().max(60).optional(),
});

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.SESSION_COOKIE_SECURE?.toLowerCase() === 'true',
    path: '/',
    expires,
  };
}

export async function createUser(input: z.infer<typeof signupSchema>): Promise<SessionUser> {
  const passwordHash = await hashPassword(input.password);
  const displayName = input.displayName?.trim() || input.username;
  const result = await db.query<{ id: string; username: string; display_name: string }>(
    `insert into users(username, display_name, password_hash)
     values ($1, $2, $3)
     on conflict (username) do nothing
     returning id, username, display_name`,
    [input.username, displayName, passwordHash],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('USERNAME_TAKEN', '이미 사용 중인 아이디입니다.');
  return { id: row.id, username: row.username, displayName: row.display_name };
}

export async function verifyCredentials(
  input: z.infer<typeof credentialsSchema>,
): Promise<SessionUser | null> {
  const result = await db.query<{ id: string; username: string; display_name: string; password_hash: string }>(
    'select id, username, display_name, password_hash from users where username = $1',
    [input.username],
  );
  const row = result.rows[0];
  // Compare against a fixed hash when the user is unknown so response timing
  // does not reveal which usernames exist.
  const hash = row?.password_hash ?? '$2b$12$CNwZlBzTCYcgFxaoz/dfbu2bVSomJwbH.QF46il45XBoKxjyo9CY2';
  const valid = await bcrypt.compare(input.password, hash);
  if (!row || !valid) return null;
  await db.query('update users set last_login_at = now() where id = $1', [row.id]);
  return { id: row.id, username: row.username, displayName: row.display_name };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    'insert into user_sessions(user_id, token_hash, expires_at) values ($1, $2, $3)',
    [userId, hashSessionToken(token), expiresAt],
  );
  await db.query('delete from user_sessions where expires_at < now()');
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const result = await db.query<{ id: string; username: string; display_name: string }>(
    `select u.id, u.username, u.display_name
       from user_sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.query('delete from user_sessions where token_hash = $1', [hashSessionToken(token)]);
}
