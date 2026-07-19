# EduBench 모델·문서 처리 API 조사 보고서

- 조사일: 2026-07-20
- 대상: Google Gemini, Anthropic Claude, OpenAI, LG EXAONE, Upstage Solar/Document Parse, KT Mi:dm
- 목적: `.env` 기반 실제 API 연동을 구현하기 전에 공식 공개 규격과 비공개 영역을 구분하고 공통 어댑터 설계를 확정한다.
- 원칙: 모델 ID와 가격·제한은 변경 가능성이 높으므로 코드에 고정하지 않고 환경변수와 실행 스냅샷으로 관리한다.

## 1. 요약 결론

6개 제공사를 하나의 SDK로 억지로 통일하지 않는다. 앱 내부에 작은 공통 요청·응답 계약을 정의하고 제공사별 어댑터에서 공식 SDK 또는 OpenAI 호환 API로 변환한다.

권장 프로토콜:

- Gemini: Google Gen AI 공식 SDK 또는 REST `generateContent`
- Claude: Anthropic 공식 Messages API
- OpenAI: 공식 Responses API
- Upstage Solar: OpenAI 호환 Chat Completions API
- LG EXAONE: 사용 권한으로 제공된 API가 OpenAI 호환이면 공통 호환 어댑터; 공개 공식 문서는 자체 호스팅 OpenAI 호환 서버만 확인됨
- KT Mi:dm: 사용 권한으로 제공된 API가 OpenAI 호환이면 공통 호환 어댑터; 공개 공식 모델 카드는 vLLM OpenAI 호환 배포만 확인됨

EXAONE과 Mi:dm의 계약형 API 엔드포인트 세부 규격은 공개 공식 자료에서 확인되지 않았다. 따라서 URL, 모델 ID, 인증 헤더 방식은 `.env`에서 주입하고 OpenAI 호환을 기본 가정으로 하되, 실제 발급 문서가 다른 경우 해당 어댑터만 교체한다.

## 2. 공통 내부 계약

### 요청

```ts
type BenchmarkRequest = {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  metadata: {
    runId: string;
    questionId: string;
    modelConfigId: string;
    attempt: number;
  };
};
```

### 응답

```ts
type BenchmarkResponse = {
  text: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  providerRequestId: string | null;
  returnedModel: string | null;
  rawResponse: unknown;
};
```

공통 계약에 없는 제공사별 파라미터는 `provider_options` JSON으로 모델 설정 버전에 저장한다. 단, 주 벤치마크에서는 제공사 전용 기능을 사용하지 않는다.

## 3. Google Gemini

### 확인된 공식 규격

- 텍스트 생성: `generateContent`
- 스트리밍: `streamGenerateContent` SSE
- 대량 비동기 처리: Batch API
- 임베딩: `embedContent`, `batchEmbedContents`
- 인증: `x-goog-api-key`
- 공식 SDK: Google Gen AI SDK

공식 문서:

- API 개요: https://ai.google.dev/api
- 텍스트 생성: https://ai.google.dev/gemini-api/docs/text-generation
- Batch API: https://ai.google.dev/gemini-api/docs/batch-api
- 임베딩: https://ai.google.dev/gemini-api/docs/embeddings
- OpenAI 호환 계층: https://ai.google.dev/gemini-api/docs/openai

### EduBench 적용

- 문항 생성과 구조화 출력에 사용한다.
- 교과서 청크 임베딩에 Gemini 임베딩 모델을 사용한다.
- 질의와 문서의 task type을 지원하는 모델에서는 검색 목적에 맞는 task type을 구분한다.
- 임베딩 모델과 출력 차원을 버전으로 저장한다. 모델 또는 차원이 바뀌면 기존 벡터와 섞지 않는다.
- Batch API는 비용 면에서 유리하지만 주 벤치마크 컨트롤러의 실시간 중단·재개 방식과 분리한다.

## 4. Anthropic Claude

### 확인된 공식 규격

