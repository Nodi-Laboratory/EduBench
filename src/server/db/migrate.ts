import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './pool';

const isEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

export async function migrate(): Promise<{ applied: number; versions: string[] }> {
  const directory = path.join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const client = await db.connect();
  const appliedVersions: string[] = [];

  try {
    await client.query('select pg_advisory_lock($1)', [82623641]);
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const existing = await client.query<{ version: string }>('select version from schema_migrations');
    const installed = new Set(existing.rows.map((row) => row.version));

    for (const file of files) {
      if (installed.has(file)) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values ($1)', [file]);
        await client.query('commit');
        appliedVersions.push(file);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [82623641]);
    client.release();
  }

  return { applied: appliedVersions.length, versions: appliedVersions };
}

if (isEntrypoint) {
  migrate()
    .then(async (result) => {
      console.log(`Applied ${result.applied} migration(s): ${result.versions.join(', ') || 'none'}`);
      await db.end();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await db.end();
      process.exitCode = 1;
    });
}

