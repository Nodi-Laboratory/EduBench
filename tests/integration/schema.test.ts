import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  defaultResearchConfigDefinitions,
  type EmbeddingRagResearchConfig,
} from '@/domain/research-config';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('installs vector and the auditable benchmark tables', async () => {
  const tableResult = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const tables = tableResult.rows.map((row) => row.table_name);

  expect(tables).toEqual(expect.arrayContaining([
    'source_files',
    'source_chunks',
    'source_html_blobs',
    'questions',
    'question_revisions',
    'dataset_versions',
    'benchmark_runs',
    'run_items',
    'model_responses',
    'scores',
    'job_events',
    'job_event_cursor_allocator',
    'price_profiles',
  ]));

  const extension = await db.query<{ exists: boolean }>(
    `select exists(select 1 from pg_extension where extname = 'vector') as exists`,
  );
  expect(extension.rows[0]?.exists).toBe(true);
});

test('migration runner is idempotent', async () => {
  const first = await migrate();
  const second = await migrate();
  expect(first.applied).toBe(0);
  expect(second.applied).toBe(0);
});

test('stores supported variable embedding dimensions and isolates distance search by vector space', async () => {
  const client = await db.connect();
  await client.query('begin');
  try {
    const originalActive = await client.query<{ profile_id:string }>(
      `select profile_id
         from research_config_active_profiles
        where kind='embedding_rag'`,
    );
    const definition = structuredClone(defaultResearchConfigDefinitions.find(
      (profile): profile is EmbeddingRagResearchConfig =>
        profile.kind === 'embedding_rag',
    )!);
    definition.version = `embedding-rag-768-${randomUUID()}`;
    definition.title = 'Gemini Embedding 2 · 768차원 격리 검증';
    definition.settings.dimensions = 768;
    definition.settings.vectorSpaceId =
      'gemini-embedding-2:768:text-prefix-schema-test-v1';
    const profile = await client.query<{ id:string }>(
      `insert into research_config_profiles(
         kind,version,title,definition,content_hash
       ) values('embedding_rag',$1,$2,$3::jsonb,null)
       returning id`,
      [definition.version, definition.title, JSON.stringify(definition)],
    );
    await client.query(
      `update research_config_active_profiles
          set profile_id=$1,activated_at=now()
        where kind='embedding_rag'`,
      [profile.rows[0]!.id],
    );

    const source768 = await client.query<{ id:string }>(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'768.pdf','/tmp/768.pdf','application/pdf',1,'READY')
       returning id`,
      [randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
    const revision768 = await client.query<{ id:string }>(
      `insert into source_revisions(source_file_id,revision)
       values($1,1) returning id`,
      [source768.rows[0]!.id],
    );
    const vector768 = `[${new Array(768).fill(0).join(',')}]`;
    const chunk768 = await client.query<{ id:string }>(
      `insert into source_chunks(
         source_file_id,source_revision_id,ordinal,content,embedding
       ) values($1,$2,1,'768차원 근거',$3::vector)
       returning id`,
      [source768.rows[0]!.id, revision768.rows[0]!.id, vector768],
    );

    await client.query(
      `update research_config_active_profiles
          set profile_id=$1,activated_at=now()
        where kind='embedding_rag'`,
      [originalActive.rows[0]!.profile_id],
    );
    const source3072 = await client.query<{ id:string }>(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'3072.pdf','/tmp/3072.pdf','application/pdf',1,'READY')
       returning id`,
      [randomUUID().replaceAll('-', '').padEnd(64, '1')],
    );
    const revision3072 = await client.query<{ id:string }>(
      `insert into source_revisions(source_file_id,revision)
       values($1,1) returning id`,
      [source3072.rows[0]!.id],
    );
    const vector3072 = `[${new Array(3072).fill(0).join(',')}]`;
    await client.query(
      `insert into source_chunks(
         source_file_id,source_revision_id,ordinal,content,embedding
       ) values($1,$2,1,'3072차원 근거',$3::vector)`,
      [source3072.rows[0]!.id, revision3072.rows[0]!.id, vector3072],
    );

    const scoped = await client.query<{ id:string }>(
      `with scoped_chunks as materialized (
         select id,embedding
           from source_chunks
          where embedding_vector_space_id=$1
       )
       select id
         from scoped_chunks
        order by embedding <=> $2::vector`,
      [definition.settings.vectorSpaceId, vector768],
    );
    expect(scoped.rows).toEqual([{ id:chunk768.rows[0]!.id }]);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
