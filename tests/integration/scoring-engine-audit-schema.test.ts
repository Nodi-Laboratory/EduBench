import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { currentScoringEngineDefinition } from '@/domain/scoring-engine';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';

type Fixture = {
  runId: string;
  responseId: string;
  profileId: string;
  engineId: string;
};

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const dataset = await db.query<{ id:string }>(
    `insert into dataset_versions(
       version,status,title,question_count,distribution,content_hash
     ) values($1,'PUBLISHED','점수 감사 테스트',1,'{}'::jsonb,$2)
     returning id`,
    [`score-audit-dataset-${suffix}`, `score-audit-dataset-${suffix}`],
  );
  const profile = await db.query<{ id:string }>(
    `insert into score_profiles(
       version,title,metrics,weights,rubric_prompt,judge_provider,
       judge_model,content_hash
     ) values(
       $1,'점수 감사 프로필','["accuracy","faithfulness"]'::jsonb,
       '{}'::jsonb,'정확히 채점한다.','gemini','judge-v1','temporary'
     )
     returning id`,
    [`score-audit-profile-${suffix}`],
  );
  const question = await db.query<{ id:string }>(
    `insert into questions(
       public_id,status,subject,grade,purpose,difficulty,question_type,evidence_mode
     ) values($1,'APPROVED','과학','중학교','선수관계','중','short_answer','closed_book')
     returning id`,
    [`SCORE-AUDIT-Q-${suffix}`],
  );
  await db.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,scoring_criteria
     ) values($1,1,'질문','답','[]'::jsonb)`,
    [question.rows[0]!.id],
  );
  const run = await db.query<{
    id:string;
    scoring_engine_version_id:string;
  }>(
    `insert into benchmark_runs(
       public_id,title,dataset_version_id,score_profile_id,price_profile_version,
       system_prompt,parameters
     ) values($1,'점수 감사 실행',$2,$3,'test-price-v1','답하라.','{}'::jsonb)
     returning id,scoring_engine_version_id`,
    [`SCORE-AUDIT-RUN-${suffix}`, dataset.rows[0]!.id, profile.rows[0]!.id],
  );
  const model = await db.query<{ id:string }>(
    `insert into run_models(
       benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
     ) values($1,'gemini','Gemini','M01','candidate-v1','gemini')
     returning id`,
    [run.rows[0]!.id],
  );
  const item = await db.query<{ id:string }>(
    `insert into run_items(
       benchmark_run_id,run_model_id,question_id,question_revision,idempotency_key
     ) values($1,$2,$3,1,$4)
     returning id`,
    [run.rows[0]!.id, model.rows[0]!.id, question.rows[0]!.id, `score-audit-item-${suffix}`],
  );
  const response = await db.query<{ id:string }>(
    `insert into model_responses(
       run_item_id,attempt,model_id,response_text,normalized_text
     ) values($1,1,'candidate-v1','답','답')
     returning id`,
    [item.rows[0]!.id],
  );
  return {
    runId:run.rows[0]!.id,
    responseId:response.rows[0]!.id,
    profileId:profile.rows[0]!.id,
    engineId:run.rows[0]!.scoring_engine_version_id,
  };
}

test('seeds the exact current scoring rules and keeps engine definitions append-only', async () => {
  const current = await db.query<{
    id:string;
    version:string;
    definition:Record<string, unknown>;
    content_hash:string;
  }>(
    `select engine.id,engine.version,engine.definition,engine.content_hash
     from scoring_engine_registry registry
     join scoring_engine_versions engine
       on engine.id=registry.current_engine_version_id
     where registry.singleton=true`,
  );
  expect(current.rows).toHaveLength(1);
  expect(current.rows[0]!.definition).toEqual(
    currentScoringEngineDefinition,
  );
  expect(current.rows[0]).toMatchObject({
    version:'edubench-scoring-v2',
    definition:{
      version:'edubench-scoring-v2',
      deterministic:{
        responsePresent:{ implementationVersion:'normalized-response-present-v1' },
      },
      metricResolution:{
        implementationVersion:'required-metrics-v2',
        baseMetrics:['response_present'],
        profileMetrics:'discard retired exact_match, then append score profile metrics in stored order and deduplicate by first occurrence',
        prerequisiteBenchmarkType:'PREREQUISITE_RELATIONSHIP',
        prerequisiteMetrics:[
          'target_concept_correctness',
          'prerequisite_identification',
          'prerequisite_relation_accuracy',
          'prerequisite_application',
          'reasoning_chain_completeness',
          'textbook_grounding',
        ],
      },
      judge:{
        systemPrompt:'EDUBENCH_JUDGE_JSON. 지정된 metricKey만 빠짐없이 채점한다. 모델 이름을 보지 말고 제공된 루브릭과 교과서 근거만으로 절대평가한다.',
        sampling:{ temperature:0, maxOutputTokens:8192 },
        batching:{
          implementationVersion:'all-required-metrics-then-single-metric-fallback-v1',
        },
        parser:{
          implementationVersion:'first-last-json-object-zod-v1',
          metricSelection:'primary and fallback responses both require exact metricKey matches; mismatched keys are unresolved',
        },
        outputSchema:{
          type:'object',
          required:['scores'],
          properties:{
            scores:{
              type:'array',
              items:{
                type:'object',
                required:['metricKey','value','label','rationale'],
                properties:{
                  value:{
                    type:['number','numeric string'],
                    minimum:0,
                    maximum:1,
                  },
                },
              },
            },
          },
        },
      },
      prerequisiteMetricRubrics:{
        prerequisite_identification:'benchmarkDesign.prerequisiteConcepts와 비교한다. 1은 필요한 선수 개념을 모두 명시하거나 의미상 분명히 사용, 0.5는 일부만 사용, 0은 식별하지 못한 경우다.',
        prerequisite_relation_accuracy:'선수→목표 관계의 방향과 이유를 평가한다. 방향 반전이나 단순 연관성 진술은 0, 방향은 맞지만 이유가 불완전하면 0.5다.',
        reasoning_chain_completeness:'benchmarkDesign.requiredReasoningSteps와 비교한다. 모든 필수 단계를 논리적으로 연결하면 1, 핵심 중간 단계 하나 누락은 0.5, 결론만 제시하면 0이다.',
      },
    },
  });
  const digest = await db.query<{ expected:string }>(
    `select encode(digest($1::jsonb::text,'sha256'),'hex') expected`,
    [current.rows[0]!.definition],
  );
  expect(current.rows[0]!.content_hash).toBe(digest.rows[0]!.expected);
  expect(current.rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(current.rows[0]!.definition.deterministic)
    .not.toHaveProperty('exactMatch');
  const historical = await db.query<{ version:string }>(
    `select version from scoring_engine_versions
     where version='edubench-scoring-v1'`,
  );
  expect(historical.rows).toEqual([{ version:'edubench-scoring-v1' }]);
  expect(
    (current.rows[0]!.definition.judge as {
      sampling:Record<string, unknown>;
    }).sampling,
  ).not.toHaveProperty('currentEnvironmentOverride');

  await expect(db.query(
    `update scoring_engine_versions set title='변조' where id=$1`,
    [current.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    'delete from scoring_engine_versions where id=$1',
    [current.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
});

test('pins a verified immutable scoring-engine snapshot on every post-migration run', async () => {
  const fixture = await createFixture();
  const stored = await db.query<{
    scoring_engine_version_id:string;
    scoring_engine_snapshot:Record<string, unknown>;
    scoring_engine_snapshot_provenance:string;
  }>(
    `select scoring_engine_version_id,scoring_engine_snapshot,
       scoring_engine_snapshot_provenance
     from benchmark_runs where id=$1`,
    [fixture.runId],
  );
  expect(stored.rows[0]).toMatchObject({
    scoring_engine_version_id:fixture.engineId,
    scoring_engine_snapshot:{
      id:fixture.engineId,
      version:'edubench-scoring-v2',
      contentHash:expect.stringMatching(/^[0-9a-f]{64}$/),
    },
    scoring_engine_snapshot_provenance:'AT_CREATION_VERIFIED',
  });

  await expect(db.query(
    `update benchmark_runs
     set scoring_engine_snapshot=jsonb_set(
       scoring_engine_snapshot,'{title}','"변조"'::jsonb
     )
     where id=$1`,
    [fixture.runId],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update benchmark_runs
     set scoring_engine_snapshot_provenance='LEGACY_BACKFILL_UNVERIFIED'
     where id=$1`,
    [fixture.runId],
  )).rejects.toMatchObject({ code:'55000' });
});

