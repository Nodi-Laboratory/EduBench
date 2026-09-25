-- Keep the v1 definition and historical scores immutable, while registering the
-- exact_match-free runtime as a new append-only engine version.
insert into scoring_engine_versions(
  version,
  title,
  definition,
  content_hash
)
select
  'edubench-scoring-v2',
  'EduBench 선수관계 평가 엔진 v2',
  definition
    || jsonb_build_object(
      'version', 'edubench-scoring-v2',
      'title', 'EduBench 선수관계 평가 엔진 v2',
      'deterministic', (definition->'deterministic') - 'exactMatch',
      'metricResolution', (definition->'metricResolution')
        || jsonb_build_object(
          'implementationVersion', 'required-metrics-v2',
          'baseMetrics', jsonb_build_array('response_present'),
          'profileMetrics', 'discard retired exact_match, then append score profile metrics in stored order and deduplicate by first occurrence'
        )
    ),
  repeat('0', 64)
from scoring_engine_versions
where version = 'edubench-scoring-v1'
on conflict (version) do nothing;

update scoring_engine_registry
set
  current_engine_version_id = (
    select id
    from scoring_engine_versions
    where version = 'edubench-scoring-v2'
  ),
  updated_at = now()
where singleton;
