# 📚 EduBench

**교과서에서 선수관계 문항을 만들고, 그 문항으로 AI 모델을 벤치마크하는 연구 워크스페이스입니다.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/) [![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](https://react.dev/) [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/) [![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | **한국어**

[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev)

---

## 💭 Developer's Note

> *"모델은 학생이 무엇을 먼저 이해해야 하는지 설명할 수 있을까?"*

<!-- TODO: 개발 동기 -->

---

## ✨ Features

### 📄 교과서 수집
- PDF 페이지를 `pdftoppm`으로 이미지로 만든 뒤 페이지마다 Upstage Document Parse로 보냄
- 돌려받은 HTML을 제목(`h1`/`h2`)과 문단 단위로 청크로 나누고, 단원 도입 페이지에서 목차를 읽음
- 청크는 Gemini(`gemini-embedding-2`, 기본 3072차원)로 임베딩해 PostgreSQL pgvector에 저장
- 업로드별 처리 과정을 실시간 이벤트 로그로 화면에 표시

### 🧪 Document Lab
- PDF, PNG, JPEG, WebP 파일 하나를 저장하지 않고 파싱
- 원본 페이지, 변환된 HTML, 원본 응답을 페이지별로 나란히 표시

### ✏️ 선수관계 문항 생성
- 문항마다 Gemini가 먼저 검색 방향을 설계하고, 그에 맞는 청크를 벡터 검색으로 가져옴
- Gemini가 목표 개념, 선수 개념, 방향이 있는 관계, 추론 단계, 실패 신호를 담은 청사진과 함께 구조화 JSON 문항을 반환
- 인용한 청크 ID는 검색된 근거와 대조하고, JSON이 올바르지 않으면 구조화 교정을 한 번 거침
- 배치는 순차 또는 병렬로 실행하며, 끝나지 않은 문항부터 재개 가능

### ✅ 검수와 데이터셋
- 검수자는 교과서 근거를 보면서 문항을 승인, 수정 후 승인, 보류, 재검토, 삭제
- 승인된 문항은 편집 가능한 질문 세트로 묶음
- 세트를 발행하면 SHA-256 내용 해시가 붙은 불변 데이터셋 버전으로 고정

### 🏁 벤치마크 실행
- 실행은 문항 × 모델 × 검색 조건(RAG 없음, 단순 벡터 RAG, Pike-inspired 스냅샷)의 행렬
- 모델 ID와 생성 파라미터는 버전이 있는 연구 프로필에서 고정 (Gemini, OpenAI, Upstage Solar, K-EXAONE. Claude, Mi:dm 어댑터 포함)
- 일시정지, 중지, 재개, 취소, 재시도 가능. 공급자 rate limit이 걸리면 해당 공급자만 대기 상태로 전환
- Gemini Judge가 모델을 모르는 상태에서 프로필 지표 7개와 선수관계 지표 6개로 채점하고, 모든 Judge 호출을 감사용으로 저장

### 📊 결과 분석과 모니터링
- 검색 조건, 지표, 질문 목적별로 모델을 비교하는 결과 분석과 히트맵
- 결과를 JSON, PDF 보고서, CSV 근거표로 내보내기
- Research Control Room이 DB, worker, 큐, 파이프라인 상태를 Server-Sent Events로 표시

### 🔑 계정과 API 키
- 아이디/비밀번호 계정 (bcrypt 해시, httpOnly 쿠키 기반 서버 세션)
- 공급자 API 키는 브라우저에서 입력하고 localStorage에만 보관
- 파싱, 생성, 실행을 시작할 때만 키를 요청 헤더로 보내며, 서버는 해당 작업 동안 메모리에만 두고 DB나 로그에 쓰지 않음

---

## 🚀 Getting Started

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)와 Docker Compose
- (선택) AI 공급자를 호출하는 기능에 필요한 API 키
  - [Google Gemini](https://aistudio.google.com/apikey): 임베딩, 문항 생성, Judge 채점, 벤치마크 모델
  - [Upstage](https://console.upstage.ai/api-keys): PDF 파싱(Document Parse), 벤치마크 모델(Solar)
  - [OpenAI](https://platform.openai.com/api-keys), [FriendliAI](https://friendli.ai/suite)(K-EXAONE), [Anthropic](https://console.anthropic.com/settings/keys): 벤치마크 모델

### 실행

```bash
git clone https://github.com/Nodi-Laboratory/EduBench.git
cd EduBench
cp .env.example .env
docker compose up
```

http://localhost:63000 에 접속합니다. 포트가 사용 중이면 `.env`의 `WEB_PORT`를 바꿉니다.

처음 기동할 때 컨테이너가 DB 마이그레이션을 적용하고 데모 계정과 합성 데모 데이터를 넣습니다. 데모 데이터는 가상의 교재 2권, 생성·검수된 문항, 발행된 데이터셋, 완료된 벤치마크 실행 1건입니다. 실제 파이프라인을 그대로 거치되 AI API 대신 로컬 대체 응답을 사용했으므로, 점수는 실제 모델 결과가 아닙니다.

### 데모 계정

| Username | Password |
|----------|----------|
| `demo` | `demo1234` |

### API 키
키가 없어도 로그인해서 데모 데이터로 모든 화면을 둘러볼 수 있습니다. PDF 업로드, Document Lab 파싱, 문항 생성, 새 벤치마크 실행은 비활성화되며 어떤 키가 필요한지 안내합니다.

1. **시스템 설정** → **API 키**로 이동
2. 공급자 옆에 키를 붙여 넣고 **저장** 클릭
3. 키는 브라우저 localStorage에만 저장되며, 공급자 작업을 시작하는 요청에만 함께 전송됨

서버는 키를 메모리에만 둡니다. 서버가 재시작되면 진행 중인 벤치마크는 스스로 일시정지하고, 실행 상세 화면에서 재개하면 키가 다시 전송됩니다. `.env`에 `MOCK_PROVIDERS=true`를 설정하면 키 없이 모든 기능이 모의 응답으로 동작합니다.

---

## 🛠️ Tech Stack

| Category | Technology |
|----------|-----------|
| **Framework** | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| **Charts / Icons** | Recharts 3, lucide-react |
| **Validation** | Zod 4 |
| **Document processing** | poppler-utils (`pdftoppm`), cheerio, @react-pdf/renderer (PDF 보고서) |
| **AI** | Google Gemini API, Upstage Document Parse / Solar, OpenAI Responses API, FriendliAI (K-EXAONE), Anthropic Messages API |
| **Database** | PostgreSQL 17 + pgvector, `pg`, SQL 마이그레이션 |
| **Auth** | bcryptjs, 서버 세션 (httpOnly 쿠키) |
| **Testing** | Vitest, Testing Library, Playwright |
| **Infra** | Docker Compose |

---

## 📁 Project Structure

```
EduBench/
├── 📂 src/
│   ├── 📂 app/                    # 페이지와 API 라우트 (App Router)
│   │   ├── 📂 api/                # sources, generation, questions, datasets, runs, results, settings, auth
│   │   ├── 📂 login/ 📂 signup/   # 로그인 / 회원가입 페이지
│   │   └── ...                    # dashboard, document-lab, sources, generation, review, datasets, runs, results, settings
│   ├── 📂 components/             # 화면별 워크스페이스 UI
│   ├── 📂 domain/                 # 청킹, 목차, 프롬프트, 채점 규칙, 연구 프로필
│   ├── 📂 hooks/                  # 실시간 이벤트 스트림, 브라우저 API 키 저장소
│   ├── 📂 server/
│   │   ├── 📂 auth/               # 비밀번호 해시와 세션
│   │   ├── 📂 documents/          # PDF 렌더링, Document Parse, 청크·임베딩 파이프라인
│   │   ├── 📂 questions/          # 방향 설계, 검색, 문항 생성
│   │   ├── 📂 runs/               # 실행 행렬, 실행, 검색 조건
│   │   ├── 📂 scoring/            # Judge 호출과 점수 저장
│   │   ├── 📂 providers/          # 공급자 어댑터와 메모리 내 API 키 범위
│   │   └── 📂 jobs/               # lease 기반 작업 큐
│   ├── proxy.ts                   # 모든 페이지와 API 라우트의 세션 확인
│   ├── instrumentation.ts         # 웹 서버 안에서 백그라운드 worker 시작
│   └── worker.ts                  # 작업, 벤치마크, 채점 루프
├── 📂 db/migrations/              # SQL 마이그레이션 (기동 시 적용)
├── 📂 scripts/
│   ├── seed.ts                    # 런타임 설정 (공급자 설정, 채점 프로필)
│   ├── seed-demo.ts               # 데모 계정과 합성 데모 데이터
│   ├── 📂 demo-seed/              # 합성 교재, 문항 뱅크, 로컬 API 대체 응답
│   └── 📂 capture-screenshots/    # README 스크린샷용 Playwright 스크립트
├── 📂 tests/                      # 단위·통합 테스트
├── 📂 image/                      # 스크린샷
├── Dockerfile                     # 멀티스테이지 빌드 (deps → build → poppler 포함 runtime)
├── docker-compose.yml             # db (pgvector), web
└── .env.example
```

---

## 💡 How to Use

1. **로그인**: 데모 계정을 쓰거나 회원가입 화면에서 계정을 만듭니다
2. **API 키 입력**: **시스템 설정** → **API 키**에서 필요한 키를 입력합니다
3. **교과서 업로드**: **교과서 자료 관리**에서 과목·학년과 함께 PDF를 올리고 실시간 처리 로그를 확인합니다
4. **문항 생성**: **질문 생성**에서 교과서나 단원, 목적, 형식, 난이도, 수량을 고르고 배치를 시작합니다
5. **검수**: **질문 검수**에서 근거와 함께 문항을 확인하고 질문 세트로 승인합니다
6. **데이터셋 발행**: **데이터셋 관리**에서 질문 세트를 불변 버전으로 발행합니다
7. **벤치마크 실행**: **벤치마크 실행**에서 데이터셋, 모델, 검색 조건을 골라 실행을 만들고 상세 화면에서 시작합니다
8. **결과 분석**: **결과 분석**에서 점수를 비교하고 JSON, PDF, CSV로 내보냅니다

---

## 👥 Team

| Name | Role |
|------|------|
| <!-- TODO: 팀원 이름 --> | <!-- TODO: 역할 --> |

---

## 🎨 Screenshots

<p align="center">
  <img src="image/result-analytics.png" alt="결과 분석" width="100%">
</p>

<table>
  <tr>
    <td align="center"><img src="image/login.png" alt="로그인"><br><sub>로그인</sub></td>
    <td align="center"><img src="image/dashboard.png" alt="Research Control Room"><br><sub>Research Control Room</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/sources.png" alt="교과서 자료 관리"><br><sub>교과서 자료와 처리 로그</sub></td>
    <td align="center"><img src="image/document-lab.png" alt="Document Lab"><br><sub>Document Lab (API 키 안내)</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/generation.png" alt="질문 생성"><br><sub>질문 생성</sub></td>
    <td align="center"><img src="image/review.png" alt="질문 검수"><br><sub>청사진과 함께 보는 질문 검수</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/datasets.png" alt="데이터셋 관리"><br><sub>질문 세트와 데이터셋 버전</sub></td>
    <td align="center"><img src="image/runs.png" alt="벤치마크 실행"><br><sub>벤치마크 실행 설정</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="image/run-detail.png" alt="실행 상세"><br><sub>실행 상세</sub></td>
    <td align="center"><img src="image/settings-api-keys.png" alt="API 키 설정"><br><sub>API 키 설정</sub></td>
  </tr>
</table>

---

## 📝 License

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

| 👤 Developer | ✉️ Email |
|:---:|:---:|
| Zanviq | zanviq.dev@gmail.com |
