-- Gemini Embedding 2 uses explicit text instructions instead of taskType.
-- Keep the previous vector space immutable and activate a distinct profile.
insert into research_config_profiles(
  id,kind,version,title,definition,content_hash
)
values(
  '30000000-0000-0000-0000-000000000007',
  'embedding_rag',
  'embedding-rag-gemini-embedding-2-3072-text-prefix-v1',
  'Gemini Embedding 2 · 선수관계 RAG 기본값',
  $embedding_rag$
  {
    "schemaVersion": 1,
    "kind": "embedding_rag",
    "version": "embedding-rag-gemini-embedding-2-3072-text-prefix-v1",
    "title": "Gemini Embedding 2 · 선수관계 RAG 기본값",
    "description": "Gemini Embedding 2가 지원하는 텍스트 지시 접두사로 교과서 근거와 선수관계 검색 질의를 구분하는 3072차원 RAG 설정입니다.",
    "applyScope": "활성화 이후 새로 벡터화하는 교과서 청크와 그 벡터 공간을 사용하는 새 질문 생성 검색에 적용됩니다.",
    "reprocessingImpact": "기존 임베딩과 벡터 공간이 다르므로 현재 설정을 적용하려면 원본 교과서를 새 처리 계보로 다시 파싱하고 임베딩해야 합니다.",
    "settings": {
      "provider": "gemini",
      "model": "gemini-embedding-2",
      "dimensions": 3072,
      "vectorSpaceId": "gemini-embedding-2:3072:text-prefix-prerequisite-rag-v1",
      "documentTaskType": "RETRIEVAL_DOCUMENT",
      "queryTaskType": "RETRIEVAL_QUERY",
      "prefixStrategy": "text_prefix",
      "documentPrefix": "title: none | text: ",
      "queryPrefix": "task: search result | query: ",
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
)
on conflict do nothing;

update research_config_active_profiles
set profile_id='30000000-0000-0000-0000-000000000007',
    activated_at=now()
where kind='embedding_rag';

-- Keep vectors from distinct pinned spaces in one audited table. Retrieval
-- always materializes one vectorSpaceId before applying a distance operator.
alter table source_chunks
  alter column embedding type vector
  using embedding::vector;

-- A byte-identical source may need a new immutable processing lineage when
-- either the parser or embedding profile changes. Preserve every old result.
alter table source_files
  add column source_lineage_id uuid,
  add column reprocessed_from_source_file_id uuid
    references source_files(id);

update source_files
set source_lineage_id=gen_random_uuid()
where source_lineage_id is null;

alter table source_files
  alter column source_lineage_id set not null,
  alter column source_lineage_id set default gen_random_uuid(),
  add constraint source_files_reprocessed_from_not_self check (
    reprocessed_from_source_file_id is null
    or reprocessed_from_source_file_id <> id
  );

alter table source_files
  drop constraint if exists source_files_sha256_key;

create unique index source_files_verified_profile_dedup_idx
  on source_files(
    sha256,
    document_parse_profile_hash,
    embedding_rag_profile_hash
  )
  where document_parse_profile_snapshot_provenance='AT_CREATION_VERIFIED'
    and embedding_rag_profile_snapshot_provenance='AT_CREATION_VERIFIED';

create index source_files_lineage_idx
  on source_files(source_lineage_id,created_at);

create index source_files_reprocessed_from_idx
  on source_files(reprocessed_from_source_file_id)
  where reprocessed_from_source_file_id is not null;
