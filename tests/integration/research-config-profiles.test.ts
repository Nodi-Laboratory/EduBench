import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  GET as listProfilesRoute,
  PATCH as activateProfileRoute,
  POST as createProfileRoute,
} from '@/app/api/settings/research-profiles/route';
import {
  defaultResearchConfigDefinitions,
  documentParseResearchConfigSchema,
  embeddingRagResearchConfigSchema,
  hashResearchConfigDefinition,
  type ResearchConfigDefinition,
} from '@/domain/research-config';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

test('seeds one active, content-hashed preset for every research setting kind', async () => {
  const response = await listProfilesRoute(
    new Request('http://localhost/api/settings/research-profiles'),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as {
    items:Array<{
      id:string;
      kind:string;
      version:string;
      definition:ResearchConfigDefinition;
      contentHash:string;
      active:boolean;
    }>;
    activeByKind:Record<string, string>;
  };

  expect(body.items.length).toBeGreaterThanOrEqual(4);
  expect(body.items.filter((item) => item.active)).toHaveLength(4);
  expect(Object.keys(body.activeByKind).sort()).toEqual([
    'benchmark_models',
    'document_parse',
    'embedding_rag',
    'question_generation',
  ]);

  for (const definition of defaultResearchConfigDefinitions) {
    const stored = body.items.find((item) => item.version === definition.version);
    expect(stored?.definition).toEqual(definition);
    expect(stored?.contentHash).toBe(hashResearchConfigDefinition(definition));
    expect(body.items.some(
      (item) => item.id === body.activeByKind[definition.kind]
        && item.kind === definition.kind
        && item.active,
    )).toBe(true);
  }
});

test('creates an append-only version and activates only an existing profile of the same kind', async () => {
  const definition = structuredClone(documentParseResearchConfigSchema.parse(
    defaultResearchConfigDefinitions.find((profile) => profile.kind === 'document_parse'),
  ));
  definition.version = `document-parse-research-${randomUUID()}`;
  definition.title = '문서 파싱 비교 실험';
  definition.description = '문서 파싱 요청 동시성을 낮춰 응답 안정성과 처리 시간을 비교하는 연구 프로필입니다.';
  definition.applyScope = '활성화 이후 새로 등록되는 교과서 파싱 작업과 문서 파싱 실험에만 적용됩니다.';
  definition.reprocessingImpact = '기존 교과서에는 소급 적용되지 않으며 비교하려면 해당 교과서를 새 프로필로 다시 처리해야 합니다.';
  definition.settings.pageConcurrency = 2;

  const created = await createProfileRoute(new Request(
    'http://localhost/api/settings/research-profiles',
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(definition),
    },
  ));
  expect(created.status).toBe(201);
  const createdBody = await created.json() as {
    item:{ id:string; kind:string; version:string; contentHash:string; active:boolean };
  };
  expect(createdBody.item).toMatchObject({
    kind:'document_parse',
    version:definition.version,
    contentHash:hashResearchConfigDefinition(definition),
    active:false,
  });

  const activated = await activateProfileRoute(new Request(
    'http://localhost/api/settings/research-profiles',
    {
      method:'PATCH',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ kind:'document_parse', profileId:createdBody.item.id }),
    },
  ));
  expect(activated.status).toBe(200);
  expect(await activated.json()).toMatchObject({
    active:{ kind:'document_parse', profileId:createdBody.item.id },
  });

  await expect(db.query(
    `update research_config_profiles set title='변조' where id=$1`,
    [createdBody.item.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    'delete from research_config_profiles where id=$1',
    [createdBody.item.id],
  )).rejects.toMatchObject({ code:'55000' });

  const embedding = await db.query<{ id:string }>(
    `select id from research_config_profiles where kind='embedding_rag' limit 1`,
  );
  const mismatch = await activateProfileRoute(new Request(
    'http://localhost/api/settings/research-profiles',
    {
      method:'PATCH',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ kind:'document_parse', profileId:embedding.rows[0]!.id }),
    },
  ));
  expect(mismatch.status).toBe(404);
});

