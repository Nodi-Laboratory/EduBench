create or replace function jsonb_has_exact_keys(
  candidate jsonb,
  expected_keys text[]
)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(candidate) = 'object'
    and coalesce(
      (select array_agg(candidate_key order by candidate_key)
       from jsonb_object_keys(candidate) candidate_key),
      array[]::text[]
    ) = (
      select array_agg(expected_key order by expected_key)
      from unnest(expected_keys) expected_key
    );
$$;

create or replace function jsonb_nonblank_text(
  candidate jsonb,
  field_name text,
  minimum_length integer,
  maximum_length integer
)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(candidate->field_name) = 'string'
    and char_length(btrim(candidate->>field_name))
      between minimum_length and maximum_length;
$$;

create or replace function jsonb_integer_between(
  candidate jsonb,
  field_name text,
  minimum_value numeric,
  maximum_value numeric
)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(candidate->field_name) <> 'number' then false
    else (candidate->>field_name)::numeric = trunc((candidate->>field_name)::numeric)
      and (candidate->>field_name)::numeric between minimum_value and maximum_value
  end;
$$;

create or replace function jsonb_number_between(
  candidate jsonb,
  field_name text,
  minimum_value numeric,
  maximum_value numeric
)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(candidate->field_name) <> 'number' then false
    else (candidate->>field_name)::numeric between minimum_value and maximum_value
  end;
$$;

create or replace function jsonb_nullable_number_between(
  candidate jsonb,
  field_name text,
  minimum_value numeric,
  maximum_value numeric
)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(candidate->field_name) = 'null'
    or jsonb_number_between(candidate,field_name,minimum_value,maximum_value);
$$;

create or replace function valid_research_config_definition(
  profile_kind text,
  candidate jsonb
)
returns boolean
language plpgsql
immutable
as $$
declare
  settings jsonb;
  rasterization jsonb;
  model jsonb;
  generation jsonb;
  provider text;
  found_gemini boolean := false;
  found_upstage boolean := false;
  found_exaone boolean := false;
