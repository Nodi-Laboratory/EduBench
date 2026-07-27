# 2026-07-27 질문 세트·반응형 연구 UI 변경 기록

## 변경 목적

이번 변경은 승인된 문항을 하나의 암묵적인 묶음으로 취급하던 구조를 연구자가 직접 관리할 수 있는 질문 세트 구조로 바꾸고, 브라우저 확대·축소나 좁은 화면에서도 검수 근거와 실행 설정이 사라지지 않도록 UI를 재배치한 작업이다. 연구자는 이제 문항의 승인 위치, 데이터셋 발행 경계, 벤치마크 실행에 사용한 데이터셋을 명시적으로 추적할 수 있다.

## 핵심 변경

### 1. 편집 가능한 질문 세트

- `question_sets`와 `question_set_questions`를 추가했다.
- 질문 세트는 이름과 설명을 가지며, 문항별로 특정 revision과 순번을 고정한다.
- schema는 하나의 승인 문항이 여러 활성 질문 세트에 포함되는 것을 허용한다. 현재 UI/API는 최초 승인 때 한 세트에 배정하며, 기존 승인 문항을 추가 세트에 넣는 별도 workflow는 아직 없다.
- 세트 삭제는 soft delete다. 발행된 데이터셋과 과거 실행은 유지된다.
- 세트 내부 문항 삭제는 원본 문항 삭제가 아니라 해당 세트의 membership 제거다.
- membership 제거 뒤 순번은 다시 연속적으로 정렬된다.
- 다른 활성 세트에도 들어 있는 문항은 `미분류 승인 문항`으로 잘못 표시하지 않는다.

### 2. 검수와 세트 배정의 원자성

`APPROVE`와 `EDIT_AND_APPROVE`는 대상 질문 세트를 반드시 지정한다.

- 기존 세트를 선택할 수 있다.
- 검수 화면 안에서 새 세트를 만들 수 있다.
- 문항 상태 전이
- 수정 revision 생성
- evidence revision 복제
- 질문 세트 생성 또는 membership 추가
- `review_actions` 감사 로그 기록

위 작업은 하나의 PostgreSQL transaction에서 수행된다. 마지막 감사 로그 기록이라도 실패하면 앞서 수행된 승인, 새 세트, membership이 모두 rollback된다.

### 3. 질문 세트에서 불변 데이터셋 발행

질문 세트는 계속 편집할 수 있지만 벤치마크 실행에는 편집 가능한 세트를 직접 사용하지 않는다. 연구자가 세트를 발행하면 당시 membership의 `question_id + question_revision + ordinal`을 `dataset_versions`와 `dataset_questions`에 복사한다.

- 모든 문항이 승인 상태인지 확인한다.
- 정렬된 문항·revision·답안·선택지·채점 기준·근거·설계 요약을 기준으로 SHA-256 내용 해시를 계산한다.
- 발행된 데이터셋 row와 membership은 DB trigger가 insert/update/delete를 차단한다.
- 같은 version과 같은 content hash의 재요청은 기존 데이터셋을 반환한다.
- version 또는 hash 한쪽만 겹치면 충돌로 처리한다.
- 서로 다른 프로세스가 같은 manifest를 동시에 발행해도 PostgreSQL unique violation을 500으로 노출하지 않고, rollback 후 기존 데이터셋을 재조회하여 동일 manifest면 성공으로 수렴시킨다.

### 4. 기존 승인 문항 보존

마이그레이션 적용 시 실제 provider로 생성된 기존 승인 문항을 `기존 승인 문항` 세트에 자동 편입한다. 샘플 또는 mock 문항은 backfill 대상에서 제외한다. 2026-07-27 운영 DB에서는 30개 문항이 이 세트에 보존된 것을 확인했다.

### 5. 벤치마크 데이터셋 선택

벤치마크 실행 화면은 발행된 데이터셋을 명시적으로 선택하는 controlled selector를 사용한다.

- 선택한 version, 제목, 설명, 문항 수, 내용 해시, 발행 시각을 manifest로 표시한다.
- 데이터셋을 바꾸면 문항 수 제한이 해당 데이터셋의 문항 수에 맞춰 갱신된다.
- 발행된 데이터셋이 없으면 실행 생성을 비활성화한다.
- 실행은 편집 가능한 세트가 아니라 선택된 불변 데이터셋 revision을 사용한다.

