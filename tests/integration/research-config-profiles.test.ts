import { PROVIDER_KEYS_HEADER } from '@/server/providers/credentials';
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
  benchmarkGenerationParameters,
  defaultResearchConfigDefinitions,
  documentParseResearchConfigSchema,
  embeddingRagResearchConfigSchema,
  hashResearchConfigDefinition,
  type ResearchConfigDefinition,
} from '@/domain/research-config';
import { POST as createRunRoute } from '@/app/api/runs/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { createRealPublishedDataset } from './helpers/real-dataset';

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

test('database validation accepts legacy and OpenAI benchmark profiles but rejects an invalid OpenAI protocol', async () => {
  const current = defaultResearchConfigDefinitions.find(
    (profile) => profile.kind === 'benchmark_models',
  )!;
  const legacy = await db.query<{ definition:unknown }>(
    `select definition from research_config_profiles
     where version='benchmark-models-core-v2'`,
  );
  const invalidProtocol = structuredClone(current);
  const openai = invalidProtocol.settings.models.find(
    (model) => model.providerKey === 'openai',
  )!;
  openai.protocol = 'openai' as 'openai-responses';
  const duplicateOpenai = structuredClone(current);
  const duplicate = structuredClone(
    duplicateOpenai.settings.models.find(
      (model) => model.providerKey === 'openai',
    )!,
  );
  duplicateOpenai.settings.models[1] = duplicate;

  const result = await db.query<{
    legacy_valid:boolean;
    current_valid:boolean;
    invalid_protocol_valid:boolean;
    duplicate_openai_valid:boolean;
  }>(
    `select
       valid_research_config_definition_v2('benchmark_models',$1::jsonb)
         legacy_valid,
       valid_research_config_definition_v2('benchmark_models',$2::jsonb)
         current_valid,
       valid_research_config_definition_v2('benchmark_models',$3::jsonb)
         invalid_protocol_valid,
       valid_research_config_definition_v2('benchmark_models',$4::jsonb)
         duplicate_openai_valid`,
    [
      JSON.stringify(legacy.rows[0]!.definition),
      JSON.stringify(current),
      JSON.stringify(invalidProtocol),
      JSON.stringify(duplicateOpenai),
    ],
  );
  expect(result.rows[0]).toEqual({
    legacy_valid:true,
    current_valid:true,
    invalid_protocol_valid:false,
    duplicate_openai_valid:false,
  });
});

test('activates the immutable OpenAI GPT-5.5 benchmark profile', async () => {
  const active = await db.query<{
    version:string;
    definition: {
      settings: {
        models: Array<{
          providerKey:string;
          displayName:string;
          modelId:string;
          protocol:string;
        }>;
      };
    };
  }>(
    `select profile.version,profile.definition
       from research_config_active_profiles active
       join research_config_profiles profile on profile.id=active.profile_id
      where active.kind='benchmark_models'`,
  );
  const openai = active.rows[0]?.definition.settings.models.find(
    (model) => model.providerKey === 'openai',
  );
  const gemini = active.rows[0]?.definition.settings.models.find(
    (model) => model.providerKey === 'gemini',
  );

  expect(active.rows[0]?.version).toBe('benchmark-models-core-v6');
  expect(gemini).toMatchObject({
    displayName:'Gemini 3.5 Flash',
    modelId:'gemini-3.5-flash',
    protocol:'gemini',
  });
  expect(openai).toMatchObject({
    displayName:'OpenAI GPT-5.5',
    modelId:'gpt-5.5',
    protocol:'openai-responses',
  });
});

