# EduBench 작업 진행 현황

작성일: 2026-07-20  
작업 브랜치: `codex/upstage-page-parse`

## 1. 프로젝트 목적

EduBench는 시연용 프로그램이 아니라, 국내 교과서 기반 AI 교육 벤치마크를 실제로 실행하고 다른 프로젝트의 소개 자료에 사용할 근거 데이터를 만드는 내부 운영 도구다.

현재 방향은 다음과 같다.

- 로컬 PostgreSQL과 Docker 사용
- 별도 사용자 권한·인증 기능은 두지 않음
- 공급자 API 키는 서버의 `.env`에서 관리
- 실제 모델 API를 호출해 질문 생성, 답변 실행, 채점 결과와 근거를 저장
- 교과서 문서 처리와 질문 생성 과정의 재현 가능성을 확보

## 2. 지금까지 완료된 주요 작업

### 벤치마크 플랫폼 기본 기능

- 교과서 자료, 질문, 모델, 실행 결과를 관리하는 로컬 DB 구조 구성
- 백그라운드 작업 큐와 워커 기반 실행 구조 구성
- 모델별 답변 실행과 채점 결과 저장 흐름 구현
- Docker 환경에서 웹, 워커, PostgreSQL을 함께 실행할 수 있도록 구성
- 운영 현황과 결과를 확인하는 프런트엔드 화면 구성

### Upstage 문서 처리

- Upstage Document Parse 요청 계약 구현
- PDF를 Poppler `pdftoppm`으로 150 DPI PNG 이미지로 변환
- PDF 전체를 한 번에 전달하지 않고, 각 페이지의 전체 이미지를 페이지 순서대로 Upstage에 전달
- 다음 옵션을 고정 적용

```text
ocr=force
mode=enhanced
base64_encoding=['footnote']
output_formats=['html']
```

- 반환 HTML을 페이지별 `<section data-page="N">` 구조로 보존
- 파싱 결과를 청크로 나누고 임베딩하여 로컬 DB에 저장하는 흐름 연결

### Document Lab

- PDF, PNG, JPEG, WebP 파일을 업로드해 Document Parse 결과를 확인하는 독립 페이지 구현
- 원본 페이지 이미지, HTML 미리보기, HTML 원문, 요소 목록, 원시 JSON, 요청 설정을 탭으로 확인 가능
- MOCK 모드와 실제 Upstage 호출 모드 지원
- API 키는 브라우저로 전달하지 않고 서버에서만 사용
- 미리보기 iframe을 sandbox 방식으로 표시

### 프런트엔드 디자인

- Superdesign을 이용해 Document Lab 비교 작업 화면 설계
- 기존 EduBench 관리 화면과 어울리는 패널형 레이아웃 적용
- 작은 화면에서도 가로 스크롤 없이 사용할 수 있도록 반응형 동작 점검

### 공식 API Base URL 조사

공식 문서를 기준으로 기본 주소를 조사해 `.env.example`에 반영했다.

| 공급자 | 기본 Base URL |
|---|---|
| Gemini | `https://generativelanguage.googleapis.com` |
| Anthropic | `https://api.anthropic.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Upstage | `https://api.upstage.ai/v1` |
| EXAONE | 배포 환경에 따라 달라 공란 |
| Mi:dm | 배포 환경에 따라 달라 공란 |

Base URL은 API 요청 주소의 공통 앞부분이다. 예를 들어 Upstage Base URL 뒤에 `/document-digitization` 경로를 붙여 실제 Document Parse 요청 주소를 만든다.

자세한 조사 기록은 [`docs/research/2026-07-20-provider-api-research.md`](../research/2026-07-20-provider-api-research.md)에 있다.

## 3. 완료된 검증

기능 브랜치의 커밋된 기준 상태에서는 다음 검증을 통과했다.

- 단위 테스트: 49개 통과
- 통합 테스트: 67개 통과
- TypeScript 타입 검사 통과
- ESLint 검사 통과
- Next.js 프로덕션 빌드 통과
- Docker 웹·DB 상태 정상
- 워커 컨테이너에서 Poppler 22.12.0 동작 확인
- Document Lab 업로드와 탭 전환 확인
- 브라우저 콘솔 오류 0건 확인

## 4. 이번 보강에서 구현한 개선 사항

최종 검토에서 대용량 교과서와 장시간 작업에 필요한 운영 안정성 개선이 확인되어 보완 중이다.

현재 코드에 반영했으며 최종 검증 중인 항목:

- PDF 렌더링 결과를 메모리에 전부 올리지 않고 페이지 한 장씩 읽는 스트리밍 방식
- 임시 PDF/PNG 파일의 성공·실패·중단 시 정리
- Document Lab 페이지 수, 렌더링 이미지 용량, 응답 용량 제한
- 파일 MIME 선언과 실제 파일 바이트 형식 일치 검사
- 공급자 오류에서 페이지 번호, 요청 ID, HTTP 상태, 오류 종류만 안전하게 반환
- 오류 응답에서 API 키, 공급자 본문, base64 데이터 제외
- PNG 원본 너비와 높이 추출
- 저장하는 공급자 원시 응답의 최대 크기 제한
- 장시간 작업의 lease heartbeat와 작업 시도 번호 검증
- Upstage 요청 timeout과 작업 취소 신호 전달
- HTML 미리보기 CSP와 referrer 차단
- 비활성 JSON·HTML 탭의 지연 렌더링

현재 집중 테스트 결과:

- 페이지 렌더러: 4/4 통과
- 문서 페이지 파이프라인: 4/4 통과
- Document Lab: 15/15 통과

이 항목들은 전체 테스트를 다시 실행하기 전의 중간 상태다.

## 5. 아직 남은 작업

복잡도를 불필요하게 늘리지 않고 다음 필수 항목만 마무리한다.

1. 변경 사항 커밋
2. 필요 시 현재 브랜치를 기본 브랜치에 통합

## 6. 관련 문서

- 전체 플랫폼 구현 계획: [`docs/superpowers/plans/2026-07-20-edubench-implementation.md`](../superpowers/plans/2026-07-20-edubench-implementation.md)
- Upstage 페이지 파싱 구현 계획: [`docs/superpowers/plans/2026-07-20-upstage-page-parse.md`](../superpowers/plans/2026-07-20-upstage-page-parse.md)
- 공급자 API 조사: [`docs/research/2026-07-20-provider-api-research.md`](../research/2026-07-20-provider-api-research.md)
- 최종 개선 범위: [`.superpowers/sdd/final-fix-brief.md`](../../.superpowers/sdd/final-fix-brief.md)
- 기존 검증 보고서: [`.superpowers/sdd/task-7-report.md`](../../.superpowers/sdd/task-7-report.md)

## 7. 현재 상태 요약

EduBench의 기본 벤치마크 실행 구조와 Upstage 페이지 단위 문서 처리, Document Lab 화면은 구현되어 실제 실행 가능한 상태다. 현재는 새로운 기능을 추가하는 단계가 아니라, 대용량 문서와 장시간 실행에서 중복 처리나 메모리 과다 사용이 발생하지 않도록 마무리 보강하는 단계다.
