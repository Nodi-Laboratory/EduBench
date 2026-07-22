# Research Audit Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋 문항과 채점 프로필의 설계·근거·revision·판정 방식을 연구자가 상세히 추적할 수 있는 감사 화면을 구축한다.

**Architecture:** 서버 전용 데이터셋 감사 조회 모듈이 작업 세트와 불변 버전의 문항 revision을 각각 정규화한다. 공용 지표 레지스트리는 설정 화면과 향후 결과 화면이 같은 정의를 사용하게 하며, 기존 페이지 컴포넌트는 검색 가능한 상세 패널만 추가한다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, PostgreSQL, Vitest, Testing Library

## Global Constraints

- 현재 승인 작업 세트와 발행된 불변 데이터셋 버전을 모두 표시한다.
- 발행 버전은 `dataset_questions.question_revision`에 고정된 revision만 표시한다.
- API 키와 환경변수 값은 노출하지 않는다.
- 새 데이터베이스 migration이나 외부 의존성을 추가하지 않는다.
- 기존 데이터셋 확정 폼과 채점 프로필 생성 폼을 유지한다.

---

### Task 1: 채점 지표 설명 레지스트리

**Files:**
- Create: `src/domain/score-metrics.ts`
- Create: `tests/unit/score-metrics.test.ts`

**Interfaces:**
- Produces: `ScoreMetricDefinition`, `describeScoreMetric(metricKey)`, `describeScoreMetrics(metricKeys)`
- Consumes: `prerequisiteMetricRubrics`, `prerequisiteScoringCriteria`

- [ ] **Step 1: Write the failing test**

```ts
test('describes deterministic, judge, prerequisite, and unknown metrics', () => {
  expect(describeScoreMetric('exact_match')).toMatchObject({ method: 'deterministic', range: '0 또는 1' });
  expect(describeScoreMetric('faithfulness')).toMatchObject({ method: 'judge', direction: '높을수록 좋음' });
  expect(describeScoreMetric('prerequisite_relation_accuracy').rubric).toContain('방향');
  expect(describeScoreMetric('custom_metric')).toMatchObject({ label: 'custom_metric', category: '사용자 정의' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/score-metrics.test.ts`
Expected: FAIL because `@/domain/score-metrics` does not exist.

- [ ] **Step 3: Implement the registry**

Create typed definitions for `exact_match`, `response_present`, the base Judge metrics in the default profile, and every prerequisite metric. Unknown keys return a safe custom definition whose authority is the stored profile rubric.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/score-metrics.test.ts`
Expected: PASS.

### Task 2: 데이터셋 감사 조회 계층

**Files:**
- Create: `src/server/datasets/audit.ts`
- Create: `tests/integration/dataset-audit.test.ts`

**Interfaces:**
- Produces: `getDatasetAuditData(): Promise<DatasetAuditData>`
- Produces types: `AuditQuestion`, `DatasetAuditVersion`, `QuestionEvidenceAudit`
- Consumes existing tables: `questions`, `question_revisions`, `question_evidence`, `source_chunks`, `source_files`, `generation_batches`, `dataset_versions`, `dataset_questions`

- [ ] **Step 1: Write the failing integration test**

Create an approved question with revision 1, freeze it, then create revision 2 and update `questions.current_revision`. Assert that the working-set result returns revision 2 while the selected immutable version returns revision 1. Add evidence and `quality_scores.benchmarkDesign`, then assert the normalized result includes the source filename, page, target concept, relations, reasoning steps, and failure signals.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- tests/integration/dataset-audit.test.ts`
Expected: FAIL because `getDatasetAuditData` does not exist.

- [ ] **Step 3: Implement normalized queries**

Use one query for current approved questions and one query for version-pinned questions. Aggregate evidence with `jsonb_agg`, include generation batch model and prompt version, and normalize JSON arrays/objects through small exported pure helpers. Preserve `ordinal`, `lockedRevision`, `currentRevision`, and `revisionDrift` explicitly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration -- tests/integration/dataset-audit.test.ts`
Expected: PASS.

### Task 3: 데이터셋 연구 감사 UI

**Files:**
- Modify: `src/app/datasets/page.tsx`
- Modify: `src/components/datasets/dataset-workspace.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/workflow-pages.test.tsx`

**Interfaces:**
- Consumes: `DatasetAuditData` from Task 2
- Extends: `DatasetWorkspace` props with `workingQuestions` and detailed `versions`

- [ ] **Step 1: Write the failing component test**

Render one working question and one pinned-version question. Assert visible controls and labels for `문항 감사`, `현재 작업 세트`, `고정 revision`, `선수관계 청사진`, `필수 추론 단계`, `교과서 근거`, `생성 provenance`, and a revision-drift warning.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/workflow-pages.test.tsx`
Expected: FAIL because the research audit controls are absent.

- [ ] **Step 3: Implement the UI**

Keep freeze/export behavior. Add a scope switch, text search, purpose/difficulty/type/evidence filters, version selection, and reusable `QuestionAuditCard`. Use nested `<details>` for answer contract, blueprint, evidence, quality JSON, and provenance. Render all stored fields with `—` for absent optional values and clearly label revision drift.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/workflow-pages.test.tsx`
Expected: PASS.

### Task 4: 채점 프로필 연구 감사 UI

**Files:**
- Modify: `src/app/settings/page.tsx`
- Modify: `src/components/settings/settings-workspace.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/workflow-pages.test.tsx`

**Interfaces:**
- Consumes: `describeScoreMetrics()` from Task 1
- Extends score profile data with `runCount` and `recentRuns`

- [ ] **Step 1: Write the failing component test**

Render a profile containing deterministic, Judge, prerequisite, and unknown metrics. Assert the screen exposes metric definitions, method, score interpretation, detailed rubric, full profile prompt, evaluation pipeline, content hash, and a recent run link.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/workflow-pages.test.tsx`
Expected: FAIL because only raw metric chips exist.

- [ ] **Step 3: Extend server query and profile rendering**

Aggregate benchmark run count and the five most recent runs per profile. Render immutable metadata, Judge configuration, a numbered scoring pipeline, metric definition cards, full rubric prompt, and recent run links. Explicitly state that actual request, response, rationale, and evidence are preserved in each linked run detail.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/workflow-pages.test.tsx`
Expected: PASS.

### Task 5: 통합 검증과 화면 확인

**Files:**
- Modify only files from Tasks 1–4 if verification reveals a scoped defect.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- tests/unit/score-metrics.test.ts tests/unit/workflow-pages.test.tsx`
Expected: all focused unit tests PASS.

- [ ] **Step 2: Run complete verification**

Run: `npm test`
Expected: 0 failed tests.

Run: `npm run test:integration`
Expected: 0 failed tests.

Run: `npm run typecheck`
Expected: exit code 0.

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 3: Verify the deployed pages**

Open `/datasets` and `/settings` at desktop and mobile widths. Confirm no page-level horizontal overflow, filters update visible questions, nested audit sections open, immutable revision warnings are visible when applicable, and recent-run links resolve to `/runs/{id}`.

- [ ] **Step 4: Review the diff**

Run: `git diff --check` and `git diff -- src/domain/score-metrics.ts src/server/datasets/audit.ts src/app/datasets/page.tsx src/components/datasets/dataset-workspace.tsx src/app/settings/page.tsx src/components/settings/settings-workspace.tsx src/app/globals.css tests/unit/score-metrics.test.ts tests/unit/workflow-pages.test.tsx tests/integration/dataset-audit.test.ts`
Expected: no whitespace errors and changes restricted to the approved feature.
