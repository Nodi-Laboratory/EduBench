-- Local username/password accounts and server-side sessions.
--
-- The browser only ever holds an opaque random session token in an httpOnly
-- cookie. The database stores its SHA-256 digest, so a leaked table dump cannot
-- be replayed as a cookie. Passwords are bcrypt hashes produced by the app.
--
-- Access control is enforced in application code (src/proxy.ts and
-- src/server/auth/*), not with row-level security:
--   * every page and /api route except /login, /signup and /api/auth/* requires
--     a valid, unexpired session (src/proxy.ts);
--   * a session can only be read or revoked through its own token digest
--     (src/server/auth/session.ts);
--   * research data stays a shared workspace for all signed-in users, matching
--     the single-team behaviour the app had before accounts existed.

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null
    check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  display_name text not null
    check (length(btrim(display_name)) between 1 and 60),
  password_hash text not null
    check (password_hash ~ '^\$2[aby]\$[0-9]{2}\$'),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create unique index users_username_key on users (username);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index user_sessions_user_id_idx on user_sessions (user_id);
create index user_sessions_expires_at_idx on user_sessions (expires_at);