- 기본 생성: `POST /v1/messages`
- 시스템 프롬프트: 메시지 배열의 `system` role이 아니라 최상위 `system` 필드
- 토큰 사전 계산: Token Counting API
- 대량 비동기 처리: `POST /v1/messages/batches`
- 오류: JSON 오류 객체와 `request_id`; 429·5xx·529 등 일시 오류는 backoff 대상
- rate limit: RPM, 입력 토큰/분, 출력 토큰/분; `retry-after` 헤더 제공

공식 문서:

- Messages API: https://platform.claude.com/docs/en/api/messages/create
- Message Batches: https://platform.claude.com/docs/en/api/messages/batches
- 토큰 계산: https://platform.claude.com/docs/en/build-with-claude/token-counting
- 오류: https://platform.claude.com/docs/en/api/errors
- rate limit: https://platform.claude.com/docs/en/api/rate-limits

### EduBench 적용

- 공식 Anthropic SDK를 사용한다.
- 공통 시스템 프롬프트를 최상위 `system`으로 변환한다.
- 429는 실패로 확정하지 않고 `retry_wait` 상태로 저장한다.
- 529와 5xx는 지수 backoff 후 재시도한다.
- 응답의 usage와 request ID를 원본과 함께 저장한다.

## 5. OpenAI

### 확인된 공식 규격

- 최신 모델 생성 인터페이스: Responses API
- 대량 비동기 처리: Batch API
- 임베딩: `/v1/embeddings`
- 모델별 snapshot을 사용할 수 있는 경우 재현성을 위해 별칭보다 snapshot을 우선
- Batch는 비동기 파일 기반 요청, 별도 rate limit pool, 비용 절감, 24시간 처리 창을 제공

공식 문서:

- Responses 생성: https://developers.openai.com/api/reference/resources/responses/methods/create
- Batch API: https://developers.openai.com/api/docs/guides/batch
- 임베딩: https://developers.openai.com/api/docs/guides/embeddings
- 모델 목록: https://developers.openai.com/api/docs/models
- 평가 설계 권고: https://developers.openai.com/api/docs/guides/evaluation-best-practices

### 중요 변경사항

공식 문서 기준으로 기존 Evals 플랫폼은 2026-10-31 읽기 전용 전환, 2026-11-30 종료 예정이라고 안내되어 있다. EduBench의 핵심 평가 데이터를 OpenAI Evals 플랫폼에 의존시키지 않는다.

### EduBench 적용

- 공식 OpenAI SDK와 Responses API를 사용한다.
- `store` 등 제공사 상태 저장 기능에 의존하지 않고 모든 실행 상태는 로컬 PostgreSQL에 저장한다.
- 모델 ID는 `.env`에서 주입하고 run 시작 시 모델 설정 스냅샷으로 복사한다.
- 제공사 도구는 주 벤치마크에서 비활성화한다.

## 6. Upstage

### Solar 생성 API

공식 콘솔 예제에서 다음을 확인했다.

- OpenAI SDK 호환
- base URL: `https://api.upstage.ai/v1`
- Chat Completions 형식
- 모델 ID는 콘솔에서 선택하며 변경 가능

출처:

- Chat 예제: https://console.upstage.ai/api-keys?api=chat
- Reasoning Chat 예제: https://console.upstage.ai/api-keys?api=chat-reasoning

### Document Parse

공식 콘솔 예제에서 다음을 확인했다.

- endpoint: `POST https://api.upstage.ai/v1/document-digitization`
- multipart 파일 업로드
- `Authorization: Bearer <UPSTAGE_API_KEY>`
- `model=document-parse`
- OCR 모드와 표 base64 옵션 지원

출처: https://console.upstage.ai/api-keys?api=document-parsing

### EduBench 적용

- Solar는 OpenAI 호환 어댑터로 연결한다.
- Document Parse는 별도 문서 처리 클라이언트로 구현한다.
- 원본 JSON과 추출 HTML을 모두 저장한다.
- 업로드 파일, Parse 모델, 요청 옵션, 응답 버전을 기록한다.
- 표·이미지 base64 데이터는 본문 HTML과 분리 저장할 수 있게 한다.

