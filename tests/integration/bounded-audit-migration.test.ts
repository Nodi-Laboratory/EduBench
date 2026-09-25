import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { expect, test } from 'vitest';

function testDatabaseUrl():URL {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error('DATABASE_URL이 필요합니다.');
  return new URL(configured);
}

async function installThrough0042(client:pg.Client):Promise<void> {
  await client.query(`
    create table schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const directory = path.join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql') && file < '0043_')
    .sort();
  for (const file of files) {
    await client.query('begin');
    try {
      await client.query(await readFile(path.join(directory, file), 'utf8'));
      await client.query(
        'insert into schema_migrations(version) values($1)',
        [file],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
}

test('0043 refuses to discard a legacy receipt payload that differs from its root', async () => {
  const baseUrl = testDatabaseUrl();
  const databaseName = `edubench_migration_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString:adminUrl.toString() });
  let database:pg.Client | undefined;

  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
    database = new pg.Client({ connectionString:databaseUrl.toString() });
    await database.connect();
    await installThrough0042(database);

    const rootItemId = randomUUID();
    const receiptItemId = randomUUID();
    const benchmarkRunId = randomUUID();
    const questionId = randomUUID();
    await database.query('alter table run_items disable trigger all');
    await database.query(
      `insert into run_items(
         id,benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values
         ($1,$3,$5,$4,1,$7,'VECTOR'),
         ($2,$3,$6,$4,1,$8,'VECTOR')`,
      [
        rootItemId,
        receiptItemId,
        benchmarkRunId,
        questionId,
        randomUUID(),
        randomUUID(),
        `migration-root:${randomUUID()}`,
        `migration-receipt:${randomUUID()}`,
      ],
    );
    await database.query('alter table run_items enable trigger all');

    const rootRetrievalId = randomUUID();
    const snapshotKey = 'a'.repeat(64);
    const configHash = 'b'.repeat(64);
    const contextHash = 'c'.repeat(64);
    await database.query(
      `insert into run_item_retrievals(
         id,run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key
       ) values(
         $1,$2,'VECTOR','동일 질의','embedding','profile','space',
         '{"scope":"same"}'::jsonb,'[{"chunk":"root"}]'::jsonb,
         '{"graph":"same"}'::jsonb,'{"config":"same"}'::jsonb,
         $3,'canonical context',$4,$5
       )`,
      [
        rootRetrievalId,
        rootItemId,
        configHash,
        contextHash,
        snapshotKey,
      ],
    );
    await database.query(
      `insert into run_item_retrievals(
         run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key,
         shared_from_retrieval_id
       ) values(
         $1,'VECTOR','동일 질의','embedding','profile','space',
         '{"scope":"same"}'::jsonb,'[{"chunk":"DIFFERENT"}]'::jsonb,
         '{"graph":"same"}'::jsonb,'{"config":"same"}'::jsonb,
         $2,'canonical context',$3,$4,$5
       )`,
      [
        receiptItemId,
        configHash,
        contextHash,
        snapshotKey,
        rootRetrievalId,
      ],
    );
    const migration = await readFile(
      path.join(
        process.cwd(),
        'db',
        'migrations',
        '0043_bounded_audit_storage.sql',
      ),
      'utf8',
    );

    await expect(database.query(migration)).rejects.toMatchObject({
      code:'23514',
      message:expect.stringContaining(
        'shared retrieval receipt payload differs from its root',
      ),
    });
  } finally {
    await database?.end().catch(() => undefined);
    await admin.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where datname=$1 and pid<>pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
    await admin.end();
  }
}, 60_000);

