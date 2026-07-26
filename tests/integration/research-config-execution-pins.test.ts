import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  resolveBenchmarkExecutionPin,
  resolveGenerationExecutionPins,
  resolveSourceExecutionPins,
  verifyResearchConfigPin,
} from '@/server/settings/execution-pins';

type ActiveProfileRow = {
  id:string;
  kind:string;
  definition:unknown;
  content_hash:string;
};

async function createBenchmarkDependencies() {
  const marker = randomUUID();
  const dataset = await db.query<{ id:string }>(
    `insert into dataset_versions(
       version,status,title,question_count,distribution,content_hash
     ) values($1,'PUBLISHED','실행 설정 고정 테스트',0,'{}'::jsonb,$2)
     returning id`,
    [`pin-dataset-${marker}`, `pin-dataset-${marker}`],
  );
  const profile = await db.query<{ id:string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,content_hash
     ) values(
       $1,'실행 설정 고정 채점','["exact_match"]'::jsonb,
       '{}'::jsonb,null,'temporary'
     )
     returning id`,
    [`pin-score-${marker}`],
  );
  return {
    datasetId:dataset.rows[0]!.id,
    scoreProfileId:profile.rows[0]!.id,
  };
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('new execution records pin the active full definitions and chunks inherit the source vector space', async () => {
  const active = await db.query<ActiveProfileRow>(
    `select profile.id,profile.kind,profile.definition,profile.content_hash
     from research_config_active_profiles active
     join research_config_profiles profile on profile.id=active.profile_id`,
  );
  const activeByKind = Object.fromEntries(
    active.rows.map((profile) => [profile.kind, profile]),
  );
  const marker = randomUUID();
  const source = await db.query<{
    id:string;
    document_parse_profile_id:string;
    document_parse_profile_snapshot:unknown;
    document_parse_profile_hash:string;
    document_parse_profile_snapshot_provenance:string;
    embedding_rag_profile_id:string;
    embedding_rag_profile_snapshot:unknown;
    embedding_rag_profile_hash:string;
    embedding_rag_profile_snapshot_provenance:string;
  }>(
    `insert into source_files(
       sha256,original_name,storage_path,mime_type,byte_size,status
     ) values($1,'교과서.pdf',$2,'application/pdf',10,'UPLOADED')
     returning
       id,
       document_parse_profile_id,
       document_parse_profile_snapshot,
       document_parse_profile_hash,
       document_parse_profile_snapshot_provenance,
       embedding_rag_profile_id,
       embedding_rag_profile_snapshot,
       embedding_rag_profile_hash,
       embedding_rag_profile_snapshot_provenance`,
    [marker.replaceAll('-', ''), `sources/${marker}.pdf`],
  );
  const revision = await db.query<{ id:string }>(
    `insert into source_revisions(source_file_id,revision)
     values($1,1) returning id`,
    [source.rows[0]!.id],
  );
  const chunk = await db.query<{
    embedding_rag_profile_id:string;
    embedding_rag_profile_hash:string;
    embedding_vector_space_id:string;
    embedding_rag_profile_snapshot_provenance:string;
  }>(
    `insert into source_chunks(
       source_file_id,source_revision_id,ordinal,content
     ) values($1,$2,1,'벡터 공간 고정 확인')
     returning
       embedding_rag_profile_id,
       embedding_rag_profile_hash,
       embedding_vector_space_id,
       embedding_rag_profile_snapshot_provenance`,
    [source.rows[0]!.id, revision.rows[0]!.id],
  );
  const generation = await db.query<{
    id:string;
    question_generation_profile_id:string;
    question_generation_profile_snapshot:unknown;
    question_generation_profile_hash:string;
    question_generation_profile_snapshot_provenance:string;
    embedding_rag_profile_id:string;
    embedding_rag_profile_snapshot:unknown;
    embedding_rag_profile_hash:string;
    embedding_rag_profile_snapshot_provenance:string;
  }>(
    `insert into generation_batches(
       requested_count,conditions,source_scope,generation_model,prompt_version
     ) values(1,'{}'::jsonb,'{}'::jsonb,'test','test-v1')
     returning
       id,
       question_generation_profile_id,
       question_generation_profile_snapshot,
       question_generation_profile_hash,
       question_generation_profile_snapshot_provenance,
       embedding_rag_profile_id,
       embedding_rag_profile_snapshot,
       embedding_rag_profile_hash,
       embedding_rag_profile_snapshot_provenance`,
  );
  const dependencies = await createBenchmarkDependencies();
  const run = await db.query<{
    id:string;
    benchmark_models_profile_id:string;
    benchmark_models_profile_snapshot:unknown;
    benchmark_models_profile_hash:string;
    benchmark_models_profile_snapshot_provenance:string;
  }>(
    `insert into benchmark_runs(
       public_id,title,dataset_version_id,score_profile_id,
       price_profile_version,system_prompt,parameters
     ) values($1,'설정 고정 실행',$2,$3,'test-price','답하세요.','{}'::jsonb)
     returning
       id,
       benchmark_models_profile_id,
       benchmark_models_profile_snapshot,
       benchmark_models_profile_hash,
       benchmark_models_profile_snapshot_provenance`,
    [`PIN-${marker}`, dependencies.datasetId, dependencies.scoreProfileId],
  );

  expect(source.rows[0]).toMatchObject({
    document_parse_profile_id:activeByKind.document_parse.id,
    document_parse_profile_snapshot:activeByKind.document_parse.definition,
    document_parse_profile_hash:activeByKind.document_parse.content_hash,
    document_parse_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
    embedding_rag_profile_id:activeByKind.embedding_rag.id,
    embedding_rag_profile_snapshot:activeByKind.embedding_rag.definition,
    embedding_rag_profile_hash:activeByKind.embedding_rag.content_hash,
    embedding_rag_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
  });
  expect(chunk.rows[0]).toEqual({
    embedding_rag_profile_id:activeByKind.embedding_rag.id,
    embedding_rag_profile_hash:activeByKind.embedding_rag.content_hash,
    embedding_vector_space_id:
      (activeByKind.embedding_rag.definition as {
        settings:{ vectorSpaceId:string };
      }).settings.vectorSpaceId,
    embedding_rag_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
  });
  expect(generation.rows[0]).toMatchObject({
    question_generation_profile_id:activeByKind.question_generation.id,
    question_generation_profile_snapshot:activeByKind.question_generation.definition,
    question_generation_profile_hash:activeByKind.question_generation.content_hash,
    question_generation_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
    embedding_rag_profile_id:activeByKind.embedding_rag.id,
    embedding_rag_profile_snapshot:activeByKind.embedding_rag.definition,
    embedding_rag_profile_hash:activeByKind.embedding_rag.content_hash,
    embedding_rag_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
  });
  expect(run.rows[0]).toMatchObject({
    benchmark_models_profile_id:activeByKind.benchmark_models.id,
    benchmark_models_profile_snapshot:activeByKind.benchmark_models.definition,
    benchmark_models_profile_hash:activeByKind.benchmark_models.content_hash,
    benchmark_models_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
  });

  const resolvedSource = await resolveSourceExecutionPins(source.rows[0]!.id);
  const resolvedGeneration = await resolveGenerationExecutionPins(
    generation.rows[0]!.id,
  );
  const resolvedRun = await resolveBenchmarkExecutionPin(run.rows[0]!.id);
  expect(resolvedSource.documentParse.definition.kind).toBe('document_parse');
  expect(resolvedSource.documentParse.profileId).toBe(
    activeByKind.document_parse.id,
  );
  expect(resolvedSource.embeddingRag.definition.settings.vectorSpaceId).toBe(
    chunk.rows[0]!.embedding_vector_space_id,
  );
  expect(resolvedGeneration.questionGeneration.definition.kind).toBe(
    'question_generation',
  );
  expect(resolvedGeneration.embeddingRag.profileId).toBe(
    activeByKind.embedding_rag.id,
  );
  expect(resolvedRun.definition.settings.models.map(
    (model) => model.providerKey,
  )).toEqual(['gemini', 'upstage', 'exaone']);

  expect(() => verifyResearchConfigPin('document_parse', {
    ...resolvedSource.documentParse,
    contentHash:'0'.repeat(64),
  })).toThrow(expect.objectContaining({
    code:'RESEARCH_CONFIG_PIN_INTEGRITY_ERROR',
  }));
  expect(() => verifyResearchConfigPin('embedding_rag', {
    profileId:null,
    definition:null,
    contentHash:null,
    provenance:'LEGACY_BACKFILL_UNVERIFIED',
  })).toThrow(expect.objectContaining({
    code:'RESEARCH_CONFIG_PIN_UNVERIFIED',
  }));

  await expect(db.query(
    `update source_files
     set document_parse_profile_hash=repeat('0',64)
     where id=$1`,
    [source.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update source_chunks
     set embedding_vector_space_id='different-space'
     where source_file_id=$1`,
    [source.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update generation_batches
     set question_generation_profile_id=null
     where id=$1`,
    [generation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update benchmark_runs
     set benchmark_models_profile_snapshot='{}'::jsonb
     where id=$1`,
    [run.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
});

test('new records fail closed when an active research profile is missing', async () => {
  const client = await db.connect();
  await client.query('begin');
  try {
    await client.query(
      `alter table research_config_active_profiles
       disable trigger research_config_active_kind_protected`,
    );
    await client.query(
      `delete from research_config_active_profiles
       where kind='document_parse'`,
    );
    await expect(client.query(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'누락.pdf',$2,'application/pdf',1,'UPLOADED')`,
      [
        randomUUID().replaceAll('-', ''),
        `sources/${randomUUID()}.pdf`,
      ],
    )).rejects.toMatchObject({ code:'55000' });
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('0021 installs cleanly with the complete migration chain in an empty schema', async () => {
  const schema = `research_pin_fresh_${randomUUID().replaceAll('-', '')}`;
  if (!/^research_pin_fresh_[a-f0-9]+$/.test(schema)) {
    throw new Error('unsafe temporary schema name');
  }
  const client = await db.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}",public`);
    const migrationDirectory = path.join(process.cwd(), 'db', 'migrations');
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(
        path.join(migrationDirectory, migration),
        'utf8',
      ));
    }

    const source = await client.query<{
      document_parse_profile_snapshot_provenance:string;
      embedding_rag_profile_snapshot_provenance:string;
      document_parse_profile_hash:string;
      embedding_rag_profile_hash:string;
    }>(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'fresh.pdf',$2,'application/pdf',1,'UPLOADED')
       returning
         document_parse_profile_snapshot_provenance,
         embedding_rag_profile_snapshot_provenance,
         document_parse_profile_hash,
         embedding_rag_profile_hash`,
      [
        randomUUID().replaceAll('-', ''),
        `fresh/${randomUUID()}.pdf`,
      ],
    );
    expect(source.rows[0]).toMatchObject({
      document_parse_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
      embedding_rag_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
      document_parse_profile_hash:expect.stringMatching(/^[0-9a-f]{64}$/),
      embedding_rag_profile_hash:expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  } finally {
    await client.query('reset search_path');
    await client.query(`drop schema if exists "${schema}" cascade`);
    client.release();
  }
});

test('0021 marks historical execution rows as legacy without fabricating configuration snapshots', async () => {
  const schema = `research_pin_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!/^research_pin_upgrade_[a-f0-9]+$/.test(schema)) {
    throw new Error('unsafe temporary schema name');
  }
  const client = await db.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}",public`);
    const migrationDirectory = path.join(process.cwd(), 'db', 'migrations');
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations.filter((file) => file < '0021_')) {
      await client.query(await readFile(
        path.join(migrationDirectory, migration),
        'utf8',
      ));
    }

    const marker = randomUUID();
    const source = await client.query<{ id:string }>(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'기존.pdf',$2,'application/pdf',10,'READY')
       returning id`,
      [marker.replaceAll('-', ''), `legacy/${marker}.pdf`],
    );
    const revision = await client.query<{ id:string }>(
      `insert into source_revisions(source_file_id,revision)
       values($1,1) returning id`,
      [source.rows[0]!.id],
    );
    await client.query(
      `insert into source_chunks(
         source_file_id,source_revision_id,ordinal,content
       ) values($1,$2,1,'기존 청크')`,
      [source.rows[0]!.id, revision.rows[0]!.id],
    );
    const generation = await client.query<{ id:string }>(
      `insert into generation_batches(
         requested_count,conditions,source_scope,generation_model,prompt_version
       ) values(1,'{}'::jsonb,'{}'::jsonb,'legacy','legacy-v1')
       returning id`,
    );
    const dataset = await client.query<{ id:string }>(
      `insert into dataset_versions(
         version,status,title,question_count,distribution,content_hash
       ) values($1,'PUBLISHED','기존 데이터셋',0,'{}'::jsonb,$2)
       returning id`,
      [`legacy-dataset-${marker}`, `legacy-dataset-${marker}`],
    );
    const scoreProfile = await client.query<{ id:string }>(
      `insert into score_profiles(
         version,title,metrics,weights,rubric_prompt,content_hash
       ) values(
         $1,'기존 채점','["exact_match"]'::jsonb,
         '{}'::jsonb,null,'temporary'
       ) returning id`,
      [`legacy-score-${marker}`],
    );
    const run = await client.query<{ id:string }>(
      `insert into benchmark_runs(
         public_id,title,dataset_version_id,score_profile_id,
         price_profile_version,system_prompt,parameters
       ) values($1,'기존 실행',$2,$3,'legacy-price','답하세요.','{}'::jsonb)
       returning id`,
      [`LEGACY-PIN-${marker}`, dataset.rows[0]!.id, scoreProfile.rows[0]!.id],
    );

    const pinMigration = migrations.find((file) => file.startsWith('0021_'));
    expect(pinMigration).toBeTruthy();
    await client.query(await readFile(
      path.join(migrationDirectory, pinMigration!),
      'utf8',
    ));

    const upgraded = await client.query<{
      source_document_id:string | null;
      source_document_snapshot:unknown;
      source_document_hash:string | null;
      source_document_provenance:string;
      source_embedding_id:string | null;
      source_embedding_snapshot:unknown;
      source_embedding_hash:string | null;
      source_embedding_provenance:string;
      chunk_embedding_id:string | null;
      chunk_embedding_hash:string | null;
      chunk_vector_space_id:string | null;
      chunk_embedding_provenance:string;
      generation_question_id:string | null;
      generation_question_snapshot:unknown;
      generation_question_hash:string | null;
      generation_question_provenance:string;
      generation_embedding_id:string | null;
      generation_embedding_snapshot:unknown;
      generation_embedding_hash:string | null;
      generation_embedding_provenance:string;
      run_models_id:string | null;
      run_models_snapshot:unknown;
      run_models_hash:string | null;
      run_models_provenance:string;
    }>(
      `select
         source.document_parse_profile_id source_document_id,
         source.document_parse_profile_snapshot source_document_snapshot,
         source.document_parse_profile_hash source_document_hash,
         source.document_parse_profile_snapshot_provenance source_document_provenance,
         source.embedding_rag_profile_id source_embedding_id,
         source.embedding_rag_profile_snapshot source_embedding_snapshot,
         source.embedding_rag_profile_hash source_embedding_hash,
         source.embedding_rag_profile_snapshot_provenance source_embedding_provenance,
         chunk.embedding_rag_profile_id chunk_embedding_id,
         chunk.embedding_rag_profile_hash chunk_embedding_hash,
         chunk.embedding_vector_space_id chunk_vector_space_id,
         chunk.embedding_rag_profile_snapshot_provenance chunk_embedding_provenance,
         generation.question_generation_profile_id generation_question_id,
         generation.question_generation_profile_snapshot generation_question_snapshot,
         generation.question_generation_profile_hash generation_question_hash,
         generation.question_generation_profile_snapshot_provenance generation_question_provenance,
         generation.embedding_rag_profile_id generation_embedding_id,
         generation.embedding_rag_profile_snapshot generation_embedding_snapshot,
         generation.embedding_rag_profile_hash generation_embedding_hash,
         generation.embedding_rag_profile_snapshot_provenance generation_embedding_provenance,
         run.benchmark_models_profile_id run_models_id,
         run.benchmark_models_profile_snapshot run_models_snapshot,
         run.benchmark_models_profile_hash run_models_hash,
         run.benchmark_models_profile_snapshot_provenance run_models_provenance
       from source_files source
       join source_chunks chunk on chunk.source_file_id=source.id
       cross join generation_batches generation
       cross join benchmark_runs run
       where source.id=$1 and generation.id=$2 and run.id=$3`,
      [source.rows[0]!.id, generation.rows[0]!.id, run.rows[0]!.id],
    );
    expect(upgraded.rows[0]).toEqual({
      source_document_id:null,
      source_document_snapshot:null,
      source_document_hash:null,
      source_document_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      source_embedding_id:null,
      source_embedding_snapshot:null,
      source_embedding_hash:null,
      source_embedding_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      chunk_embedding_id:null,
      chunk_embedding_hash:null,
      chunk_vector_space_id:null,
      chunk_embedding_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      generation_question_id:null,
      generation_question_snapshot:null,
      generation_question_hash:null,
      generation_question_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      generation_embedding_id:null,
      generation_embedding_snapshot:null,
      generation_embedding_hash:null,
      generation_embedding_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      run_models_id:null,
      run_models_snapshot:null,
      run_models_hash:null,
      run_models_provenance:'LEGACY_BACKFILL_UNVERIFIED',
    });

    const newSource = await client.query<{
      document_parse_profile_id:string;
      embedding_rag_profile_id:string;
      document_parse_profile_snapshot_provenance:string;
      embedding_rag_profile_snapshot_provenance:string;
    }>(
      `insert into source_files(
         sha256,original_name,storage_path,mime_type,byte_size,status
       ) values($1,'신규.pdf',$2,'application/pdf',10,'UPLOADED')
       returning
         document_parse_profile_id,
         embedding_rag_profile_id,
         document_parse_profile_snapshot_provenance,
         embedding_rag_profile_snapshot_provenance`,
      [randomUUID().replaceAll('-', ''), `new/${randomUUID()}.pdf`],
    );
    expect(newSource.rows[0]).toMatchObject({
      document_parse_profile_id:expect.any(String),
      embedding_rag_profile_id:expect.any(String),
      document_parse_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
      embedding_rag_profile_snapshot_provenance:'AT_CREATION_VERIFIED',
    });
  } finally {
    await client.query('reset search_path');
    await client.query(`drop schema if exists "${schema}" cascade`);
    client.release();
  }
});
