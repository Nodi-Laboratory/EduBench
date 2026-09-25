-- Preserve the previous question-generation profile and activate a new
-- direction budget only for future batches that use the default active profile.

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000011'
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000013',
  'question_generation',
  'question-generation-gemini-3.5-flash-v3',
  'Gemini 3.5 Flash 문항 생성 8,192 토큰 방향성 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        base.definition,
        '{version}',
        to_jsonb('question-generation-gemini-3.5-flash-v3'::text)
      ),
      '{title}',
      to_jsonb('Gemini 3.5 Flash 문항 생성 8,192 토큰 방향성 기본값'::text)
    ),
    '{description}',
    to_jsonb('Gemini 3.5 Flash의 구조화 출력과 고수준 사고를 사용해 더 넉넉한 방향성 출력 한도로 각 문항의 방향 생성·근거 검색·문항 생성을 독립적으로 수행합니다.'::text)
  ) || jsonb_build_object(
    'settings',
    jsonb_set(base.definition->'settings', '{directionMaxOutputTokens}', to_jsonb(8192))
  ),
  null
from base
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000013',
    activated_at=now()
where kind='question_generation'
  and profile_id='30000000-0000-0000-0000-000000000011';