## 7. LG EXAONE

### 공개 공식 자료에서 확인된 내용

LG AI Research의 공식 EXAONE 4.5 저장소는 TensorRT-LLM, vLLM, SGLang, llama.cpp를 통한 자체 호스팅과 OpenAI 호환 `/v1` 서버 사용법을 제공한다.

출처:

- EXAONE 4.5 공식 저장소: https://github.com/LG-AI-EXAONE/EXAONE-4.5
- EXAONE 4.0 공식 저장소: https://github.com/LG-AI-EXAONE/EXAONE-4.0
- EXAONE 4.5 기술 보고서: https://arxiv.org/abs/2604.08644

### 확인되지 않은 내용

- 사용자가 보유한 계약형 EXAONE API의 공개 base URL
- 인증 헤더 규격
- batch 지원 여부
- 사용 가능한 정확한 모델 ID
- 토큰 사용량·비용 응답 구조

공개 자료만으로 사설 API 규격을 추정하지 않는다.

### EduBench 적용

- 기본 어댑터는 OpenAI 호환 Chat Completions로 구현한다.
- `.env`의 base URL, API key, model ID를 사용한다.
- 계약형 API가 다른 규격이면 `ExaoneAdapter` 내부만 교체한다.
- reasoning mode와 non-reasoning mode를 같은 결과로 섞지 않고 모델 설정 버전에서 명시한다.

## 8. KT Mi:dm

### 공개 공식 자료에서 확인된 내용

KT의 K-intelligence 공식 모델 카드는 Mi:dm 2.0 Base/Mini Instruct를 공개하고, vLLM으로 OpenAI 호환 API를 제공하는 방법을 안내한다.

출처:

- 공식 모델 카드: https://huggingface.co/K-intelligence/Midm-2.0-Base-Instruct
- 공식 조직 페이지: https://huggingface.co/K-intelligence
- Mi:dm 2.0 기술 보고서: https://arxiv.org/abs/2601.09066
- 공식 프롬프트 가이드: https://ai.kt.com/resource/pdfs/ai/midm_2.0_Prompt_Guide_2025.09_R.pdf

### 확인되지 않은 내용

- 사용자가 보유한 계약형 Mi:dm API의 공개 base URL
- 인증 헤더와 quota 규격
- batch 지원 여부
- 제공 모델 ID와 usage 응답 구조

### EduBench 적용

- 기본 어댑터는 OpenAI 호환 Chat Completions로 구현한다.
- base URL, key, model ID를 `.env`에서 주입한다.
- 계약형 API가 다르면 `MidmAdapter`만 교체한다.

## 9. 환경변수 초안

연결 확인 화면은 만들지 않는다. 누락된 모델은 실행 생성 시 명확한 설정 오류를 반환하고, 호출 실패는 실행 로그에 남긴다.

```dotenv
# Database
DATABASE_URL=postgresql://edubench:edubench@postgres:5432/edubench

# Google
GEMINI_API_KEY=
GEMINI_GENERATION_MODEL=
GEMINI_EMBEDDING_MODEL=
GEMINI_EMBEDDING_DIMENSIONS=1536

# Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=

# Upstage
UPSTAGE_API_KEY=
UPSTAGE_BASE_URL=https://api.upstage.ai/v1
UPSTAGE_MODEL=
UPSTAGE_DOCUMENT_PARSE_MODEL=document-parse

# LG EXAONE: contract or self-hosted endpoint
EXAONE_API_KEY=
EXAONE_BASE_URL=
EXAONE_MODEL=
EXAONE_PROTOCOL=openai_chat_completions

# KT Mi:dm: contract or self-hosted endpoint
MIDM_API_KEY=
MIDM_BASE_URL=
MIDM_MODEL=
MIDM_PROTOCOL=openai_chat_completions

# Evaluation judge: separate from candidate model identifiers
JUDGE_PROVIDER=
JUDGE_MODEL=
JUDGE_API_KEY=
```

