-- Preserve the pinned Nano profile for historical run provenance and activate
-- the user-selected moving GPT-5.5 alias for future benchmark runs.
with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000009'
),
corrected_models as (
  select jsonb_agg(
    case
      when model->>'providerKey'='openai' then
        jsonb_set(
          jsonb_set(
            model,
            '{displayName}',
            to_jsonb('OpenAI GPT-5.5'::text)
          ),
          '{modelId}',
          to_jsonb('gpt-5.5'::text)
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
  '30000000-0000-0000-0000-000000000010',
  'benchmark_models',
  'benchmark-models-core-v5',
  'Gemini·Solar·K-EXAONE·OpenAI 비교 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          base.definition,
          '{version}',
          to_jsonb('benchmark-models-core-v5'::text)
        ),
        '{title}',
        to_jsonb('Gemini·Solar·K-EXAONE·OpenAI 비교 기본값'::text)
      ),
      '{description}',
      to_jsonb(
        '동일한 데이터셋을 Gemini 3.6 Flash, Upstage Solar Pro 3, K-EXAONE 236B A23B, OpenAI GPT-5.5 일반 모델 별칭으로 비교합니다.'::text
      )
    ),
    '{settings,models}',
    corrected_models.models
  ),
  null
from base cross join corrected_models
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000010',
    activated_at=now()
where kind='benchmark_models'
  and profile_id='30000000-0000-0000-0000-000000000009';

update provider_configs
set model_id='gpt-5.5',
    updated_at=now()
where provider_key='openai'
  and model_id='gpt-5.4-nano-2026-03-17';
