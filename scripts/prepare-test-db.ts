import 'dotenv/config';
import pg from 'pg';

function testDatabaseUrl(): URL {
  if (process.env.DATABASE_URL_TEST) return new URL(process.env.DATABASE_URL_TEST);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 또는 DATABASE_URL_TEST가 필요합니다.');
  const url = new URL(process.env.DATABASE_URL);
  const sourceName = url.pathname.slice(1);
  url.pathname = `/${sourceName}_test`;
  return url;
}

async function main() {
  const target = testDatabaseUrl();
  const databaseName = target.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error('테스트 DB 이름에는 영문, 숫자, 밑줄만 사용할 수 있습니다.');
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [databaseName]);
    if (!existing.rowCount) await client.query(`create database "${databaseName}"`);
    console.log(`Integration database ready: ${databaseName}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