실제 `.env`는 Git에 포함하지 않고 `.env.example`만 제공한다. 이는 권한 시스템을 추가하려는 목적이 아니라 키를 코드와 분리하기 위한 최소 운영 방식이다.

## 10. 오류 정규화

```ts
type ProviderErrorKind =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "overloaded"
  | "invalid_request"
  | "content_blocked"
  | "provider_server"
  | "network"
  | "unknown";
```

### 재시도 정책

- 재시도: rate limit, timeout, overloaded, 일부 5xx, network
- 재시도하지 않음: configuration, authentication, invalid request, content blocked
- 최대 횟수와 backoff는 provider model config에 저장
- 원본 오류 본문과 HTTP 상태는 별도 JSON으로 보관
- 재시도로 성공해도 이전 실패 attempt를 삭제하지 않음

## 11. 비용 계산

가격은 자주 변경되므로 코드에 영구 상수로 박지 않는다.

- `pricing_profile` 테이블에 제공사, 모델 ID, 적용 시작일, 입력/출력/캐시/추론 토큰 단가를 저장한다.
- 실행 당시 pricing profile을 run에 연결한다.
- API가 비용을 직접 반환하지 않으면 usage 토큰과 단가로 추정한다.
- `estimated_cost`로 명시하고 실제 청구액과 같다고 단정하지 않는다.
- 토큰 정보를 제공하지 않는 사설 API는 비용을 `unknown` 또는 수동 단가 기반으로 표시한다.

## 12. Batch API 사용 판단

| 제공사 | 공식 batch 확인 | 주 실행 사용 | 이유 |
|---|---|---|---|
| Gemini | 예 | 아니오 | 내부 일시정지·재개·문항별 재실행 제어가 우선 |
| Anthropic | 예 | 아니오 | 결과 순서와 실시간 상태가 내부 큐 방식과 다름 |
| OpenAI | 예 | 아니오 | 24시간 비동기 처리 창, 별도 파일 작업 필요 |
| Upstage | 공개 확인 부족 | 아니오 | 공통 동작을 보장할 수 없음 |
| EXAONE | 공개 계약 API 확인 불가 | 아니오 | 엔드포인트별 지원 차이 |
| Mi:dm | 공개 계약 API 확인 불가 | 아니오 | 엔드포인트별 지원 차이 |

결론: PostgreSQL 기반 내부 작업 큐에서 개별 호출을 수행한다. 제공사 batch는 후속 비용 최적화 기능이다.

## 13. 재현성 저장 항목

각 응답마다 다음을 저장한다.

- 제공사와 요청한 모델 ID
- 응답이 반환한 모델 ID 또는 버전
- base URL의 논리적 이름(키·민감 쿼리 제외)
- 시스템 프롬프트와 사용자 프롬프트 해시·원문
- 공통 파라미터와 provider options
- 요청·응답 시각
- provider request ID
- 원본 응답 JSON
- 정규화 답변 텍스트
- 입력·출력·추론·캐시 토큰
- finish reason
- attempt와 이전 오류
- 가격 프로필과 추정 비용

## 14. 구현 전 확인이 필요한 외부 정보

앱 구조를 막지는 않지만 실제 첫 공식 실행 전에 다음 정보가 필요하다.

1. 계약형 EXAONE base URL, 인증 방식, 모델 ID
2. 계약형 Mi:dm base URL, 인증 방식, 모델 ID
3. 각 계정에서 실제 사용 가능한 Gemini·Claude·OpenAI·Solar 모델 ID
4. 자동 채점에 사용할 독립 judge 제공사와 모델
5. 교과서 PDF 업로드 용량과 Upstage 계정 제한

연결 테스트 전용 UI는 만들지 않는다. 작은 smoke 실행에서 실제 문항 호출이 성공하는 것으로 연동을 검증한다.

