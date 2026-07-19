# EduBench

국내 교과서 근거로 AI 모델의 교육 적합성을 비교하고, 별도 프로젝트 소개 자료에 사용할 재현 가능한 근거표를 만드는 로컬 벤치마크 운영 플랫폼입니다. 시연용 고정 점수는 사용하지 않습니다. 결과 화면은 실제 저장 응답과 채점값이 있을 때만 집계합니다.

## 주요 흐름

1. PDF 교과서를 등록합니다.
2. 워커가 Upstage Document Parse, 의미 청킹, Gemini 임베딩을 수행합니다.
3. 범위와 역량 조건을 지정해 질문을 생성하고 사람이 질문·답안·루브릭·근거를 검수합니다.
4. 승인된 500문항을 내용 해시가 고정된 불변 데이터셋 버전으로 확정합니다.
5. 데이터셋 × 선택 모델의 전체 실행 행렬을 생성하고 일시정지·재개·취소·실패 재시도를 통제합니다.
6. 실제 응답, 제공사 원문 JSON, 토큰, 지연시간, 가격 프로필 비용과 점수를 PostgreSQL에 보존합니다.
7. 결과를 모델·역량별로 분석하고 문항 단위 JSON/CSV 근거표와 요약 PDF로 내보냅니다.

## 실행

Docker Desktop이 실행 중인 환경에서:

```powershell
Copy-Item .env.example .env
# .env에 사용할 제공자의 API 키, 모델 ID, 자체 호스팅 base URL을 입력
docker compose up --build
```

웹: `http://localhost:63000/`

`.env`는 Git에서 제외됩니다. 화면에는 API 키를 입력하거나 연결을 확인하는 기능이 없습니다. 모델 선택 가능 여부만 필수 환경변수의 존재로 판단합니다.

로컬 파이프라인 자체를 API 비용 없이 검증해야 할 때만 `.env`의 `MOCK_PROVIDERS=true`를 사용합니다. 이 모드의 응답에는 공식 결과 사용 금지 경고가 포함됩니다. 근거 자료 산출 시에는 반드시 `false`로 두고 실제 API 설정을 사용해야 합니다.

## 개발 실행

```powershell
npm install
docker compose up -d db
Copy-Item .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

별도 터미널에서 `npm run worker`를 실행합니다.

## 검증

```powershell
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

통합 테스트는 `DATABASE_URL_TEST`를 사용하며, 비어 있으면 `DATABASE_URL`의 DB 이름에 `_test`를 붙인 별도 DB를 자동 생성합니다. 운영 DB에는 테스트 레코드를 만들지 않습니다.

## 데이터와 재현성

- 게시된 데이터셋과 그 문항 목록은 DB 트리거로 수정할 수 없습니다.
- 실행에는 데이터셋, 채점 프로필, 가격 프로필 버전, 시스템 프롬프트, 모델 ID와 파라미터가 복사됩니다.
- 제공사 오류·재시도·임대 회수·상태 전이는 이벤트 로그로 남습니다.
- CSV/JSON 내보내기는 질문 revision, 블라인드 모델 ID, 원응답, 정규화 응답, 토큰, 지연시간, 비용, 점수를 포함합니다.
- 초기 500문항과 실행은 기능 검증용 샘플로 명확히 표시되며 공식 근거로 사용할 수 없습니다.

## 조사 및 설계 문서

- [벤치마크 조사](docs/research/2026-07-20-benchmark-research.md)
- [공식 모델 API 조사](docs/research/2026-07-20-provider-api-research.md)
- [제품·화면·데이터 설계](docs/superpowers/specs/2026-07-20-edubench-design.md)
- [구현 계획](docs/superpowers/plans/2026-07-20-edubench-implementation.md)
- [Superdesign 디자인 시스템](.superdesign/design-system.md)
