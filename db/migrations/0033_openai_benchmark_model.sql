-- Keep historical three-model research profiles valid while permitting one
-- additional OpenAI model in new immutable benchmark profiles.
create or replace function valid_research_config_definition_v2(
  profile_kind text,
  candidate jsonb
)
returns boolean
language plpgsql
immutable
as $$
declare
  models jsonb;
  core_models jsonb;
  openai_probe_models jsonb;
  core_candidate jsonb;
  openai_probe_candidate jsonb;
begin
  if profile_kind <> 'benchmark_models' then
    return valid_research_config_definition(profile_kind,candidate);
  end if;

  if valid_research_config_definition(profile_kind,candidate) then
    return true;
  end if;

  models := candidate #> '{settings,models}';
  if jsonb_typeof(models) <> 'array'
     or jsonb_array_length(models) <> 4
     or (
       select count(*)
       from jsonb_array_elements(models) model
       where model->>'providerKey'='openai'
         and model->>'protocol'='openai-responses'
     ) <> 1 then
    return false;
  end if;

  select jsonb_agg(model order by ordinal)
  into core_models
  from jsonb_array_elements(models) with ordinality item(model,ordinal)
  where model->>'providerKey' <> 'openai';

  core_candidate := jsonb_set(candidate,'{settings,models}',core_models);
  if valid_research_config_definition(profile_kind,core_candidate) is not true then
    return false;
  end if;

  select jsonb_agg(
    case
      when model->>'providerKey'='openai' then
        jsonb_set(
          jsonb_set(
            model,
            '{providerKey}',
            to_jsonb('upstage'::text)
          ),
          '{protocol}',
          to_jsonb('openai-compatible'::text)
        )
      else model
    end
    order by ordinal
  )
  into openai_probe_models
  from jsonb_array_elements(models) with ordinality item(model,ordinal)
  where model->>'providerKey' in ('gemini','exaone','openai');

  openai_probe_candidate := jsonb_set(
    candidate,
    '{settings,models}',
    openai_probe_models
  );
  return valid_research_config_definition(
    profile_kind,
    openai_probe_candidate
  );
end;
$$;

create or replace function valid_research_config_execution_pin(
  expected_kind text,
  profile_id uuid,
  profile_snapshot jsonb,
  profile_hash text,
  snapshot_provenance text
)
returns boolean
language sql
immutable
as $$
  select (
    snapshot_provenance = 'LEGACY_BACKFILL_UNVERIFIED'
    and profile_id is null
    and profile_snapshot is null
    and profile_hash is null
  ) or (
    snapshot_provenance = 'AT_CREATION_VERIFIED'
    and profile_id is not null
    and jsonb_typeof(profile_snapshot) = 'object'
    and profile_snapshot->>'kind' = expected_kind
    and profile_hash ~ '^[0-9a-f]{64}$'
    and research_config_definition_hash(profile_snapshot) = profile_hash
    and valid_research_config_definition_v2(
      expected_kind,
      profile_snapshot
    )
  );
$$;

alter table research_config_profiles
  drop constraint research_config_profiles_check2;

alter table research_config_profiles
  add constraint research_config_profiles_check2
  check (valid_research_config_definition_v2(kind,definition));

with base as (
  select definition
  from research_config_profiles
  where id='30000000-0000-0000-0000-000000000006'
),
openai_model as (
  select jsonb_build_object(
    'providerKey','openai',
    'displayName','OpenAI GPT-5.5 Nano',
    'protocol','openai-responses',
    'enabled',true,
    'modelId','gpt-5.5-nano',
    'concurrency',2,
    'requestIntervalMs',0,
    'requestTimeoutMs',180000,
    'generation',jsonb_build_object(
      'maxOutputTokens',16384,
      'temperature',null,
      'topP',null,
      'presencePenalty',null,
      'frequencyPenalty',null,
      'thinkingLevel',null,
      'enableThinking',null,
      'omitTemperature',true,
      'omitTopP',true,
      'stopSequences','[]'::jsonb,
      'seed',null
    )
  ) model
)
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
select
  '30000000-0000-0000-0000-000000000008',
  'benchmark_models',
  'benchmark-models-core-v3',
  'Gemini·Solar·K-EXAONE·OpenAI 비교 기본값',
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          base.definition,
          '{version}',
          to_jsonb('benchmark-models-core-v3'::text)
        ),
        '{title}',
        to_jsonb('Gemini·Solar·K-EXAONE·OpenAI 비교 기본값'::text)
      ),
      '{description}',
      to_jsonb(
        '동일한 데이터셋을 Gemini 3.6 Flash, Upstage Solar Pro 3, K-EXAONE 236B A23B, OpenAI GPT-5.5 Nano의 고정 모델 식별자와 재현 가능한 생성 파라미터로 비교합니다.'::text
      )
    ),
    '{settings,models}',
    (base.definition #> '{settings,models}')
      || jsonb_build_array(openai_model.model)
  ),
  null
from base cross join openai_model
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000008',
    activated_at=now()
where kind='benchmark_models';
