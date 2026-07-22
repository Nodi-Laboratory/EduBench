# Result Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실제 벤치마크 점수와 실행 통계를 모델·지표·선수관계·문항·효율 관점의 대화형 그래프로 제공한다.

**Architecture:** 서버 모듈이 기존 관계형 데이터에서 분석용 행을 조회하고 순수 함수가 차트 데이터로 정규화한다. 클라이언트 컴포넌트는 해당 데이터만 받아 모델·지표 필터와 Recharts 및 CSS 히트맵을 렌더링한다.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL, Recharts, Vitest, Testing Library

## Global Constraints

- 실제 저장 데이터만 사용하고 목업 또는 하드코딩된 분석 결과를 만들지 않는다.
- 종합점수는 `response_present`를 제외한 평가 지표의 단순 평균이다.
- 결측치는 0점으로 간주하지 않는다.
- 기존 표와 내보내기 기능을 유지한다.
- 모바일에서 차트가 세로로 쌓이도록 한다.

---

### Task 1: 분석 데이터 정규화와 조회

**Files:**
- Create: `src/server/results/analytics.ts`
- Create: `tests/unit/result-analytics.test.ts`
- Create: `tests/integration/result-analytics.test.ts`

**Interfaces:**
- Produces: `buildResultAnalytics(input): ResultAnalytics`
- Produces: `getResultAnalytics(runId): Promise<ResultAnalytics>`

- [ ] **Step 1: Write the failing unit test**

`buildResultAnalytics`가 모델별 종합점수, 지표 행렬, 분포 구간, 결측치 제외를 계산하는 테스트를 작성한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/result-analytics.test.ts`
Expected: FAIL because `src/server/results/analytics.ts` does not exist.

- [ ] **Step 3: Implement the pure analytics builder**

입력 행을 숫자로 정규화하고 `models`, `metricRows`, `purposeRows`, `questionRows`, `distributions`를 생성한다.

- [ ] **Step 4: Write and run the failing integration test**

Run: `npm run test:integration -- tests/integration/result-analytics.test.ts`
Expected: FAIL until `getResultAnalytics` queries actual test-run rows.

- [ ] **Step 5: Implement database aggregation and verify**

Run: `npm test -- --run tests/unit/result-analytics.test.ts && npm run test:integration -- tests/integration/result-analytics.test.ts`
Expected: both files PASS.

### Task 2: 대화형 시각화 화면

**Files:**
- Create: `src/components/results/result-analytics-dashboard.tsx`
- Modify: `src/app/results/[id]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/workflow-pages.test.tsx`

**Interfaces:**
- Consumes: `ResultAnalytics`
- Produces: `ResultAnalyticsDashboard({ analytics })`

- [ ] **Step 1: Write the failing component test**

테스트 데이터로 렌더링했을 때 “종합 성능 비교”, “평가 지표 레이더”, “선수관계 역량”, “성능·효율”, “문항별 히트맵”, “점수 분포”가 표시되고 모델 필터가 작동하는지 검증한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/workflow-pages.test.tsx`
Expected: FAIL because the dashboard component does not exist.

- [ ] **Step 3: Implement charts and filters**

Recharts `BarChart`, `RadarChart`, `ScatterChart`와 CSS 히트맵을 사용해 설계의 아홉 영역을 구현하고 빈 상태를 포함한다.

- [ ] **Step 4: Connect the result page and style responsively**

상세 페이지에서 `getResultAnalytics(id)`를 호출하고 기존 표 위에 대시보드를 배치한다. 모델 색상과 모바일 레이아웃을 CSS에 정의한다.

- [ ] **Step 5: Verify the component**

Run: `npm test -- --run tests/unit/workflow-pages.test.tsx && npm run typecheck`
Expected: PASS with no TypeScript errors.

### Task 3: 전체 검증과 Docker 반영

**Files:**
- Modify only files required by verification failures.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: deployed analysis dashboard at `/results/[id]`.

- [ ] **Step 1: Run all verification commands**

Run: `npm test && npm run test:integration && npm run typecheck && npm run build`
Expected: all commands exit 0.

- [ ] **Step 2: Build and restart the web container**

Run: `docker compose build web && docker compose up -d --no-deps web`
Expected: `edubench-web-1` becomes healthy.

- [ ] **Step 3: Verify the real completed run page**

Open `/results/f08f163d-1acc-47dc-9efa-6aaa0857fafd` and confirm the real three-model charts render without empty-data warnings.
