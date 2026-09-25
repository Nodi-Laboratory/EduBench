alter table generation_provider_invocations
  drop constraint if exists generation_provider_invocations_stage_check;

alter table generation_provider_invocations
  add constraint generation_provider_invocations_stage_check
  check (stage in ('DIRECTION','QUESTION','QUESTION_REPAIR'));

-- 이 오류는 사용자 입력 범위 문제가 아니라 기존 생성 모델의 필드 간 의미
-- 불일치였으므로, 배포 전에 실패한 항목도 새 교정 경로로 재개할 수 있게 한다.
update generation_items
   set retryable=true,
       updated_at=now()
 where state='FAILED'
   and error_code='GENERATION_PARSE_FAILED'
   and error_message like '%최소 한 선수 관계가 목표 개념으로 연결되어야 합니다.%';