test('strict API validation rejects secrets, unknown fields, and invalid activation identifiers', async () => {
  const definition = structuredClone(defaultResearchConfigDefinitions[1]) as Record<string, unknown>;
  definition.version = `secret-${randomUUID()}`;
  definition.apiKey = 'must-not-be-stored';
  const secret = await createProfileRoute(new Request(
    'http://localhost/api/settings/research-profiles',
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(definition),
    },
  ));
  expect(secret.status).toBe(400);

  const invalidActivation = await activateProfileRoute(new Request(
    'http://localhost/api/settings/research-profiles',
    {
      method:'PATCH',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ kind:'embedding_rag', profileId:'not-a-uuid' }),
    },
  ));
  expect(invalidActivation.status).toBe(400);
});

test('0020 upgrades an existing 0019 schema without changing pre-existing application rows', async () => {
  const schema = `research_config_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!/^research_config_upgrade_[a-f0-9]+$/.test(schema)) {
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
    for (const migration of migrations.filter((file) => file < '0020_')) {
      await client.query(await readFile(path.join(migrationDirectory, migration), 'utf8'));
    }

    const existing = await client.query<{ id:string }>(
      `insert into provider_configs(provider_key,display_name,protocol,config)
       values($1,'업그레이드 보존','gemini','{}'::jsonb) returning id`,
      [`preserved-${randomUUID()}`],
    );
    const migration = migrations.find((file) => file.startsWith('0020_'));
    expect(migration).toBeTruthy();
    await client.query(
      await readFile(path.join(migrationDirectory, migration!), 'utf8'),
    );

    const invalidDefinition = {
      ...structuredClone(defaultResearchConfigDefinitions.find(
        (profile) => profile.kind === 'embedding_rag',
      )!),
      schemaVersion:'1',
      version:`invalid-schema-type-${randomUUID()}`,
    };
    await expect(client.query(
      `insert into research_config_profiles(
         kind,version,title,definition,content_hash
       ) values('embedding_rag',$1,$2,$3::jsonb,null)`,
      [
        invalidDefinition.version,
        invalidDefinition.title,
        JSON.stringify(invalidDefinition),
      ],
    )).rejects.toMatchObject({ code:'23514' });
    const invalidDimensions = {
      ...structuredClone(embeddingRagResearchConfigSchema.parse(
        defaultResearchConfigDefinitions.find((profile) => profile.kind === 'embedding_rag'),
      )),
      version:`invalid-dimension-type-${randomUUID()}`,
    };
    invalidDimensions.settings.dimensions = '3072' as unknown as 3072;
    await expect(client.query(
      `insert into research_config_profiles(
         kind,version,title,definition,content_hash
       ) values('embedding_rag',$1,$2,$3::jsonb,null)`,
      [
        invalidDimensions.version,
        invalidDimensions.title,
        JSON.stringify(invalidDimensions),
      ],
    )).rejects.toMatchObject({ code:'23514' });

    const preserved = await client.query<{ count:string }>(
      'select count(*)::text count from provider_configs where id=$1',
      [existing.rows[0]!.id],
    );
    const seeded = await client.query<{ versions:string[] }>(
      `select array_agg(profile.version order by active.kind) versions
       from research_config_active_profiles active
       join research_config_profiles profile on profile.id=active.profile_id`,
    );
    expect(preserved.rows[0]?.count).toBe('1');
    expect(seeded.rows[0]?.versions).toEqual([
      'benchmark-models-core-v1',
      'document-parse-upstage-v1',
      'embedding-rag-gemini-3072-v1',
      'question-generation-gemini-3.5-flash-v1',
    ]);
  } finally {
    await client.query('reset search_path');
    await client.query(`drop schema if exists "${schema}" cascade`);
    client.release();
  }
});