test('creates a real benchmark run from the active OpenAI model profile', async () => {
  const definition = defaultResearchConfigDefinitions.find(
    (profile) => profile.kind === 'benchmark_models',
  )!;
  const openai = definition.settings.models.find(
    (model) => model.providerKey === 'openai',
  )!;
  const datasetVersionId = await createRealPublishedDataset(1);
  const scoreProfile = await db.query<{ id:string }>(
    `select id from score_profiles order by created_at limit 1`,
  );
  const previousMock = process.env.MOCK_PROVIDERS;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.OPENAI_MODEL;
  process.env.MOCK_PROVIDERS = 'false';
  process.env.OPENAI_API_KEY = 'integration-openai-key';
  process.env.OPENAI_MODEL = openai.modelId;
  try {
    const response = await createRunRoute(new Request(
      'http://localhost/api/runs',
      {
        method:'POST',
        headers:{
          'content-type':'application/json',
          [PROVIDER_KEYS_HEADER]:Buffer.from(JSON.stringify({
            openai:'integration-openai-key',
            gemini:'integration-judge-key',
          })).toString('base64url'),
        },
        body:JSON.stringify({
          title:`OpenAI 프로필 실행 ${randomUUID().slice(0, 8)}`,
          datasetVersionId,
          scoreProfileId:scoreProfile.rows[0]!.id,
          priceProfileVersion:'integration-openai-price',
          systemPrompt:'교과서 근거에 따라 답하십시오.',
          questionLimit:1,
          models:[{
            providerKey:openai.providerKey,
            displayName:openai.displayName,
            modelId:openai.modelId,
            protocol:openai.protocol,
            parameters:benchmarkGenerationParameters(openai),
            concurrency:openai.concurrency,
            requestIntervalMs:openai.requestIntervalMs,
          }],
        }),
      },
    ));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      state:'DRAFT',
      totalItems:1,
    });
  } finally {
    if (previousMock == null) delete process.env.MOCK_PROVIDERS;
    else process.env.MOCK_PROVIDERS = previousMock;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousModel == null) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  }
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

test('0037 preserves operator-selected profiles and a custom Gemini provider model', async () => {
  const active = await db.query<{
    kind:'question_generation' | 'benchmark_models';
    profile_id:string;
  }>(
    `select kind,profile_id
       from research_config_active_profiles
      where kind in ('question_generation','benchmark_models')
      order by kind`,
  );
  const alternatives = await db.query<{
    kind:'question_generation' | 'benchmark_models';
    id:string;
  }>(
    `select distinct on(kind) kind,id
       from research_config_profiles
      where kind in ('question_generation','benchmark_models')
        and id not in (
          '30000000-0000-0000-0000-000000000005',
          '30000000-0000-0000-0000-000000000010',
          '30000000-0000-0000-0000-000000000011',
          '30000000-0000-0000-0000-000000000012'
        )
      order by kind,created_at`,
  );
  expect(alternatives.rows).toHaveLength(2);
  const previousProvider = await db.query<{
    model_id:string | null;
  }>(
    "select model_id from provider_configs where provider_key='gemini'",
  );
  try {
    for (const alternative of alternatives.rows) {
      await db.query(
        `update research_config_active_profiles
            set profile_id=$2,activated_at=now()
          where kind=$1`,
        [alternative.kind, alternative.id],
      );
    }
    await db.query(
      `insert into provider_configs(
         provider_key,display_name,protocol,model_id
       ) values('gemini','Gemini','gemini','operator-custom-gemini')
       on conflict(provider_key) do update set
         model_id=excluded.model_id,updated_at=now()`,
    );
    await db.query(await readFile(
      path.join(
        process.cwd(),
        'db',
        'migrations',
        '0037_gemini_3_5_profiles.sql',
      ),
      'utf8',
    ));
    const preservedActive = await db.query<{
      kind:string;
      profile_id:string;
    }>(
      `select kind,profile_id
         from research_config_active_profiles
        where kind in ('question_generation','benchmark_models')
        order by kind`,
    );
    expect(preservedActive.rows).toEqual(
      [...alternatives.rows].sort((left, right) =>
        left.kind.localeCompare(right.kind),
      ).map((profile) => ({
        kind:profile.kind,
        profile_id:profile.id,
      })),
    );
    const preservedProvider = await db.query<{ model_id:string }>(
      "select model_id from provider_configs where provider_key='gemini'",
    );
    expect(preservedProvider.rows[0]?.model_id)
      .toBe('operator-custom-gemini');
  } finally {
    for (const previous of active.rows) {
      await db.query(
        `update research_config_active_profiles
            set profile_id=$2,activated_at=now()
          where kind=$1`,
        [previous.kind, previous.profile_id],
      );
    }
    if (previousProvider.rows[0]) {
      await db.query(
        `update provider_configs set model_id=$1,updated_at=now()
          where provider_key='gemini'`,
        [previousProvider.rows[0].model_id],
      );
    } else {
      await db.query(
        "delete from provider_configs where provider_key='gemini'",
      );
    }
  }
});
