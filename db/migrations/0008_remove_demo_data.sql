-- Remove the deterministic demo workspace. Real uploaded sources and real generated
-- questions are intentionally outside these predicates and remain untouched.

delete from human_scores
where model_response_id in (
  select mr.id from model_responses mr
  join run_items ri on ri.id=mr.run_item_id
  join benchmark_runs br on br.id=ri.benchmark_run_id
  where br.public_id like 'SAMPLE-RUN-%'
     or br.parameters->>'sample_data'='true'
     or br.parameters->>'mock_providers'='true'
);

delete from scores
where model_response_id in (
  select mr.id from model_responses mr
  join run_items ri on ri.id=mr.run_item_id
  join benchmark_runs br on br.id=ri.benchmark_run_id
  where br.public_id like 'SAMPLE-RUN-%'
     or br.parameters->>'sample_data'='true'
     or br.parameters->>'mock_providers'='true'
);

delete from model_responses
where run_item_id in (
  select ri.id from run_items ri join benchmark_runs br on br.id=ri.benchmark_run_id
  where br.public_id like 'SAMPLE-RUN-%'
     or br.parameters->>'sample_data'='true'
     or br.parameters->>'mock_providers'='true'
);

delete from run_items where benchmark_run_id in (
  select id from benchmark_runs where public_id like 'SAMPLE-RUN-%'
    or parameters->>'sample_data'='true' or parameters->>'mock_providers'='true'
);
delete from run_models where benchmark_run_id in (
  select id from benchmark_runs where public_id like 'SAMPLE-RUN-%'
    or parameters->>'sample_data'='true' or parameters->>'mock_providers'='true'
);
delete from report_artifacts where benchmark_run_id in (
  select id from benchmark_runs where public_id like 'SAMPLE-RUN-%'
    or parameters->>'sample_data'='true' or parameters->>'mock_providers'='true'
);
delete from job_events where aggregate_type='benchmark_run' and aggregate_id in (
  select id from benchmark_runs where public_id like 'SAMPLE-RUN-%'
    or parameters->>'sample_data'='true' or parameters->>'mock_providers'='true'
);
delete from benchmark_runs where public_id like 'SAMPLE-RUN-%'
  or parameters->>'sample_data'='true' or parameters->>'mock_providers'='true';

alter table dataset_questions disable trigger dataset_questions_immutable;
alter table dataset_versions disable trigger dataset_versions_immutable_update;
delete from dataset_questions where dataset_version_id in (
  select dv.id from dataset_versions dv where dv.version like 'sample-%' or dv.distribution->>'sample_data'='true'
    or exists (
      select 1 from dataset_questions dq join questions q on q.id=dq.question_id
      where dq.dataset_version_id=dv.id and (q.public_id like 'SAMPLE-Q-%' or q.generator_provider='sample' or q.generator_model like 'mock-%')
    )
);
delete from dataset_versions dv where dv.version like 'sample-%' or dv.distribution->>'sample_data'='true'
  or not exists (select 1 from dataset_questions dq where dq.dataset_version_id=dv.id);
alter table dataset_questions enable trigger dataset_questions_immutable;
alter table dataset_versions enable trigger dataset_versions_immutable_update;

delete from review_actions where question_id in (
  select id from questions where public_id like 'SAMPLE-Q-%' or generator_provider='sample' or generator_model like 'mock-%'
);
delete from question_evidence where question_id in (
  select id from questions where public_id like 'SAMPLE-Q-%' or generator_provider='sample' or generator_model like 'mock-%'
);
delete from question_revisions where question_id in (
  select id from questions where public_id like 'SAMPLE-Q-%' or generator_provider='sample' or generator_model like 'mock-%'
);
delete from questions where public_id like 'SAMPLE-Q-%' or generator_provider='sample' or generator_model like 'mock-%';

delete from provider_configs where provider_key in ('claude','openai','midm');
