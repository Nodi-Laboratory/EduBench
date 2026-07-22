# Benchmark Observability and Resumable Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every benchmark request, response, score, and failure inspectable while providing drain-pause, resumable stop, safe retry, and scoring recovery.

**Architecture:** Extend the existing PostgreSQL-backed run state machine and worker rather than introducing another queue. Persist request snapshots on `run_items`, expose one run-detail read model API, and drive the existing React detail page with SSE plus lightweight refreshes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, PostgreSQL 17/pgvector, Zod 4, Vitest, Docker Compose.

## Global Constraints

- Preserve all successful model responses and already stored scores.
- `PAUSE` drains leased calls; `STOP` aborts leased calls and restores them to `PENDING`; both are resumable.
- `CANCEL` remains permanent and is labeled “영구 취소”.
- Persist the exact provider input before the external request.
- Do not add an external queue or authentication layer.

---

### Task 1: State machine and durable control

**Files:**
- Create: `db/migrations/0009_run_observability_control.sql`
- Modify: `src/domain/status.ts`
- Modify: `src/server/runs/service.ts`
- Modify: `src/app/api/runs/[id]/commands/route.ts`
- Test: `tests/unit/status.test.ts`
- Test: `tests/integration/run-controller.test.ts`

**Interfaces:**
- Produces: `request_snapshot`, `control_requested_at`, and `last_scoring_error` persistence.
- Produces: `finishPauseWhenDrained(runId)`, `finishStopWhenDrained(runId)`, and `restoreStoppedRunItems(runId)`.

- [ ] **Step 1: Write failing state and integration tests**

```ts
expect(transitionRun('RUNNING', 'PAUSE')).toBe('PAUSING');
expect(transitionRun('PAUSED', 'RESUME')).toBe('RUNNING');
expect(transitionRun('RUNNING', 'STOP')).toBe('STOPPING');
expect(transitionRun('STOPPED', 'RESUME')).toBe('RUNNING');
```

- [ ] **Step 2: Run tests and confirm the new states and commands are rejected**

Run: `npm test -- tests/unit/status.test.ts && npm run test:integration -- tests/integration/run-controller.test.ts`
Expected: failures for missing `PAUSING`, `STOPPING`, `STOPPED`, and `STOP`.

- [ ] **Step 3: Add migration and transactional state transitions**

```sql
alter table run_items add column if not exists request_snapshot jsonb;
alter table benchmark_runs add column if not exists control_requested_at timestamptz;
alter table benchmark_runs add column if not exists last_scoring_error jsonb;
```

`retryFailedRunItems` must lock the run, reset only terminal failures, recompute counters, and move `SCORING`/`FAILED` back to `RUNNING` when at least one item is retried.

- [ ] **Step 4: Run state and controller tests**

Run: `npm test -- tests/unit/status.test.ts && npm run test:integration -- tests/integration/run-controller.test.ts`
Expected: pass.

### Task 2: Cooperative worker interruption and request snapshots

**Files:**
- Modify: `src/server/runs/executor.ts`
- Modify: `src/server/runs/service.ts`
- Modify: `src/worker.ts`
- Test: `tests/integration/run-execution.test.ts`

**Interfaces:**
- Produces: exact `request_snapshot` before `provider.generate`.
- Produces: `interruptRunItem(itemId, workerId)` that returns a stopped lease to `PENDING` without incrementing terminal failures.

- [ ] **Step 1: Write failing tests for request persistence and stopped lease recovery**

```ts
expect(stored.request_snapshot).toMatchObject({
  system: '교과서 근거에 따라 답하라.',
  prompt: expect.stringContaining('[질문]'),
  providerKey: 'fake',
});
expect(stoppedItem).toMatchObject({ state: 'PENDING', lease_owner: null });
```

- [ ] **Step 2: Confirm tests fail because snapshots and STOP recovery do not exist**

Run: `npm run test:integration -- tests/integration/run-execution.test.ts`
Expected: missing column/function assertions fail.

- [ ] **Step 3: Persist the snapshot and poll control state during provider calls**

Build `system` and `prompt` once, store them transactionally, and combine timeout/lease/control AbortSignals. Map stop-driven aborts to `PENDING`; retain timeout/network errors as normal retry/failure behavior.

- [ ] **Step 4: Make the worker settle PAUSING and STOPPING runs**

