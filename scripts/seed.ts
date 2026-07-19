import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';

const isEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

export async function seedDatabase(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`
      insert into provider_configs(provider_key, display_name, protocol, base_url, model_id, config)
      values
        ('exaone', 'EXAONE', 'openai-compatible', null, 'configured-via-env', '{"sample_data":true}'),
        ('gemini', 'Gemini', 'gemini', 'https://generativelanguage.googleapis.com', 'configured-via-env', '{"sample_data":true}'),
        ('claude', 'Claude', 'anthropic', 'https://api.anthropic.com', 'configured-via-env', '{"sample_data":true}'),
        ('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1', 'configured-via-env', '{"sample_data":true}'),
        ('upstage', 'Upstage', 'openai-compatible', 'https://api.upstage.ai/v1', 'configured-via-env', '{"sample_data":true}'),
        ('midm', 'KT Mi:dm', 'openai-compatible', null, 'configured-via-env', '{"sample_data":true}')
      on conflict(provider_key) do update set
        display_name = excluded.display_name,
        protocol = excluded.protocol,
        base_url = excluded.base_url,
        updated_at = now()
    `);

    await client.query(`
      insert into score_profiles(id, version, title, metrics, rubric_prompt, judge_provider, judge_model, content_hash)
      values (
        '20000000-0000-0000-0000-000000000001',
        'score-v1',
        'EduBench 교육 적합성 기본 프로필',
        '["accuracy","faithfulness","completeness","curriculum_alignment","student_fit","misconception","hallucination"]',
        '모델 식별자를 보지 않고 원자 채점 기준별로 절대평가한다.',
        'gemini',
        'configured-via-env',
        encode(digest('edubench-score-profile-v1', 'sha256'), 'hex')
      ) on conflict(version) do update set judge_provider=excluded.judge_provider, judge_model=excluded.judge_model
    `);

    await client.query(`
      insert into questions(
        id, public_id, status, subject, grade, unit, purpose, difficulty,
        question_type, evidence_mode, current_revision, generator_provider,
        generator_model, embedding_model
      )
      select
        md5('sample-question-' || n)::uuid,
        'SAMPLE-Q-' || lpad(n::text, 3, '0'),
        'APPROVED',
        case when n % 3 = 0 then '과학' when n % 3 = 1 then '수학' else '사회' end,
        case when n % 3 = 0 then '중학교 2학년' when n % 3 = 1 then '중학교 1학년' else '중학교 3학년' end,
        '샘플 단원 ' || (((n - 1) % 12) + 1),
        case
          when n <= 150 then '핵심 개념 이해'
          when n <= 270 then '개념 적용·문제풀이'
          when n <= 350 then '여러 단원 연결 추론'
          when n <= 430 then '학생 수준별 설명'
          else '오개념·잘못된 주장 교정'
        end,
        case when n % 3 = 0 then '상' when n % 3 = 1 then '중' else '하' end,
        case
          when n <= 100 then '객관식'
          when n <= 200 then '단답형'
          when n <= 400 then '구조화 서술형'
          when n <= 460 then '학생 설명형'
          else '교정·범위 판단형'
        end,
        case when n <= 400 then 'GROUNDED' when n <= 475 then 'CLOSED_BOOK' else 'INSUFFICIENT_EVIDENCE' end,
        1,
        'sample',
        'sample-generator',
        'sample-embedding'
      from generate_series(1, 500) as n
      on conflict(public_id) do update set updated_at = now()
    `);

    await client.query(`
      insert into question_revisions(
        id, question_id, revision, question_text, answer_text, answer_options,
        scoring_criteria, accepted_answers, design_summary, evidence_summary,
        quality_scores, change_reason
      )
      select
        md5('sample-question-revision-' || n)::uuid,
        md5('sample-question-' || n)::uuid,
        1,
        '[샘플 문항 ' || n || '] 실제 교과서 자료를 등록하면 승인된 문항으로 교체됩니다.',
        case when n <= 100 then chr(65 + ((n - 1) % 4)) else '샘플 모범 답안 ' || n end,
        case when n <= 100 then '["A","B","C","D"]'::jsonb else null end,
        jsonb_build_array(
          jsonb_build_object('key','concept','label','핵심 개념','maxScore',1),
          jsonb_build_object('key','reasoning','label','설명 완결성','maxScore',1)
        ),
        jsonb_build_array(case when n <= 100 then chr(65 + ((n - 1) % 4)) else '샘플 모범 답안 ' || n end),
        '화면과 실행 흐름 검증을 위한 샘플 문항',
        '실제 교과서 근거가 아니며 공식 결과에 사용할 수 없음',
        '{"sample_data":true}'::jsonb,
        'deterministic seed'
      from generate_series(1, 500) as n
      on conflict(question_id, revision) do update set
        answer_text = excluded.answer_text,
        answer_options = excluded.answer_options,
        accepted_answers = excluded.accepted_answers
    `);

    await client.query(`
      insert into dataset_versions(
        id, version, status, title, description, question_count, distribution,
        content_hash, published_at
      ) values (
        '10000000-0000-0000-0000-000000000001',
        'sample-v1.0.0',
        'DRAFT',
        '샘플 500문항 데이터셋',
        '기능 검증 전용이며 공식 결과에 사용할 수 없습니다.',
        500,
        '{"sample_data":true,"capabilities":{"core":150,"application":120,"cross_unit":80,"student":80,"correction":70},"evidence_modes":{"grounded":400,"closed_book":75,"insufficient_evidence":25}}',
        encode(digest('edubench-sample-dataset-v1', 'sha256'), 'hex'),
        now()
      ) on conflict(version) do nothing
    `);

    await client.query(`
      insert into dataset_questions(dataset_version_id, question_id, question_revision, ordinal)
      select
        '10000000-0000-0000-0000-000000000001',
        md5('sample-question-' || n)::uuid,
        1,
        n
      from generate_series(1, 500) as n
      join dataset_versions dv on dv.id = '10000000-0000-0000-0000-000000000001' and dv.status = 'DRAFT'
      on conflict(dataset_version_id, question_id) do nothing
    `);

    await client.query(`
      update dataset_versions set status = 'PUBLISHED', published_at = now()
      where id = '10000000-0000-0000-0000-000000000001' and status = 'DRAFT'
    `);

    await client.query(`
      insert into benchmark_runs(
        id, public_id, title, state, dataset_version_id, score_profile_id,
        price_profile_version, system_prompt, parameters, total_items
      ) values (
        '30000000-0000-0000-0000-000000000001',
        'SAMPLE-RUN-001',
        '샘플 실행 — 공식 결과 사용 금지',
        'PAUSED',
        '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001',
        'sample-price-v1',
        '승인된 근거만 사용하고 요구한 형식으로 답한다.',
        '{"sample_data":true,"warning":"공식 결과 사용 금지"}',
        3000
      ) on conflict(public_id) do update set updated_at = now()
    `);

    const providers = [
      ['40000000-0000-0000-0000-000000000001', 'exaone', 'EXAONE', 'M01', 'openai-compatible'],
      ['40000000-0000-0000-0000-000000000002', 'gemini', 'Gemini', 'M02', 'gemini'],
      ['40000000-0000-0000-0000-000000000003', 'claude', 'Claude', 'M03', 'anthropic'],
      ['40000000-0000-0000-0000-000000000004', 'openai', 'OpenAI', 'M04', 'openai-responses'],
      ['40000000-0000-0000-0000-000000000005', 'upstage', 'Upstage', 'M05', 'openai-compatible'],
      ['40000000-0000-0000-0000-000000000006', 'midm', 'KT Mi:dm', 'M06', 'openai-compatible'],
    ] as const;

    for (const [id, providerKey, displayName, blindId, protocol] of providers) {
      await client.query(
        `insert into run_models(
           id, benchmark_run_id, provider_key, display_name, blind_id, model_id,
           protocol, parameters, concurrency, request_interval_ms
         ) values ($1, '30000000-0000-0000-0000-000000000001', $2, $3, $4,
           'configured-via-env', $5, '{"sample_data":true}', 1, 0)
         on conflict(benchmark_run_id, provider_key) do nothing`,
        [id, providerKey, displayName, blindId, protocol],
      );
    }

    await client.query(`
      insert into run_items(
        id, benchmark_run_id, run_model_id, question_id, question_revision,
        state, idempotency_key
      )
      select
        md5('sample-run-item-' || rm.id || '-' || n)::uuid,
        '30000000-0000-0000-0000-000000000001',
        rm.id,
        md5('sample-question-' || n)::uuid,
        1,
        'PENDING',
        'sample-run-001:' || rm.provider_key || ':' || n
      from run_models rm
      cross join generate_series(1, 500) as n
      where rm.benchmark_run_id = '30000000-0000-0000-0000-000000000001'
      on conflict(idempotency_key) do nothing
    `);
  });
}

if (isEntrypoint) {
  seedDatabase()
    .then(async () => {
      console.log('Seeded deterministic EduBench sample workspace.');
      await db.end();
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await db.end();
      process.exitCode = 1;
    });
}