test('0043 aborts without clearing HTML when one hash maps to distinct content', async () => {
  const baseUrl = testDatabaseUrl();
  const databaseName = `edubench_html_collision_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString:adminUrl.toString() });
  let database:pg.Client | undefined;

  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
    database = new pg.Client({ connectionString:databaseUrl.toString() });
    await database.connect();
    await installThrough0042(database);

    const sourceFileId = randomUUID();
    const sourceRevisionId = randomUUID();
    await database.query(
      `insert into source_files(
         id,sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,$2,'collision.html','collision.html','text/html',64,'READY')`,
      [sourceFileId, '1'.repeat(64)],
    );
    await database.query(
      `insert into source_revisions(id,source_file_id,revision)
       values($1,$2,1)`,
      [sourceRevisionId, sourceFileId],
    );
    await database.query(
      `insert into source_chunks(
         source_file_id,source_revision_id,ordinal,html,content
       ) values
         ($1,$2,1,'<p>alpha</p>','alpha'),
         ($1,$2,2,'<p>beta</p>','beta')`,
      [sourceFileId, sourceRevisionId],
    );

    // Deliberately shadow pg_catalog.sha256 for this session so the fixture
    // exercises the collision branch without relying on a real SHA-256 break.
    await database.query(`
      create function public.sha256(value bytea)
      returns bytea
      language sql
      immutable strict
      as $function$
        select decode(repeat('42',32),'hex')
      $function$;
      set search_path=public,pg_catalog
    `);
    const collision = await database.query<{ collides:boolean }>(
      `select sha256(convert_to('<p>alpha</p>','UTF8')) =
              sha256(convert_to('<p>beta</p>','UTF8')) as collides`,
    );
    expect(collision.rows[0]?.collides).toBe(true);

    const migration = await readFile(
      path.join(
        process.cwd(),
        'db',
        'migrations',
        '0043_bounded_audit_storage.sql',
      ),
      'utf8',
    );
    await expect(database.query(migration)).rejects.toMatchObject({
      code:'23514',
      message:expect.stringContaining('source chunk HTML hash collision'),
    });

    const chunks = await database.query<{
      ordinal:number;
      html:string;
    }>(
      `select ordinal,html
         from source_chunks
        where source_revision_id=$1
        order by ordinal`,
      [sourceRevisionId],
    );
    expect(chunks.rows).toEqual([
      { ordinal:1, html:'<p>alpha</p>' },
      { ordinal:2, html:'<p>beta</p>' },
    ]);
    const boundedTable = await database.query<{ relation:string | null }>(
      `select to_regclass('public.source_html_blobs')::text as relation`,
    );
    expect(boundedTable.rows[0]?.relation).toBeNull();
  } finally {
    await database?.end().catch(() => undefined);
    await admin.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where datname=$1 and pid<>pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
    await admin.end();
  }
}, 60_000);

test('0043 rewrites READY snapshot claims from receipts to their validated canonical root', async () => {
  const baseUrl = testDatabaseUrl();
  const databaseName = `edubench_claim_migration_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString:adminUrl.toString() });
  let database:pg.Client | undefined;

  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
    database = new pg.Client({ connectionString:databaseUrl.toString() });
    await database.connect();
    await installThrough0042(database);

    const rootItemId = randomUUID();
    const receiptItemId = randomUUID();
    const benchmarkRunId = randomUUID();
    const questionId = randomUUID();
    await database.query('alter table run_items disable trigger all');
    await database.query(
      `insert into run_items(
         id,benchmark_run_id,run_model_id,question_id,question_revision,
         idempotency_key,retrieval_mode
       ) values
         ($1,$3,$5,$4,1,$7,'VECTOR'),
         ($2,$3,$6,$4,1,$8,'VECTOR')`,
      [
        rootItemId,
        receiptItemId,
        benchmarkRunId,
        questionId,
        randomUUID(),
        randomUUID(),
        `claim-root:${randomUUID()}`,
        `claim-receipt:${randomUUID()}`,
      ],
    );
    await database.query('alter table run_items enable trigger all');

    const rootRetrievalId = randomUUID();
    const receiptRetrievalId = randomUUID();
    const snapshotKey = 'd'.repeat(64);
    const configHash = 'e'.repeat(64);
    const contextHash = 'f'.repeat(64);
    const payload = [
      'VECTOR',
      '동일 질의',
      'embedding',
      'profile',
      'space',
      '{"scope":"same"}',
      '[{"chunk":"same"}]',
      '{"graph":"same"}',
      '{"config":"same"}',
      configHash,
      'canonical context',
      contextHash,
      snapshotKey,
    ];
    await database.query(
      `insert into run_item_retrievals(
         id,run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
         $11::jsonb,$12,$13,$14,$15
       )`,
      [rootRetrievalId, rootItemId, ...payload],
    );
    await database.query(
      `insert into run_item_retrievals(
         id,run_item_id,retrieval_mode,query_text,embedding_model,
         embedding_profile_hash,vector_space_id,candidate_scope,
         selected_chunks,graph_trace,config_snapshot,config_hash,
         rendered_context,context_hash,shared_snapshot_key,
         shared_from_retrieval_id
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
         $11::jsonb,$12,$13,$14,$15,$16
       )`,
      [
        receiptRetrievalId,
        receiptItemId,
        ...payload,
        rootRetrievalId,
      ],
    );
    await database.query(
      'alter table benchmark_retrieval_snapshot_claims disable trigger all',
    );
    await database.query(
      `insert into benchmark_retrieval_snapshot_claims(
         snapshot_key,benchmark_run_id,question_id,question_revision,
         retrieval_mode,state,root_retrieval_id
       ) values($1,$2,$3,1,'VECTOR','READY',$4)`,
      [snapshotKey, benchmarkRunId, questionId, receiptRetrievalId],
    );
    await database.query(
      'alter table benchmark_retrieval_snapshot_claims enable trigger all',
    );

    const migration = await readFile(
      path.join(
        process.cwd(),
        'db',
        'migrations',
        '0043_bounded_audit_storage.sql',
      ),
      'utf8',
    );
    await database.query(migration);

    const claim = await database.query<{
      root_retrieval_id:string;
    }>(
      `select root_retrieval_id
         from benchmark_retrieval_snapshot_claims
        where snapshot_key=$1`,
      [snapshotKey],
    );
    expect(claim.rows).toEqual([{
      root_retrieval_id:rootRetrievalId,
    }]);
    await expect(database.query(
      `update benchmark_retrieval_snapshot_claims
          set root_retrieval_id=$2
        where snapshot_key=$1`,
      [snapshotKey, receiptRetrievalId],
    )).rejects.toThrow(/direct payload-bearing root/);
    await expect(database.query(
      `update benchmark_retrieval_snapshot_claims
          set retrieval_mode='PIKE'
        where snapshot_key=$1`,
      [snapshotKey],
    )).rejects.toThrow(/root identity is invalid/);
  } finally {
    await database?.end().catch(() => undefined);
    await admin.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where datname=$1 and pid<>pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
    await admin.end();
  }
}, 60_000);