test('enforces the durable Judge invocation lifecycle and verified score linkage', async () => {
  const fixture = await createFixture();
  await expect(db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,provenance
     ) values($1,$2,'legacy_probe',1,'LEGACY_UNVERIFIED')`,
    [fixture.responseId, fixture.profileId],
  )).rejects.toMatchObject({ code:'23514' });

  await expect(db.query(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,requested_metric_keys,request_snapshot,
       provider_key,model_id
     ) values(
       $1,$2,$3,$4,'PRIMARY',1,'wrong-judge',
       'judge-wrong-'||gen_random_uuid(),array['accuracy'],
       '{"prompt":"wrong"}'::jsonb,'gemini','different-judge'
     )`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId],
  )).rejects.toMatchObject({ code:'23514' });

  const invocation = await db.query<{ id:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,requested_metric_keys,request_snapshot,
       provider_key,model_id
     ) values(
       $1,$2,$3,$4,'PRIMARY',1,'accuracy','judge-audit-'||gen_random_uuid(),
       array['accuracy'],jsonb_build_object('system','judge','prompt','payload'),
       'gemini','judge-v1'
     )
     returning id`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId],
  );

  await expect(db.query(
    `update judge_invocations
     set state='PARSED',parsed_response='{"scores":[]}'::jsonb,
       parsed_at=now(),resolved_metric_keys=array['accuracy']
     where id=$1`,
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });

  await db.query(
    `update judge_invocations
     set state='RESPONSE_RECEIVED',
       raw_response='{"candidates":[]}'::jsonb,
       response_text='{"scores":[{"metricKey":"accuracy","value":1}]}',
       provider_request_id='provider-request-1',
       response_model_id='judge-v1',
       response_model_snapshot='judge-snapshot-v1',
       finish_reason='STOP',
       input_tokens=10,output_tokens=20,latency_ms=30,
       response_received_at=now()
     where id=$1`,
    [invocation.rows[0]!.id],
  );
  await expect(db.query(
    `update judge_invocations
     set state='PARSED',
       parsed_response='{"scores":[{"metricKey":"accuracy","value":1}]}'::jsonb,
       resolved_metric_keys=array['accuracy'],
       missing_metric_keys=array[]::text[],
       parsed_at=now(),latency_ms=31
     where id=$1`,
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update judge_invocations
     set state='PARSED',
       resolved_metric_keys=array['accuracy'],
       missing_metric_keys=array[]::text[],
       parsed_at=now()
     where id=$1`,
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'23514' });
  await db.query(
    `update judge_invocations
     set state='PARSED',
       parsed_response='{"scores":[{"metricKey":"accuracy","value":1}]}'::jsonb,
       resolved_metric_keys=array['accuracy'],
       missing_metric_keys=array[]::text[],
       parsed_at=now()
     where id=$1`,
    [invocation.rows[0]!.id],
  );
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,rationale,
       judge_provider,judge_model,judge_request_id,judge_invocation_id,provenance
     ) values(
       $1,$2,'accuracy',1,'PASS','정확함',
       'gemini','judge-v1','provider-request-1',$3,
       'JUDGE_INVOCATION_VERIFIED'
     )`,
    [fixture.responseId, fixture.profileId, invocation.rows[0]!.id],
  );
  await db.query(
    `update judge_invocations
     set state='PERSISTED',persisted_at=now()
     where id=$1`,
    [invocation.rows[0]!.id],
  );
  const persisted = await db.query<{
    state:string;
    request_hash:string;
    score_provenance:string;
    response_model_id:string;
    response_model_snapshot:string;
    finish_reason:string;
    input_tokens:number;
    output_tokens:number;
    latency_ms:number;
  }>(
    `select invocation.state,invocation.request_hash,
       score.provenance score_provenance,
       invocation.response_model_id,
       invocation.response_model_snapshot,
       invocation.finish_reason,
       invocation.input_tokens,
       invocation.output_tokens,
       invocation.latency_ms
     from judge_invocations invocation
     join scores score on score.judge_invocation_id=invocation.id
     where invocation.id=$1`,
    [invocation.rows[0]!.id],
  );
  expect(persisted.rows[0]).toMatchObject({
    state:'PERSISTED',
    request_hash:expect.stringMatching(/^[0-9a-f]{64}$/),
    score_provenance:'JUDGE_INVOCATION_VERIFIED',
    response_model_id:'judge-v1',
    response_model_snapshot:'judge-snapshot-v1',
    finish_reason:'STOP',
    input_tokens:10,
    output_tokens:20,
    latency_ms:30,
  });
  await expect(db.query(
    `update judge_invocations set error_message='사후 변조' where id=$1`,
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    `update scores set rationale='사후 수정' where judge_invocation_id=$1`,
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    'delete from scores where judge_invocation_id=$1',
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });
  await expect(db.query(
    'delete from judge_invocations where id=$1',
    [invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'55000' });

  await expect(db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,
       judge_provider,judge_model,judge_invocation_id,provenance
     ) values(
       $1,$2,'other_metric',1,'gemini','judge-v1',$3,
       'JUDGE_INVOCATION_VERIFIED'
     )`,
    [fixture.responseId, fixture.profileId, invocation.rows[0]!.id],
  )).rejects.toMatchObject({ code:'23514' });
});

