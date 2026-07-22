# Upstage 페이지 이미지 파싱 및 HTML 검사실 설계

## 목적

교과서 PDF를 질문 생성 근거로 사용하기 전에 각 페이지를 하나의 완전한 이미지로 렌더링하고, Upstage Document Parse Enhanced가 만든 HTML·요소·원본 응답을 사람이 직접 확인할 수 있게 한다. 검사실은 운영 데이터에 영향을 주지 않는 일회성 도구이며, 운영 파이프라인과 동일한 파서 설정을 사용한다.

## 확정 동작

- PDF 입력은 페이지별 PNG(150 DPI)로 렌더링한다.
- 각 PNG 전체를 Document Parse에 개별 요청한다.
- 이미지 입력은 변환하지 않고 한 페이지로 취급한다.
- 모든 요청은 `ocr=force`, `mode=enhanced`, `base64_encoding=['footnote']`, `output_formats=['html']`을 사용한다.
- 응답 HTML은 `<section data-page="N">`로 감싸 페이지 순서를 보존한다.
- 운영 파이프라인은 모든 페이지의 HTML을 결합한 뒤 기존 청킹·Gemini 임베딩을 수행한다.
- 렌더링 또는 특정 페이지 파싱이 실패하면 전체 문서 처리를 실패시키고 실패 페이지를 오류에 포함한다. 부분 문서를 READY로 만들지 않는다.

## 구성요소

### 페이지 렌더러

`src/server/documents/page-renderer.ts`가 `pdftoppm`을 호출한다. 실행 파일은 `PDFTOPPM_PATH`로 재정의할 수 있고 기본값은 `pdftoppm`이다. 임시 디렉터리는 OS 임시 영역에 만들고 성공·실패와 무관하게 제거한다. Docker runtime에는 `poppler-utils`를 설치한다.

### Upstage 파서

`UpstageDocumentParser.parse()`는 PDF 전용 가정을 제거하고 MIME 타입을 받는다. FormData 필드는 운영과 검사실에서 공유한다. 반환값에는 HTML, 요소 배열, 원본 JSON, request ID, 모델과 실제 요청 설정이 포함된다.

### 운영 파이프라인

원본 PDF를 `renderPdfPages()`로 PNG 배열로 바꾼 뒤 순차 호출한다. 순차 호출은 페이지 순서를 안정적으로 보존하고 Enhanced API의 순간 부하를 제한한다. 원본 JSON은 `{ pages: [...] }` 형태로 source revision에 저장한다.

### Document Lab

- 경로: `/document-lab`
- API: `POST /api/document-lab/parse`
- 입력: PDF, PNG, JPEG, WebP, 최대 100MB
- 출력: 페이지별 data URL, HTML, elements, raw response, request metadata
- MOCK 모드에서는 비용이 발생하지 않는 명시적 샘플 응답을 반환한다.
- 실제 모드에서 `UPSTAGE_API_KEY`가 없으면 409와 설정 안내를 반환한다.

## 화면 설계

검사실의 단일 작업은 “원본 페이지와 구조화 결과가 맞는지 비교”이다. 기존 EduBench의 흰색 운영 콘솔과 파란 상태색을 유지한다.

```text
┌ 파일 업로드 · 고정 요청 설정 · Parse 버튼 ┐
├ 페이지 1  페이지 2 ...                    ┤
├──────────────┬────────────────┬───────────┤
│ 원본 페이지   │ 렌더링 HTML     │ 요소/JSON │
│ 전체 이미지   │ 실제 브라우저뷰 │ 요청 감사 │
└──────────────┴────────────────┴───────────┘
```

특징 요소는 페이지 좌표판이다. 선택한 페이지 번호, 원본 픽셀 크기, 요소 수, request ID를 한 줄에 배치해 결과의 단위를 항상 “한 페이지”로 인식하게 한다. HTML은 격리된 `iframe srcDoc`에서 렌더링해 애플리케이션 CSS와 충돌하지 않게 한다. 원본 JSON은 접을 수 있는 고정폭 영역으로 제공한다. 모바일에서는 원본→HTML→감사 정보 순서로 쌓는다.

## 보안·오류 처리

- API 키는 서버에서만 읽고 응답에 포함하지 않는다.
- `iframe`은 `sandbox` 속성을 사용하고 스크립트를 허용하지 않는다.
- 업로드 MIME과 magic bytes를 모두 검사한다.
- Upstage 오류는 request ID와 페이지 번호를 포함하되 인증 헤더와 base64 본문은 로그·UI에 표시하지 않는다.
- base64 footnote 데이터가 포함된 raw response는 검사실에서만 그대로 보여주고 운영 목록 화면에는 노출하지 않는다.

## 검증

- FormData가 enhanced/force/footnote/html 설정을 전송하는 단위 테스트
- 페이지 렌더러가 실행 인자·순서·임시 파일 정리를 지키는 단위 테스트
- Document Lab API의 파일 검증, MOCK 결과, 실제 파서 위임 통합 테스트
- 페이지 선택, HTML iframe, raw JSON을 검증하는 컴포넌트 테스트
- 전체 타입 검사, 린트, 단위·통합 테스트, 프로덕션 빌드
- Docker에서 PDF 페이지 렌더링과 브라우저 시각 검수

## 환경변수 기본 URL 조사

마지막 작업에서 각 제공자의 공식 문서를 재검증해 `.env.example`과 제공자 API 조사 문서를 갱신한다. 공식 관리형 API가 있는 제공자만 기본 URL을 채운다. EXAONE과 KT Mi:dm처럼 배포 주체에 따라 주소가 달라지는 OpenAI 호환 모델은 빈 값과 설명을 유지한다.