begin
  if jsonb_has_exact_keys(
    candidate,
    array[
      'schemaVersion','kind','version','title','description',
      'applyScope','reprocessingImpact','settings'
    ]
  ) is not true then
    return false;
  end if;
  if jsonb_integer_between(candidate,'schemaVersion',1,1) is not true
     or candidate->>'kind' <> profile_kind
     or jsonb_nonblank_text(candidate,'version',3,100) is not true
     or (candidate->>'version') !~ '^[a-z0-9][a-z0-9._-]*$'
     or jsonb_nonblank_text(candidate,'title',2,120) is not true
     or jsonb_nonblank_text(candidate,'description',20,1000) is not true
     or jsonb_nonblank_text(candidate,'applyScope',20,1000) is not true
     or jsonb_nonblank_text(candidate,'reprocessingImpact',20,1000) is not true
     or jsonb_typeof(candidate->'settings') <> 'object' then
    return false;
  end if;

  settings := candidate->'settings';

  if profile_kind = 'document_parse' then
    if jsonb_has_exact_keys(
      settings,
      array[
        'provider','model','mode','ocr','outputFormat','base64Encoding',
        'rasterization','pagesPerBatch','pageConcurrency','requestTimeoutMs'
      ]
    ) is not true
       or settings->>'provider' <> 'upstage'
       or jsonb_nonblank_text(settings,'model',1,200) is not true
       or settings->>'mode' not in ('standard','enhanced','auto')
       or settings->>'ocr' not in ('auto','force')
       or settings->>'outputFormat' not in ('html','markdown','both')
       or jsonb_typeof(settings->'base64Encoding') <> 'array'
       or jsonb_array_length(settings->'base64Encoding') <> 4
       or not (settings->'base64Encoding' @> '["table","figure","chart","equation"]'::jsonb)
       or jsonb_typeof(settings->'rasterization') <> 'object'
       or jsonb_integer_between(settings,'pagesPerBatch',1,100) is not true
       or jsonb_integer_between(settings,'pageConcurrency',1,20) is not true
       or jsonb_integer_between(settings,'requestTimeoutMs',1000,600000) is not true then
      return false;
    end if;
    rasterization := settings->'rasterization';
    if rasterization->>'format' = 'png' then
      return jsonb_has_exact_keys(rasterization,array['format','lossless','dpi'])
        and rasterization->'lossless' = 'true'::jsonb
        and jsonb_integer_between(rasterization,'dpi',150,600);
    end if;
    if rasterization->>'format' = 'jpeg' then
      return jsonb_has_exact_keys(
          rasterization,array['format','lossless','dpi','jpegQuality']
        )
        and rasterization->'lossless' = 'false'::jsonb
        and jsonb_integer_between(rasterization,'dpi',150,600)
        and jsonb_integer_between(rasterization,'jpegQuality',60,100);
    end if;
    return false;
  end if;

  if profile_kind = 'embedding_rag' then
    if jsonb_has_exact_keys(
      settings,
      array[
        'provider','model','dimensions','vectorSpaceId','documentTaskType',
        'queryTaskType','prefixStrategy','documentPrefix','queryPrefix',
        'similarityMetric','chunkTargetTokens','retrievalTopK',
        'neighborWindow','batchSize','concurrency','requestTimeoutMs'
      ]
    ) is not true
       or settings->>'provider' <> 'gemini'
       or jsonb_nonblank_text(settings,'model',1,200) is not true
       or jsonb_integer_between(settings,'dimensions',128,3072) is not true
       or jsonb_nonblank_text(settings,'vectorSpaceId',3,200) is not true
       or settings->>'documentTaskType' <> 'RETRIEVAL_DOCUMENT'
       or settings->>'queryTaskType' <> 'RETRIEVAL_QUERY'
       or settings->>'prefixStrategy' not in ('task_type','text_prefix')
       or jsonb_typeof(settings->'documentPrefix') <> 'string'
       or char_length(settings->>'documentPrefix') > 120
       or jsonb_typeof(settings->'queryPrefix') <> 'string'
       or char_length(settings->>'queryPrefix') > 120
       or settings->>'similarityMetric' <> 'cosine'
       or jsonb_integer_between(settings,'chunkTargetTokens',64,4096) is not true
       or jsonb_integer_between(settings,'retrievalTopK',1,100) is not true
       or jsonb_integer_between(settings,'neighborWindow',0,5) is not true
       or jsonb_integer_between(settings,'batchSize',1,100) is not true
       or jsonb_integer_between(settings,'concurrency',1,20) is not true
       or jsonb_integer_between(settings,'requestTimeoutMs',1000,600000) is not true then
      return false;
    end if;
    if settings->>'prefixStrategy' = 'task_type' then
      return settings->>'documentPrefix' = '' and settings->>'queryPrefix' = '';
    end if;
    return btrim(settings->>'documentPrefix') <> ''
      and btrim(settings->>'queryPrefix') <> '';
  end if;

  if profile_kind = 'question_generation' then
    return jsonb_has_exact_keys(
        settings,
        array[
          'provider','model','directionMaxOutputTokens',
          'questionMaxOutputTokens','thinkingLevel','structuredOutput',
          'responseMimeType','concurrency','requestTimeoutMs'
        ]
      )
      and settings->>'provider' = 'gemini'
      and jsonb_nonblank_text(settings,'model',1,200)
      and jsonb_integer_between(settings,'directionMaxOutputTokens',512,16384)
      and jsonb_integer_between(settings,'questionMaxOutputTokens',4096,65536)
      and settings->>'thinkingLevel' in ('MINIMAL','LOW','MEDIUM','HIGH')
      and settings->'structuredOutput' = 'true'::jsonb
      and settings->>'responseMimeType' = 'application/json'
      and jsonb_integer_between(settings,'concurrency',1,20)
      and jsonb_integer_between(settings,'requestTimeoutMs',1000,600000);
  end if;

  if profile_kind = 'benchmark_models' then
    if jsonb_has_exact_keys(settings,array['models']) is not true
       or jsonb_typeof(settings->'models') <> 'array'
       or jsonb_array_length(settings->'models') <> 3 then
      return false;
    end if;
    for model in select value from jsonb_array_elements(settings->'models')
    loop
      if jsonb_has_exact_keys(
        model,
        array[
          'providerKey','displayName','protocol','enabled','modelId',
          'concurrency','requestIntervalMs','requestTimeoutMs','generation'
        ]
      ) is not true
         or jsonb_nonblank_text(model,'displayName',1,80) is not true
         or jsonb_nonblank_text(model,'modelId',1,200) is not true
         or jsonb_typeof(model->'enabled') <> 'boolean'
         or jsonb_integer_between(model,'concurrency',1,50) is not true
         or jsonb_integer_between(model,'requestIntervalMs',0,60000) is not true
         or jsonb_integer_between(model,'requestTimeoutMs',1000,600000) is not true
         or jsonb_typeof(model->'generation') <> 'object' then
        return false;
      end if;
      provider := model->>'providerKey';
      if provider = 'gemini' and model->>'protocol' = 'gemini' then
        if found_gemini then return false; end if;
        found_gemini := true;
      elsif provider = 'upstage' and model->>'protocol' = 'openai-compatible' then
        if found_upstage then return false; end if;
        found_upstage := true;
      elsif provider = 'exaone' and model->>'protocol' = 'openai-compatible' then
        if found_exaone then return false; end if;
        found_exaone := true;
      else
        return false;
      end if;

      generation := model->'generation';
      if jsonb_has_exact_keys(
        generation,
        array[
          'maxOutputTokens','temperature','topP','presencePenalty',
          'frequencyPenalty','thinkingLevel','enableThinking',
          'omitTemperature','omitTopP','stopSequences','seed'
        ]
      ) is not true
         or jsonb_integer_between(generation,'maxOutputTokens',1,131072) is not true
         or jsonb_nullable_number_between(generation,'temperature',0,2) is not true
         or jsonb_nullable_number_between(generation,'topP',0,1) is not true
         or jsonb_nullable_number_between(generation,'presencePenalty',-2,2) is not true
         or jsonb_nullable_number_between(generation,'frequencyPenalty',-2,2) is not true
         or (
           jsonb_typeof(generation->'thinkingLevel') <> 'null'
           and generation->>'thinkingLevel' not in ('MINIMAL','LOW','MEDIUM','HIGH')
         )
         or jsonb_typeof(generation->'enableThinking') not in ('null','boolean')
         or jsonb_typeof(generation->'omitTemperature') <> 'boolean'
         or jsonb_typeof(generation->'omitTopP') <> 'boolean'
         or jsonb_typeof(generation->'stopSequences') <> 'array'
         or jsonb_array_length(generation->'stopSequences') > 16
         or exists (
           select 1 from jsonb_array_elements(generation->'stopSequences') stop
           where jsonb_typeof(stop) <> 'string'
             or char_length(stop #>> '{}') not between 1 and 200
         )
         or (
           jsonb_typeof(generation->'seed') <> 'null'
           and jsonb_integer_between(generation,'seed',0,2147483647) is not true
         ) then
        return false;
      end if;
    end loop;
    return found_gemini and found_upstage and found_exaone;
  end if;

  return false;
end;
$$;

create or replace function research_config_definition_hash(candidate jsonb)
returns text
language sql
immutable
as $$
  select encode(digest(candidate::text,'sha256'),'hex');
$$;

create table research_config_profiles (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (
    kind in (
      'document_parse','embedding_rag',
      'question_generation','benchmark_models'
    )
  ),
  version text not null,
  title text not null,
  definition jsonb not null,
  content_hash text not null unique check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(kind,version),
  unique(kind,id),
  check (definition->>'version' = version),
  check (definition->>'title' = title),
  check (valid_research_config_definition(kind,definition))
);

create or replace function prepare_research_config_profile()
returns trigger
language plpgsql
as $$
declare
  expected_hash text;
begin
  expected_hash := research_config_definition_hash(new.definition);
  if new.content_hash is not null and new.content_hash <> expected_hash then
    raise exception 'research configuration content hash does not match definition'
      using errcode = '23514';
  end if;
  new.content_hash := expected_hash;
  return new;
end;
$$;

create trigger research_config_profiles_prepare
before insert on research_config_profiles
for each row execute function prepare_research_config_profile();

create or replace function prevent_research_config_profile_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'research configuration profiles are append-only'
    using errcode = '55000';
end;
$$;

create trigger research_config_profiles_append_only
before update or delete on research_config_profiles
for each row execute function prevent_research_config_profile_change();

create table research_config_active_profiles (
  kind text primary key check (
    kind in (
      'document_parse','embedding_rag',
      'question_generation','benchmark_models'
    )
  ),
  profile_id uuid not null,
  activated_at timestamptz not null default now(),
  foreign key(kind,profile_id)
    references research_config_profiles(kind,id)
    on update restrict
    on delete restrict
);

create or replace function protect_research_config_active_kind()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' or new.kind is distinct from old.kind then
    raise exception 'an active research configuration kind cannot be removed or renamed'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger research_config_active_kind_protected
before update of kind or delete on research_config_active_profiles
for each row execute function protect_research_config_active_kind();

insert into research_config_profiles(id,kind,version,title,definition,content_hash)
values
(
  '30000000-0000-0000-0000-000000000001',
  'document_parse',
  'document-parse-upstage-v1',
  'Upstage Document Parse 연구 기본값',
  $document_parse$
  {
    "schemaVersion": 1,
    "kind": "document_parse",
    "version": "document-parse-upstage-v1",
    "title": "Upstage Document Parse 연구 기본값",
    "description": "교과서의 표·그림·차트·수식을 원본 화질로 보존하면서 페이지 단위 분석 결과를 수집하는 기본 파싱 설정입니다.",
    "applyScope": "활성화 이후 새로 등록하는 교과서 파싱 작업과 Document Lab의 새 분석 요청에 적용됩니다.",
    "reprocessingImpact": "파싱 결과와 청크 근거가 달라질 수 있으므로 변경 효과를 기존 교과서에 반영하려면 전체 문서를 다시 처리해야 합니다.",
    "settings": {
      "provider": "upstage",
      "model": "document-parse",
      "mode": "enhanced",
      "ocr": "force",
      "outputFormat": "html",
      "base64Encoding": ["table", "figure", "chart", "equation"],
      "rasterization": {"format": "png", "lossless": true, "dpi": 300},
      "pagesPerBatch": 10,
      "pageConcurrency": 4,
      "requestTimeoutMs": 120000
    }
  }
  $document_parse$::jsonb,
  null
),
(
  '30000000-0000-0000-0000-000000000002',
  'embedding_rag',
  'embedding-rag-gemini-3072-v1',
  'Gemini 3072차원 임베딩·RAG 기본값',
  $embedding_rag$
  {
    "schemaVersion": 1,
    "kind": "embedding_rag",
    "version": "embedding-rag-gemini-3072-v1",
    "title": "Gemini 3072차원 임베딩·RAG 기본값",
    "description": "문서와 질의를 서로 구분해 임베딩하고 동일한 3072차원 벡터 공간에서 교과서 근거를 검색하는 안전한 기본 설정입니다.",
    "applyScope": "활성화 이후 새로 벡터화되는 교과서 청크와 그 벡터 공간을 사용하는 새 질문 생성 검색에 적용됩니다.",
    "reprocessingImpact": "모델·차원·접두사·태스크가 바뀌면 벡터 공간이 달라지므로 기존 임베딩과 섞을 수 없고 전체 재임베딩이 필요합니다.",
    "settings": {
      "provider": "gemini",
      "model": "gemini-embedding-001",
      "dimensions": 3072,
      "vectorSpaceId": "gemini-embedding-001:3072:task-type-v1",
      "documentTaskType": "RETRIEVAL_DOCUMENT",
      "queryTaskType": "RETRIEVAL_QUERY",
      "prefixStrategy": "task_type",
      "documentPrefix": "",
      "queryPrefix": "",
      "similarityMetric": "cosine",
      "chunkTargetTokens": 512,
      "retrievalTopK": 12,
      "neighborWindow": 1,
      "batchSize": 50,
      "concurrency": 3,
      "requestTimeoutMs": 120000
    }
  }
  $embedding_rag$::jsonb,
  null
),
(
  '30000000-0000-0000-0000-000000000003',
  'question_generation',
  'question-generation-gemini-3.5-flash-v1',
  'Gemini 3.5 Flash 문항 생성 기본값',
  $question_generation$
  {
    "schemaVersion": 1,
    "kind": "question_generation",
    "version": "question-generation-gemini-3.5-flash-v1",
    "title": "Gemini 3.5 Flash 문항 생성 기본값",
    "description": "각 문항마다 방향 생성·관련 자료 검색·구조화 문항 생성을 독립적으로 수행하기 위한 기본 생성 모델 설정입니다.",
    "applyScope": "활성화 이후 새로 만드는 질문 생성 배치에만 적용되며 이미 생성 중이거나 완료된 배치의 설정은 바뀌지 않습니다.",
    "reprocessingImpact": "기존 교과서 임베딩은 그대로 사용할 수 있지만 변경된 생성 결과를 비교하려면 새 질문 배치를 만들어야 합니다.",
    "settings": {
      "provider": "gemini",
      "model": "gemini-3.5-flash",
      "directionMaxOutputTokens": 2048,
      "questionMaxOutputTokens": 16384,
      "thinkingLevel": "HIGH",
      "structuredOutput": true,
      "responseMimeType": "application/json",
      "concurrency": 4,
      "requestTimeoutMs": 180000
    }
  }
  $question_generation$::jsonb,
  null
),
(
  '30000000-0000-0000-0000-000000000004',
  'benchmark_models',
  'benchmark-models-core-v1',
  'Gemini·Upstage·EXAONE 비교 기본값',
  $benchmark_models$
  {
    "schemaVersion": 1,
    "kind": "benchmark_models",
    "version": "benchmark-models-core-v1",
    "title": "Gemini·Upstage·EXAONE 비교 기본값",
    "description": "동일한 데이터셋을 Gemini, Upstage, EXAONE의 정확한 모델 식별자와 재현 가능한 생성 파라미터로 비교하는 기본 설정입니다.",
    "applyScope": "활성화 이후 새로 생성하는 벤치마크 실행의 모델 선택과 요청 파라미터 기본값에만 적용됩니다.",
    "reprocessingImpact": "교과서나 질문을 다시 처리할 필요는 없지만 기존 실행에는 소급 적용되지 않으므로 비교하려면 새 실행을 만들어야 합니다.",
    "settings": {
      "models": [
        {
          "providerKey": "gemini",
          "displayName": "Gemini 3.5 Flash",
          "protocol": "gemini",
          "enabled": true,
          "modelId": "gemini-3.5-flash",
          "concurrency": 4,
          "requestIntervalMs": 0,
          "requestTimeoutMs": 180000,
          "generation": {
            "maxOutputTokens": 16384,
            "temperature": null,
            "topP": null,
            "presencePenalty": null,
            "frequencyPenalty": null,
            "thinkingLevel": "HIGH",
            "enableThinking": null,
            "omitTemperature": true,
            "omitTopP": true,
            "stopSequences": [],
            "seed": null
          }
        },
        {
          "providerKey": "upstage",
          "displayName": "Upstage Solar Pro 3",
          "protocol": "openai-compatible",
          "enabled": true,
          "modelId": "solar-pro3",
          "concurrency": 3,
          "requestIntervalMs": 0,
          "requestTimeoutMs": 180000,
          "generation": {
            "maxOutputTokens": 16384,
            "temperature": 0.7,
            "topP": 0.95,
            "presencePenalty": 0,
            "frequencyPenalty": 0,
            "thinkingLevel": null,
            "enableThinking": null,
            "omitTemperature": false,
            "omitTopP": false,
            "stopSequences": [],
            "seed": null
          }
        },
        {
          "providerKey": "exaone",
          "displayName": "K-EXAONE 236B A23B",
          "protocol": "openai-compatible",
          "enabled": true,
          "modelId": "LGAI-EXAONE/K-EXAONE-236B-A23B",
          "concurrency": 1,
          "requestIntervalMs": 30000,
          "requestTimeoutMs": 300000,
          "generation": {
            "maxOutputTokens": 16384,
            "temperature": 1,
            "topP": 0.95,
            "presencePenalty": 0,
            "frequencyPenalty": 0,
            "thinkingLevel": null,
            "enableThinking": true,
            "omitTemperature": false,
            "omitTopP": false,
            "stopSequences": [],
            "seed": null
          }
        }
      ]
    }
  }
  $benchmark_models$::jsonb,
  null
);

insert into research_config_active_profiles(kind,profile_id)
values
  ('document_parse','30000000-0000-0000-0000-000000000001'),
  ('embedding_rag','30000000-0000-0000-0000-000000000002'),
  ('question_generation','30000000-0000-0000-0000-000000000003'),
  ('benchmark_models','30000000-0000-0000-0000-000000000004');
