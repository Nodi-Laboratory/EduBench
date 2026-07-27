# EduBench

국내 교과서 근거로 AI 모델의 선수관계 이해와 교육적 추론을 비교하고, 다른 프로젝트의 소개·검증 자료에 사용할 재현 가능한 근거표를 만드는 로컬 벤치마크 연구 플랫폼입니다. 시연용 고정 점수나 하드코딩된 질문은 사용하지 않으며, 결과 화면은 실제 저장 응답과 채점값만 집계합니다.

## 현재 작동 방식

```text
교과서 PDF
  → 300 DPI 무손실 페이지 렌더
  → Upstage 페이지별 병렬 Document Parse
  → HTML 구조 기반 청킹 + 목차-청크 정렬
  → Gemini 임베딩 + pgvector
  → 문항마다 방향 생성 → 독립 벡터 검색 → 질문 생성
  → 사람 검수 + 질문 세트 배정
  → 내용 해시가 고정된 불변 데이터셋 발행
  → 선택 모델 실행
  → 정답·선수관계·근거 채점
  → 실시간 분석·감사·내보내기
```

핵심 동작은 다음과 같습니다.

1. PDF를 페이지 batch로 렌더링하고 한 페이지씩 Upstage Document Parse에 병렬 요청합니다.
2. 페이지 HTML/Markdown, provider 원응답, 렌더 정보를 revision별 artifact로 보존합니다.
3. 교과서 앞 10쪽에서 목차를 추출하고 현재 revision의 청크와 연결합니다.
4. 질문 하나마다 Gemini가 별도의 목표·선수 개념 검색 방향을 생성합니다.
5. 그 문항 전용 검색 문장을 임베딩하고, 선택한 교과서 revision과 목차 범위 안에서만 pgvector cosine top-k 검색을 실행합니다.
6. 검색한 청크만 근거로 질문·정답·루브릭·선수관계 설계를 생성하고, 모든 인용 chunk ID를 검증합니다.
7. 연구자는 질문을 검수하면서 기존 질문 세트를 선택하거나 새 세트를 만들 수 있습니다.
8. 편집 가능한 세트를 발행하면 질문 revision과 순서가 고정된 불변 데이터셋이 됩니다.
9. 벤치마크 실행은 발행 데이터셋을 명시적으로 선택하고, 모델별 실제 요청·응답·토큰·지연시간·오류·점수를 기록합니다.
10. 결과는 모델·지표·목적·문항별 그래프와 JSON/CSV/PDF 근거 자료로 확인할 수 있습니다.

## 연구 방법론의 경계