## 연구 UI 변경

### 반응형 재배치

전역 레이아웃과 검수·데이터셋·실행 화면에 다음 원칙을 적용했다.

- grid/flex 자식의 `min-width: 0`을 보장해 긴 JSON, 해시, 근거 본문이 화면 전체를 밀어내지 않게 했다.
- 넓은 화면에서는 설정과 근거를 병렬 배치하고, 1000px 이하에서는 주요 작업 영역을 한 열로 전환한다.
- 720px 이하에서는 헤더, 버튼 묶음, 필터, manifest, 검수 도구를 세로로 재배치한다.
- 넓은 데이터 표는 문서 전체가 아니라 표 컨테이너 내부에서만 가로 스크롤한다.
- 검수 evidence는 좁은 화면에서도 숨기지 않는다.
- 축소형 사이드바 링크에 접근성 이름을 추가했다.

실제 브라우저에서 320, 620, 900, 1360, 1920 CSS 픽셀 폭을 점검했으며 데이터셋·검수·실행 페이지의 document-level horizontal overflow가 발생하지 않는 것을 확인했다.

### 오류 복구

검수, 질문 세트 생성·삭제·문항 제거·발행, 실행 생성 요청은 네트워크 실패나 잘못된 JSON 응답이 발생해도 `busy` 또는 `submitting` 상태를 `finally`에서 해제한다. 연구자는 페이지를 새로 고치지 않고 오류 안내를 확인한 뒤 다시 시도할 수 있다.

### 잘못된 경로 입력

질문 세트의 동적 API 경로는 세트 ID와 문항 ID를 PostgreSQL UUID 형식으로 먼저 검증한다. 잘못된 값은 DB의 `22P02` 오류나 500 응답 대신 `INVALID_QUESTION_SET_PATH` 코드의 HTTP 400 응답을 반환한다.

## 주요 코드 위치

| 책임 | 파일 |
|---|---|
| 스키마와 기존 승인 문항 backfill | `db/migrations/0028_question_sets.sql` |
| 세트 생성·삭제·membership·발행 | `src/server/question-sets/service.ts` |
| 질문 세트 API | `src/app/api/question-sets/**` |
| 승인과 세트 배정 transaction | `src/app/api/questions/[id]/review/route.ts` |
| 검수 UI | `src/components/review/review-workspace.tsx` |
| 질문 세트·데이터셋 UI | `src/components/datasets/dataset-workspace.tsx` |
| 실행 데이터셋 선택 UI | `src/components/runs/run-workspace.tsx` |
| 반응형 규칙 | `src/app/globals.css` |

## 검증

최종 소스 기준 검증 결과:

- 단위 테스트: 51개 파일, 280개 테스트 통과
- 통합 테스트: 79개 파일, 403개 테스트 통과
- TypeScript typecheck 통과
- ESLint 통과
- Next.js production build 통과
- Docker `db`와 `web` healthy, `worker` running
- `/datasets`, `/review`, `/runs` HTTP 200
- 질문 세트 API에서 `기존 승인 문항` 30문항 조회
- 최근 web/worker 로그에서 error, exception, failed 패턴 없음

## 데이터 해석 원칙

질문 세트 삭제는 과거 데이터셋을 삭제하지 않는다. 이 정책은 연구자가 현재 편집 상태를 정리하면서도 이미 수행한 벤치마크의 재현성을 잃지 않도록 하기 위한 것이다. 같은 이유로 세트에서 문항을 제거해도 원본 질문 revision과 기존 데이터셋 snapshot은 남는다. “현재 편집 상태”와 “과거 실험에 사용한 불변 입력”을 분리하는 것이 이번 변경의 핵심이다.

엄격한 DB 불변성은 현재 dataset row와 `question_id + question_revision + ordinal` membership까지다. 기존 question revision 본문과 evidence를 발행 후 직접 UPDATE하지 못하게 하는 참조 기반 trigger는 아직 없으므로, 완전한 tamper-evident archive라고 표현하지 않는다. 애플리케이션은 기존 revision을 수정하지 않고 새 revision을 추가하는 방식으로 운영한다.
