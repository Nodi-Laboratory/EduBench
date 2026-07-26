-- Append-only runtime presets verified against the providers' current public
-- model identifiers. Existing executions retain their original snapshots.

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000003'
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000005',
  'question_generation',
  'question-generation-gemini-3.6-flash-v1',
  'Gemini 3.6 Flash 문항 생성 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          definition,
          '{version}',
          to_jsonb('question-generation-gemini-3.6-flash-v1'::text)
        ),
        '{title}',
        to_jsonb('Gemini 3.6 Flash 문항 생성 기본값'::text)
      ),
      '{description}',
      to_jsonb(
        'Gemini 3.6 Flash의 구조화 출력과 고수준 사고를 사용해 각 문항의 방향 생성·근거 검색·문항 생성을 독립적으로 수행합니다.'::text
      )
    ),
    '{settings,model}',
    to_jsonb('gemini-3.6-flash'::text)
  ),
  null
from base
on conflict do nothing;

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000004'
),
updated_models as (
  select jsonb_agg(
    case
      when model->>'providerKey'='gemini' then
        jsonb_set(
          jsonb_set(
            model,
            '{displayName}',
            to_jsonb('Gemini 3.6 Flash'::text)
          ),
          '{modelId}',
          to_jsonb('gemini-3.6-flash'::text)
        )
      else model
    end
    order by ordinal
  ) models
  from base,
    jsonb_array_elements(definition #> '{settings,models}')
      with ordinality as item(model,ordinal)
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000006',
  'benchmark_models',
  'benchmark-models-core-v2',
  'Gemini 3.6·Solar Pro 3·K-EXAONE 비교 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          base.definition,
          '{version}',
          to_jsonb('benchmark-models-core-v2'::text)
        ),
        '{title}',
        to_jsonb(
          'Gemini 3.6·Solar Pro 3·K-EXAONE 비교 기본값'::text
        )
      ),
      '{description}',
      to_jsonb(
        '동일한 데이터셋을 Gemini 3.6 Flash, Upstage Solar Pro 3, K-EXAONE 236B A23B의 고정 모델 식별자와 재현 가능한 생성 파라미터로 비교합니다.'::text
      )
    ),
    '{settings,models}',
    updated_models.models
  ),
  null
from base cross join updated_models
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000005',
    activated_at=now()
where kind='question_generation';

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000006',
    activated_at=now()
where kind='benchmark_models';

insert into score_profiles(
  id,version,title,metrics,weights,rubric_prompt,judge_provider,judge_model
)
values(
  '20000000-0000-0000-0000-000000000002',
  'score-v2-gemini-3.5-flash',
  'EduBench 선수관계 평가 · Gemini 3.5 Flash Judge',
  '[
    "accuracy",
    "faithfulness",
    "completeness",
    "curriculum_alignment",
    "student_fit",
    "misconception",
    "hallucination"
  ]'::jsonb,
  '{"response_present":0}'::jsonb,
  '모델 식별자를 보지 않고 문항 청사진, 교과서 근거, 원자 채점 기준으로 절대평가한다.',
  'gemini',
  'gemini-3.5-flash'
)
on conflict do nothing;

create or replace function prevent_run_model_execution_spec_change()
returns trigger
language plpgsql
as $$
begin
  if new.provider_key is distinct from old.provider_key
     or new.display_name is distinct from old.display_name
     or new.blind_id is distinct from old.blind_id
     or new.model_id is distinct from old.model_id
     or new.protocol is distinct from old.protocol
     or new.parameters is distinct from old.parameters
     or new.concurrency is distinct from old.concurrency
     or new.request_interval_ms is distinct from old.request_interval_ms then
    raise exception 'a benchmark run model execution specification is immutable'
      using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger run_models_execution_spec_immutable
before update of
  provider_key,
  display_name,
  blind_id,
  model_id,
  protocol,
  parameters,
  concurrency,
  request_interval_ms
on run_models
for each row execute function prevent_run_model_execution_spec_change();
