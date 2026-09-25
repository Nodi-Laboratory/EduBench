import { afterEach, expect, test, vi } from 'vitest';
import type { Pool } from 'pg';

const timeoutEnvironmentKeys = [
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_QUERY_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_LOCK_TIMEOUT_MS',
  'DATABASE_IDLE_TIMEOUT_MS',
] as const;

const originalTimeoutEnvironment = new Map(
  timeoutEnvironmentKeys.map((key) => [key, process.env[key]]),
);
const pools: Pool[] = [];

async function createFreshPool(): Promise<Pool> {
  vi.resetModules();
  const { db } = await import('@/server/db/pool');
  pools.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));

  for (const [key, value] of originalTimeoutEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.restoreAllMocks();
  vi.resetModules();
});

test('configures finite default timeouts for database operations', async () => {
  for (const key of timeoutEnvironmentKeys) {
    delete process.env[key];
  }

  const db = await createFreshPool();

  expect(db.options.connectionTimeoutMillis).toBe(10_000);
  expect(db.options.query_timeout).toBe(30_000);
  expect(db.options.statement_timeout).toBe(30_000);
  expect(db.options.lock_timeout).toBe(5_000);
  expect(db.options.idleTimeoutMillis).toBe(30_000);
});

test('uses positive timeout values supplied through the environment', async () => {
  process.env.DATABASE_CONNECTION_TIMEOUT_MS = '1200';
  process.env.DATABASE_QUERY_TIMEOUT_MS = '3400';
  process.env.DATABASE_STATEMENT_TIMEOUT_MS = '5600';
  process.env.DATABASE_LOCK_TIMEOUT_MS = '7800';
  process.env.DATABASE_IDLE_TIMEOUT_MS = '9100';

  const db = await createFreshPool();

  expect(db.options.connectionTimeoutMillis).toBe(1200);
  expect(db.options.query_timeout).toBe(3400);
  expect(db.options.statement_timeout).toBe(5600);
  expect(db.options.lock_timeout).toBe(7800);
  expect(db.options.idleTimeoutMillis).toBe(9100);
});

test('falls back when a configured timeout rounds below one millisecond', async () => {
  process.env.DATABASE_CONNECTION_TIMEOUT_MS = '0.5';

  const db = await createFreshPool();

  expect(db.options.connectionTimeoutMillis).toBe(10_000);
});

test('falls back when a configured timeout exceeds one hour', async () => {
  process.env.DATABASE_QUERY_TIMEOUT_MS = '3600001';

  const db = await createFreshPool();

  expect(db.options.query_timeout).toBe(30_000);
});

test('handles an idle-client error without logging database credentials', async () => {
  const db = await createFreshPool();
  const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const credential = 'postgresql://edubench:super-secret@db:5432/edubench';
  const error = Object.assign(new Error(credential), { code: 'ECONNRESET' });

  expect(() => db.emit('error', error)).not.toThrow();
  expect(logger).toHaveBeenCalledWith(
    '[EduBench db] idle client error',
    { name: 'Error', code: 'ECONNRESET' },
  );
  expect(logger.mock.calls.flat().join(' ')).not.toContain(credential);
});
