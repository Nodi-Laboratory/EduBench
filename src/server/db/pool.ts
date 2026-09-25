import 'dotenv/config';
import { Pool } from 'pg';

export const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://edubench:edubench@localhost:54329/edubench';

const MAX_DATABASE_TIMEOUT_MS = 60 * 60 * 1_000;

function positiveMilliseconds(name: string, fallback: number): number {
  const value = Math.floor(Number(process.env[name]));
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DATABASE_TIMEOUT_MS
    ? value
    : fallback;
}

export const db = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  application_name: process.env.DATABASE_APPLICATION_NAME ?? 'edubench',
  connectionTimeoutMillis: positiveMilliseconds('DATABASE_CONNECTION_TIMEOUT_MS', 10_000),
  query_timeout: positiveMilliseconds('DATABASE_QUERY_TIMEOUT_MS', 30_000),
  statement_timeout: positiveMilliseconds('DATABASE_STATEMENT_TIMEOUT_MS', 30_000),
  lock_timeout: positiveMilliseconds('DATABASE_LOCK_TIMEOUT_MS', 5_000),
  idleTimeoutMillis: positiveMilliseconds('DATABASE_IDLE_TIMEOUT_MS', 30_000),
});

db.on('error', (error) => {
  const code = (error as Error & { code?: unknown }).code;
  console.error('[EduBench db] idle client error', {
    name: error.name,
    ...(typeof code === 'string' ? { code } : {}),
  });
});