The worker calls `finishPauseWhenDrained` and `finishStopWhenDrained` every loop and emits `RUN_PAUSED` or `RUN_STOPPED` exactly once.

- [ ] **Step 5: Run execution integration tests**

Run: `npm run test:integration -- tests/integration/run-execution.test.ts tests/integration/run-controller.test.ts`
Expected: pass.

### Task 3: Scoring normalization and bounded failure recovery

**Files:**
- Modify: `src/server/scoring/service.ts`
- Modify: `src/worker.ts`
- Test: `tests/unit/scoring.test.ts`
- Test: `tests/integration/run-execution.test.ts`

**Interfaces:**
- Produces: `normalizeJudgeEvidence(value): Array<{claim?: string; quote?: string; chunkId?: string}>`.
- Produces: scoring failure persistence and `RUN_SCORING_FAILED` events without crashing the worker loop.

- [ ] **Step 1: Write a failing normalization test**

```ts
expect(normalizeJudgeEvidence(['교과서와 일치', { quote: '원문' }])).toEqual([
  { claim: '교과서와 일치' },
  { quote: '원문' },
]);
```

- [ ] **Step 2: Verify the test fails because the function is absent**

Run: `npm test -- tests/unit/scoring.test.ts`
Expected: import/function failure.

- [ ] **Step 3: Normalize judge evidence before Zod validation and persist scoring errors**

Accept string and object evidence entries, reject unusable values, clear `last_scoring_error` on successful completion, and emit a sanitized error event on failure.

- [ ] **Step 4: Run scoring tests**

Run: `npm test -- tests/unit/scoring.test.ts && npm run test:integration -- tests/integration/run-execution.test.ts`
Expected: pass.

### Task 4: Run detail API and UI

**Files:**
- Create: `src/app/api/runs/[id]/details/route.ts`
- Modify: `src/app/runs/[id]/page.tsx`
- Modify: `src/components/runs/run-controller.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/unit/workflow-pages.test.tsx`
- Test: `tests/integration/run-details.test.ts`

**Interfaces:**
- Produces: `{ run, profile, models, items }`, where each item includes question, request snapshot, response, scores, failure, and retry metadata.

- [ ] **Step 1: Write failing API and component tests**

```ts
expect(body.items[0]).toMatchObject({
  questionText: expect.any(String),
  request: expect.any(Object),
  response: expect.any(Object),
  scores: expect.any(Array),
});
expect(screen.getByText('실제 전송 프롬프트')).toBeInTheDocument();
expect(screen.getByText('평가 프로필')).toBeInTheDocument();
```

- [ ] **Step 2: Run and confirm missing API/UI failures**

Run: `npm test -- tests/unit/workflow-pages.test.tsx && npm run test:integration -- tests/integration/run-details.test.ts`
Expected: missing route/labels fail.

- [ ] **Step 3: Implement the read model and expandable UI**

Return all item details from one bounded query set. Add model/state filters, expandable panels, explicit failure messages, score rationales, profile metrics/rubric/model/hash, and live refresh after SSE events.

- [ ] **Step 4: Run UI and details tests**

Run: `npm test -- tests/unit/workflow-pages.test.tsx && npm run test:integration -- tests/integration/run-details.test.ts`
Expected: pass.

### Task 5: Provider correction, current-run recovery, and verification

**Files:**
- Modify: `.env.example`
- Modify: `.env` (local runtime only; never commit secrets)
- Modify: `scripts/seed.ts`

**Interfaces:**
- Uses: official Friendli OpenAI-compatible Base URL `https://api.friendli.ai/serverless/v1`.

- [ ] **Step 1: Correct the Friendli Base URL and verify one minimal request**

Update `EXAONE_BASE_URL` without exposing the API key. Use the configured model ID and record only HTTP status/error class.

- [ ] **Step 2: Rebuild Docker and migrate**

Run: `docker compose up -d --build`
Expected: DB, web, and worker healthy; migration 0009 applied once.

- [ ] **Step 3: Recover the current run without deleting successes**

Invoke failed-item retry so the run returns to `RUNNING`. Verify Gemini and Upstage response counts remain 30 each while EXAONE processes only its 30 failed items; scoring resumes idempotently.

- [ ] **Step 4: Run complete verification**

Run: `npm test -- --run`, `npm run test:integration`, `npm run build`, HTTP checks for `/runs/<id>`, and DB count/state checks.
Expected: all tests and build pass; no run remains stuck due unhandled scoring parse errors.