test('allows a one-metric fallback only from a persisted primary invocation', async () => {
  const fixture = await createFixture();
  const primary = await db.query<{ id:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,invocation_kind,attempt,logical_key,
       idempotency_key,requested_metric_keys,request_snapshot,
       provider_key,model_id
     ) values(
       $1,$2,$3,$4,'PRIMARY',1,'accuracy+faithfulness',
       'judge-primary-'||gen_random_uuid(),
       array['accuracy','faithfulness'],
       '{"prompt":"primary"}'::jsonb,'gemini','judge-v1'
     ) returning id`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId],
  );
  await expect(db.query(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,parent_invocation_id,invocation_kind,
       attempt,logical_key,idempotency_key,requested_metric_keys,
       request_snapshot,provider_key,model_id
     ) values(
       $1,$2,$3,$4,$5,'FALLBACK',1,'faithfulness',
       'judge-fallback-early-'||gen_random_uuid(),array['faithfulness'],
       '{"prompt":"fallback"}'::jsonb,'gemini','judge-v1'
     )`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId, primary.rows[0]!.id],
  )).rejects.toMatchObject({ code:'23514' });

  await db.query(
    `update judge_invocations set
       state='RESPONSE_RECEIVED',raw_response='{}'::jsonb,
       response_text='{"scores":[{"metricKey":"accuracy","value":1}]}',
       response_model_id='judge-v1',latency_ms=1,
       response_received_at=now()
     where id=$1`,
    [primary.rows[0]!.id],
  );
  await db.query(
    `update judge_invocations set
       state='PARSED',
       parsed_response='{"scores":[{"metricKey":"accuracy","value":1}]}'::jsonb,
       resolved_metric_keys=array['accuracy'],
       missing_metric_keys=array['faithfulness'],parsed_at=now()
     where id=$1`,
    [primary.rows[0]!.id],
  );
  await expect(db.query(
    `update judge_invocations set state='PERSISTED',persisted_at=now()
     where id=$1`,
    [primary.rows[0]!.id],
  )).rejects.toMatchObject({ code:'23514' });
  await db.query(
    `insert into scores(
       model_response_id,score_profile_id,metric_key,value,label,rationale,
       judge_provider,judge_model,judge_invocation_id,provenance
     ) values(
       $1,$2,'accuracy',1,'PASS','정확함',
       'gemini','judge-v1',$3,'JUDGE_INVOCATION_VERIFIED'
     )`,
    [fixture.responseId, fixture.profileId, primary.rows[0]!.id],
  );
  await db.query(
    `update judge_invocations set state='PERSISTED',persisted_at=now()
     where id=$1`,
    [primary.rows[0]!.id],
  );
  const fallback = await db.query<{ id:string; state:string }>(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,parent_invocation_id,invocation_kind,
       attempt,logical_key,idempotency_key,requested_metric_keys,
       request_snapshot,provider_key,model_id
     ) values(
       $1,$2,$3,$4,$5,'FALLBACK',1,'faithfulness',
       'judge-fallback-'||gen_random_uuid(),array['faithfulness'],
       '{"prompt":"fallback"}'::jsonb,'gemini','judge-v1'
     ) returning id,state`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId, primary.rows[0]!.id],
  );
  expect(fallback.rows[0]?.state).toBe('REQUESTED');

  await expect(db.query(
    `insert into judge_invocations(
       benchmark_run_id,model_response_id,score_profile_id,
       scoring_engine_version_id,parent_invocation_id,invocation_kind,
       attempt,logical_key,idempotency_key,requested_metric_keys,
       request_snapshot,provider_key,model_id
     ) values(
       $1,$2,$3,$4,$5,'FALLBACK',1,'two-metrics',
       'judge-fallback-wide-'||gen_random_uuid(),
       array['accuracy','faithfulness'],
       '{"prompt":"fallback"}'::jsonb,'gemini','judge-v1'
     )`,
    [fixture.runId, fixture.responseId, fixture.profileId, fixture.engineId, primary.rows[0]!.id],
  )).rejects.toMatchObject({ code:'23514' });
});

test('upgrades historical runs and scores as unverified without fabricating Judge calls', async () => {
  const schema = `scoring_audit_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!/^scoring_audit_upgrade_[a-f0-9]+$/.test(schema)) {
    throw new Error('unsafe temporary schema name');
  }
  const client = await db.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}",public`);
    await client.query(
      `create table schema_migrations(
         version text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const migrationDirectory = path.join(process.cwd(), 'db', 'migrations');
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations.filter((file) => file < '0019_')) {
      await client.query(await readFile(path.join(migrationDirectory, migration), 'utf8'));
      await client.query(
        'insert into schema_migrations(version) values($1)',
        [migration],
      );
    }

    const suffix = randomUUID();
    const dataset = await client.query<{ id:string }>(
      `insert into dataset_versions(
         version,status,title,question_count,distribution,content_hash
       ) values($1,'PUBLISHED','업그레이드 데이터셋',0,'{}'::jsonb,$2)
       returning id`,
      [`legacy-dataset-${suffix}`, `legacy-dataset-${suffix}`],
    );
    const profile = await client.query<{ id:string }>(
      `insert into score_profiles(
         version,title,metrics,weights,rubric_prompt,content_hash
       ) values($1,'레거시 프로필','["exact_match"]'::jsonb,'{}'::jsonb,'채점','temporary')
       returning id`,
      [`legacy-profile-${suffix}`],
    );
    const question = await client.query<{ id:string }>(
      `insert into questions(
         public_id,status,subject,grade,purpose,difficulty,question_type,evidence_mode
       ) values($1,'APPROVED','과학','중학교','선수관계','중','short_answer','closed_book')
       returning id`,
      [`LEGACY-Q-${suffix}`],
    );
    await client.query(
      `insert into question_revisions(
         question_id,revision,question_text,answer_text,scoring_criteria
       ) values($1,1,'질문','답','[]'::jsonb)`,
      [question.rows[0]!.id],
    );
    const run = await client.query<{ id:string }>(
      `insert into benchmark_runs(
         public_id,title,dataset_version_id,score_profile_id,
         price_profile_version,system_prompt,parameters
       ) values($1,'레거시 실행',$2,$3,'test-price-v1','답하라.','{}'::jsonb)
       returning id`,
      [`LEGACY-RUN-${suffix}`, dataset.rows[0]!.id, profile.rows[0]!.id],
    );
    const model = await client.query<{ id:string }>(
      `insert into run_models(
         benchmark_run_id,provider_key,display_name,blind_id,model_id,protocol
       ) values($1,'gemini','Gemini','M01','candidate-v1','gemini')
       returning id`,
      [run.rows[0]!.id],
    );
    const item = await client.query<{ id:string }>(
      `insert into run_items(
         benchmark_run_id,run_model_id,question_id,question_revision,idempotency_key
       ) values($1,$2,$3,1,$4)
       returning id`,
      [run.rows[0]!.id, model.rows[0]!.id, question.rows[0]!.id, `legacy-item-${suffix}`],
    );
    const response = await client.query<{ id:string }>(
      `insert into model_responses(
         run_item_id,attempt,model_id,response_text,normalized_text
       ) values($1,1,'candidate-v1','답','답')
       returning id`,
      [item.rows[0]!.id],
    );
    await client.query(
      `insert into scores(
         model_response_id,score_profile_id,metric_key,value
       ) values($1,$2,'exact_match',1)`,
      [response.rows[0]!.id, profile.rows[0]!.id],
    );

    const scoringMigration = migrations.find((file) => file.startsWith('0019_'));
    expect(scoringMigration).toBeTruthy();
    await client.query(
      await readFile(path.join(migrationDirectory, scoringMigration!), 'utf8'),
    );
    const upgraded = await client.query<{
      scoring_engine_version_id:string | null;
      scoring_engine_snapshot:unknown;
      scoring_engine_snapshot_provenance:string;
      score_provenance:string;
      judge_invocation_id:string | null;
      invocations:string;
    }>(
      `select run.scoring_engine_version_id,run.scoring_engine_snapshot,
         run.scoring_engine_snapshot_provenance,
         score.provenance score_provenance,
         score.judge_invocation_id,
         (select count(*) from judge_invocations)::text invocations
       from benchmark_runs run
       join run_items item on item.benchmark_run_id=run.id
       join model_responses response on response.run_item_id=item.id
       join scores score on score.model_response_id=response.id
       where run.id=$1`,
      [run.rows[0]!.id],
    );
    expect(upgraded.rows[0]).toEqual({
      scoring_engine_version_id:null,
      scoring_engine_snapshot:null,
      scoring_engine_snapshot_provenance:'LEGACY_BACKFILL_UNVERIFIED',
      score_provenance:'LEGACY_UNVERIFIED',
      judge_invocation_id:null,
      invocations:'0',
    });
  } finally {
    await client.query('reset search_path');
    await client.query(`drop schema if exists "${schema}" cascade`);
    client.release();
  }
});
