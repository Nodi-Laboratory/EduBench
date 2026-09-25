-- Keep every previous profile immutable for historical provenance. Future
-- generation and benchmark runs use Google's stable Gemini 3.5 Flash ID.

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000005'
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000011',
  'question_generation',
  'question-generation-gemini-3.5-flash-v2',
  'Gemini 3.5 Flash 문항 생성 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          base.definition,
          '{version}',
          to_jsonb('question-generation-gemini-3.5-flash-v2'::text)
        ),
        '{title}',
        to_jsonb('Gemini 3.5 Flash 문항 생성 기본값'::text)
      ),
      '{description}',
      to_jsonb(
        'Gemini 3.5 Flash의 구조화 출력과 고수준 사고를 사용해 각 문항의 방향 생성·근거 검색·문항 생성을 독립적으로 수행합니다.'::text
      )
    ),
    '{settings,model}',
    to_jsonb('gemini-3.5-flash'::text)
  ),
  null
from base
on conflict do nothing;

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000010'
),
updated_models as (
  select jsonb_agg(
    case
      when model->>'providerKey'='gemini' then
        jsonb_set(
          jsonb_set(
            model,
            '{displayName}',
            to_jsonb('Gemini 3.5 Flash'::text)
          ),
          '{modelId}',
          to_jsonb('gemini-3.5-flash'::text)
        )
      else model
    end
    order by ordinal
  ) models
  from base,
       jsonb_array_elements(base.definition #> '{settings,models}')
         with ordinality item(model,ordinal)
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000012',
  'benchmark_models',
  'benchmark-models-core-v6',
  'Gemini·Solar·K-EXAONE·OpenAI 비교 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          base.definition,
          '{version}',
          to_jsonb('benchmark-models-core-v6'::text)
        ),
        '{title}',
        to_jsonb('Gemini·Solar·K-EXAONE·OpenAI 비교 기본값'::text)
      ),
      '{description}',
      to_jsonb(
        '동일한 데이터셋을 Gemini 3.5 Flash, Upstage Solar Pro 3, K-EXAONE 236B A23B, OpenAI GPT-5.5 일반 모델 별칭으로 비교합니다.'::text
      )
    ),
    '{settings,models}',
    updated_models.models
  ),
  null
from base cross join updated_models
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000011',
    activated_at=now()
where kind='question_generation'
  and profile_id='30000000-0000-0000-0000-000000000005';

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000012',
    activated_at=now()
where kind='benchmark_models'
  and profile_id='30000000-0000-0000-0000-000000000010';

update provider_configs
set model_id='gemini-3.5-flash',
    updated_at=now()
where provider_key='gemini'
  and model_id='gemini-3.6-flash';