EduBench는 [Microsoft PIKE-RAG](https://github.com/microsoft/PIKE-RAG)의 “필요한 지식을 먼저 계획하고 검색하는” 원리와 [K12-KGraph/K12-Bench](https://github.com/haolpku/K12-Dataset)의 교과 계층·선수관계 과제 분리 원리를 참고한 독립 구현입니다.

- PIKE-RAG의 원자 질문 이중 인덱스와 반복 proposer-selector 전체를 구현한 것은 아닙니다.
- K12-KGraph의 중국 교과서 데이터, 지식 그래프, 질문 또는 코드는 포함하지 않습니다.
- 현재 구현은 문항별 방향 생성과 한 번의 범위 제한 벡터 검색을 사용합니다.
- 현재 선수관계는 LLM이 검색 근거에서 설계하고 연구자가 검수합니다. 전문가 검증 gold graph와 동일하지 않습니다.

구현·차용 범위·수식·한계는 [시스템 아키텍처와 연구 방법론](docs/research/2026-07-27-edubench-system-architecture-and-research-foundations.md)에 상세히 기록했습니다.

## 주요 연구 화면

| 경로 | 기능 |
|---|---|
| `/dashboard` | 파싱·생성·실행·채점 전체 흐름과 실시간 이벤트 |
| `/sources` | 교과서 등록·삭제, revision, 목차, 페이지 artifact, 청크·임베딩 로그 |
| `/document-lab` | 저장 없이 Upstage 파싱 입력과 HTML/Markdown 결과 비교 |
| `/generation` | 자료·목차·목적·형식·난이도 선택, 조립 프롬프트와 문항별 생성 진행 |
| `/review` | 질문·답안·근거 요약·선수관계 설계 검수, 질문 세트 선택·생성 |
| `/datasets` | 질문 세트 생성·삭제·문항 제거, 불변 데이터셋 발행 |
| `/runs` | 발행 데이터셋과 모델 선택, 실시간 요청·응답·점수·오류, 중지·재개 |
| `/results` | 모델·지표·목적·문항별 표와 그래프, 근거 자료 내보내기 |
| `/settings` | 파싱·임베딩/RAG·질문 생성·벤치마크 모델 설정의 버전 관리 |

UI는 320–1920 CSS px 범위에서 작업 정보가 문서 바깥으로 밀리지 않도록 반응형으로 구성했습니다. 긴 JSON·해시·표는 해당 패널 안에서 줄바꿈 또는 스크롤하며, 좁은 화면에서도 검수 evidence를 숨기지 않습니다.

## Docker 실행

Docker Desktop이 실행 중인 환경에서:

```powershell
Copy-Item .env.example .env
# .env에 실제로 사용할 API 키만 입력
docker compose up --build
```

웹: `http://localhost:63000/`

`.env`는 Git에서 제외됩니다. 모델 ID와 생성·파싱·임베딩 파라미터는 `/settings`의 버전형 연구 프로필에 있으며, 일반적으로 `.env`에는 API 키만 입력하면 됩니다.

```dotenv
GOOGLE_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com

UPSTAGE_API_KEY=
UPSTAGE_BASE_URL=https://api.upstage.ai/v1

EXAONE_API_KEY=
EXAONE_BASE_URL=https://api.friendli.ai/serverless/v1
```

`*_BASE_URL`에는 `/document-digitization`, `/models/...:generateContent`, `/chat/completions` 같은 개별 endpoint suffix를 붙이지 않습니다. adapter가 공통 URL 뒤에 필요한 resource path를 추가합니다.

로컬 파이프라인만 API 비용 없이 검증할 때는 `MOCK_PROVIDERS=true`를 사용할 수 있습니다. mock 응답과 데이터에는 공식 근거 사용 금지 표시가 남습니다. 연구 결과를 만들 때는 반드시 `false`와 실제 provider를 사용해야 합니다.

## 개발 실행

```powershell
npm install
docker compose up -d db
Copy-Item .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

별도 터미널에서 worker를 실행합니다.

```powershell
npm run worker
```

## Document Lab과 기본 파싱 설정

`http://localhost:63000/document-lab`에서 PDF, PNG, JPEG, WebP 파일을 일회성으로 파싱하고 원본 페이지와 Upstage 결과를 비교할 수 있습니다. 업로드와 결과는 DB에 저장되지 않으며 API 키는 브라우저로 전달하지 않습니다.

현재 기본 연구 프로필:

- PDF: 300 DPI 무손실 PNG
- 렌더: 10쪽/batch
- parser 호출: 한 페이지/request, 병렬 실행
- `ocr=force`
- `mode=enhanced`
- 기본 출력: HTML
- `base64_encoding=["table","figure","chart","equation"]`

실제 값은 `/settings`의 활성 `document_parse` 프로필을 자동으로 따르므로, 설정을 바꾸면 Document Lab에도 반영됩니다.

## 질문 세트와 데이터셋

승인 문항을 하나의 고정 묶음으로 자동 합치지 않습니다.

- 검수 화면에서 승인할 질문 세트를 고르거나 새 세트를 만듭니다.
- 데이터셋 화면에서 세트를 삭제하거나 세트 안의 문항만 제거할 수 있습니다.
- 세트 삭제는 soft delete이며 원본 질문과 이미 발행한 데이터셋은 유지됩니다.
- 실행에는 편집 가능한 세트가 아니라 발행 시점의 질문 revision과 순서가 고정된 데이터셋을 사용합니다.
- 데이터셋 content hash와 DB trigger가 발행된 dataset row와 질문 membership 변경을 막습니다.

이번 변경의 상세 내용은 [2026-07-27 변경 기록](docs/progress/2026-07-27-question-set-and-responsive-ui.md)에 있습니다.

## 검증

```powershell
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

통합 테스트는 `DATABASE_URL_TEST`를 사용합니다. 비어 있으면 `DATABASE_URL`의 DB 이름에 `_test`를 붙인 별도 DB를 자동 생성하며 운영 DB에는 테스트 레코드를 만들지 않습니다.

## 데이터와 재현성

- source revision마다 parser·embedding 설정 snapshot과 hash를 고정합니다.
- 페이지 artifact와 provider 원응답은 수정 방지 상태로 보존합니다.
- 선택 목차는 실제 검색 후보 SQL을 제한합니다.
- 생성 item마다 방향, 검색 문장·벡터 감사 정보, 검색 청크, provider 요청·응답을 저장합니다.
- 게시된 데이터셋 row와 `question_id + revision + ordinal` membership은 DB trigger로 수정할 수 없습니다.
- 실행에는 데이터셋, 채점·가격 프로필, 시스템 프롬프트, 모델 ID와 파라미터 snapshot을 복사합니다.
- 제공자 오류·재시도·lease 회수·상태 전이는 이벤트 로그로 남습니다.
- CSV/JSON 내보내기는 질문 revision, 블라인드 모델 ID, 원응답, 정규화 응답, 토큰, 지연시간, 비용, 점수와 rationale을 포함합니다.

발행 데이터셋의 불변 trigger는 dataset row와 membership에 적용됩니다. 참조된 question revision 본문·evidence·source chunk 전체를 발행 상태에 따라 동결하는 것은 후속 보완 대상이며, 정확한 경계는 상세 연구 문서에 기록했습니다. 페이지 artifact, 연구 profile, 생성·채점 감사 레코드 등에는 별도의 변경 방지 규칙이 적용됩니다.

## 문서

- [EduBench 시스템 아키텍처와 연구 방법론](docs/research/2026-07-27-edubench-system-architecture-and-research-foundations.md)
- [질문 세트·반응형 연구 UI 변경 기록](docs/progress/2026-07-27-question-set-and-responsive-ui.md)
- [벤치마크 선행 조사](docs/research/2026-07-20-benchmark-research.md)
- [공식 모델 API 조사](docs/research/2026-07-20-provider-api-research.md)
- [제품·화면·데이터 설계](docs/superpowers/specs/2026-07-20-edubench-design.md)
- [구현 계획](docs/superpowers/plans/2026-07-20-edubench-implementation.md)
