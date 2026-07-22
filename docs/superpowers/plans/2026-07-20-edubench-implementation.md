# EduBench Full Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-runnable, local PostgreSQL-backed Korean textbook AI benchmark platform with real provider adapters, persistent execution, auditable scoring, and evidence-grade reports.

**Architecture:** A Next.js 16 application provides the operations UI, JSON APIs, and SSE. A separate Node worker uses the same TypeScript domain modules and PostgreSQL database; `FOR UPDATE SKIP LOCKED`, leases, and idempotency provide a persistent queue without Redis. Provider-specific protocols are isolated behind a normalized adapter contract.

**Tech Stack:** Node 22, TypeScript 7, Next.js 16.2.10, React 19.2.7, PostgreSQL 17 + pgvector, `pg`, Zod 4.4.3, Vitest 4.1.10, Playwright 1.61.1, Recharts 3.9.2, Docker Compose.

## Global Constraints

- API keys are read from `.env`; no UI displays or tests provider connectivity.
- No authentication, roles, permissions, Redis, or external cloud database.
- The default dataset profile is 500 questions: 150/120/80/80/70 capability allocation and 400/75/25 evidence-mode allocation.
- All benchmark state, raw responses, retries, model identifiers, scoring profiles, and audit events persist in PostgreSQL.
- EXAONE is never visually or statistically favored; strengths and weaknesses use the same rules as all providers.
- New behavior follows red-green-refactor and every test is observed failing before production implementation.
- Korean UI copy follows `.superdesign/design-system.md` and the Superdesign canvas.

---

## File map

- `src/app/**`: routes, page composition, JSON/SSE handlers
- `src/components/**`: shared console and feature UI
- `src/domain/**`: pure types, validation, state machines, scoring/statistics
- `src/server/db/**`: pool, transactions, migrations, repositories
- `src/server/jobs/**`: queue claim/lease/event services and job handlers
- `src/server/providers/**`: normalized contract and six provider adapters
- `src/worker.ts`: worker process entry point
- `db/migrations/**`: ordered SQL schema
- `tests/unit/**`: pure domain and adapter tests
- `tests/integration/**`: PostgreSQL and HTTP boundary tests
- `tests/e2e/**`: Playwright workflows
- `scripts/**`: migrate, seed, report, smoke helpers
- `storage/**`: gitignored local source/report files mounted by Docker

### Task 1: Toolchain and app shell

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/dashboard/page.tsx`
- Create: `src/components/shell/app-shell.tsx`, `src/components/shell/sidebar.tsx`, `src/components/shell/topbar.tsx`
- Test: `tests/unit/navigation.test.ts`

**Interfaces:**
- Produces: `NAV_ITEMS: readonly NavItem[]`, `AppShell({children})`

- [ ] **Step 1: Add configuration and dependency manifests**

Create scripts `dev`, `build`, `start`, `worker`, `test`, `test:integration`, `test:e2e`, `typecheck`, `lint`, `db:migrate`, and `db:seed`. Configure the `@/*` alias to `src/*` and Vitest for Node plus React tests.

- [ ] **Step 2: Write the failing navigation test**

```ts
import { expect, test } from 'vitest';
import { NAV_ITEMS } from '@/components/shell/navigation';

test('exposes every benchmark workflow without auth or API checks', () => {
  expect(NAV_ITEMS.map((item) => item.href)).toEqual([
    '/dashboard', '/sources', '/generation', '/review',
    '/datasets', '/runs', '/results', '/settings',
  ]);
});
```

- [ ] **Step 3: Verify red**

Run: `npm test -- tests/unit/navigation.test.ts`  
Expected: FAIL because `@/components/shell/navigation` does not exist.

- [ ] **Step 4: Implement the shell**

Create `NAV_ITEMS` with Korean labels and Lucide icon names, render the 232px sidebar and 56px top bar, redirect `/` to `/dashboard`, and implement the dashboard page skeleton using the design tokens.

- [ ] **Step 5: Verify green and static checks**

Run: `npm test -- tests/unit/navigation.test.ts && npm run typecheck && npm run lint`  
Expected: all commands exit 0.

### Task 2: Database schema, migration runner, and seed

**Files:**
- Create: `db/migrations/0001_extensions.sql`, `db/migrations/0002_core.sql`, `db/migrations/0003_benchmark.sql`
- Create: `src/server/db/pool.ts`, `src/server/db/migrate.ts`, `src/server/db/transaction.ts`
- Create: `scripts/seed.ts`
- Test: `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: `db.query`, `withTransaction(fn)`, `migrate()`, and all tables named in the design specification.

- [ ] **Step 1: Write the failing schema test**

```ts
test('installs vector and the auditable benchmark tables', async () => {
  const tables = await listPublicTables(db);
  expect(tables).toEqual(expect.arrayContaining([
    'source_files', 'source_chunks', 'questions', 'question_revisions',
    'dataset_versions', 'benchmark_runs', 'run_items', 'model_responses',
    'scores', 'job_events', 'price_profiles',
  ]));
  expect(await extensionExists(db, 'vector')).toBe(true);
});
```

- [ ] **Step 2: Verify red**

Run: `docker compose up -d db && npm run test:integration -- tests/integration/schema.test.ts`  
Expected: FAIL because migrations and tables do not exist.

- [ ] **Step 3: Implement migrations and runner**

Use `schema_migrations(version text primary key, applied_at timestamptz)` and execute unapplied SQL files transactionally. Add foreign keys, immutable version rows, unique idempotency keys, timestamps, JSONB provider metadata, and `vector(3072)` embeddings.

- [ ] **Step 4: Add deterministic seed data**

Seed six providers, one working dataset profile, representative documents/questions, one paused run with 3,000 items, response metrics, and explicit `sample_data=true` metadata. Never seed API keys.

- [ ] **Step 5: Verify green**

Run: `npm run db:migrate && npm run db:seed && npm run test:integration -- tests/integration/schema.test.ts`  
Expected: PASS and a second migration run reports zero pending migrations.

### Task 3: Domain validation and persistent queue

**Files:**
- Create: `src/domain/status.ts`, `src/domain/errors.ts`, `src/domain/profiles.ts`
- Create: `src/server/jobs/queue.ts`, `src/server/jobs/events.ts`, `src/server/jobs/recovery.ts`
- Test: `tests/unit/status.test.ts`, `tests/integration/queue.test.ts`

**Interfaces:**
- Produces: `transitionRun(current, command)`, `enqueueJob(input)`, `claimJobs(workerId, limit, leaseMs)`, `completeJob`, `failJob`, `recoverExpiredLeases`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
test('pauses only a running benchmark', () => {
  expect(transitionRun('RUNNING', 'PAUSE')).toBe('PAUSED');
  expect(() => transitionRun('COMPLETED', 'PAUSE')).toThrow('INVALID_RUN_TRANSITION');
});

test('resumes a paused benchmark', () => {
  expect(transitionRun('PAUSED', 'RESUME')).toBe('RUNNING');
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/unit/status.test.ts`  
Expected: FAIL because the transition module is missing.

- [ ] **Step 3: Implement pure state transitions**

Represent allowed transitions as a typed map and return normalized `DomainError` codes for invalid transitions.

- [ ] **Step 4: Write and verify failing queue integration tests**

Test that two concurrent claimers never receive the same job, duplicate idempotency keys return the existing job, and an expired lease becomes claimable.

- [ ] **Step 5: Implement the PostgreSQL queue and event append**

Claim with `SELECT ... FOR UPDATE SKIP LOCKED`, set `lease_owner` and `lease_expires_at`, increment attempts only at claim, and append `job_events` in the same transaction as state changes.

- [ ] **Step 6: Verify green**

Run: `npm test -- tests/unit/status.test.ts && npm run test:integration -- tests/integration/queue.test.ts`  
Expected: PASS, including the concurrent claim test.

### Task 4: Textbook upload and processing pipeline

**Files:**
- Create: `src/domain/sources.ts`, `src/server/files/storage.ts`
- Create: `src/server/providers/upstage-document.ts`, `src/server/providers/gemini-embedding.ts`
- Create: `src/server/jobs/handlers/document.ts`
- Create: `src/app/api/sources/route.ts`, `src/app/api/sources/[id]/retry/route.ts`
- Create: `src/app/sources/page.tsx`, `src/app/sources/[id]/page.tsx`
- Test: `tests/unit/chunking.test.ts`, `tests/integration/sources-api.test.ts`

**Interfaces:**
- Produces: `storeUpload`, `parseDocument`, `chunkTextbook`, `embedChunks`, source list/detail APIs.

- [ ] **Step 1: Write a failing structure-preserving chunk test**

```ts
test('keeps page and unit metadata when splitting a long section', () => {
  const chunks = chunkTextbook(fixtureHtml, { maxTokens: 300 });
  expect(chunks.every((chunk) => chunk.page === 35 && chunk.unit === '물질의 구성')).toBe(true);
  expect(chunks.map((chunk) => chunk.kind)).toContain('example');
});
```

- [ ] **Step 2: Verify red, implement chunker, verify green**

Run before and after implementation: `npm test -- tests/unit/chunking.test.ts`.

- [ ] **Step 3: Write failing upload/retry API tests**

Test SHA-256 duplicate detection, PDF validation, transactionally created parse job, and retry beginning at the failed stage without deleting earlier artifacts.

- [ ] **Step 4: Implement storage, adapters, APIs, and worker handlers**

Use `storage/sources/<source-id>/original.pdf`; persist Upstage raw response and reviewed HTML separately; batch Gemini embeddings and store the exact embedding model ID.

- [ ] **Step 5: Implement Superdesign-aligned source pages**

Render upload, status columns, failed-stage retry, detail tabs, HTML editor, page/chunk inspector, and processing history from API data.

- [ ] **Step 6: Verify**

Run: `npm test -- tests/unit/chunking.test.ts && npm run test:integration -- tests/integration/sources-api.test.ts && npm run typecheck`  
Expected: PASS.

### Task 5: Question generation, review, and dataset versioning

**Files:**
- Create: `src/domain/questions.ts`, `src/domain/distribution.ts`
- Create: `src/server/jobs/handlers/question-generation.ts`
- Create: `src/app/api/generation/route.ts`, `src/app/api/questions/[id]/review/route.ts`, `src/app/api/datasets/route.ts`
- Create: `src/app/generation/page.tsx`, `src/app/review/page.tsx`, `src/app/datasets/page.tsx`
- Test: `tests/unit/distribution.test.ts`, `tests/integration/review-dataset.test.ts`

**Interfaces:**
- Produces: `validateTargetDistribution`, `generateQuestionBatch`, `recordReviewAction`, `freezeDatasetVersion`.

- [ ] **Step 1: Write failing distribution tests**

```ts
test('accepts the registered 500-question profile', () => {
  expect(validateTargetDistribution({150: 150, 120: 120, 80: 80, student: 80, correction: 70}).total).toBe(500);
});

test('rejects imbalanced option positions and missing evidence modes', () => {
  expect(() => validateDataset(invalidFixture)).toThrow('DATASET_DISTRIBUTION_INVALID');
});
```

- [ ] **Step 2: Verify red and implement profile validation**

Run before and after: `npm test -- tests/unit/distribution.test.ts`.

- [ ] **Step 3: Write failing review/version integration tests**

Test edit-and-approve creates a revision, only approved questions enter a version, version content hashes are stable, and published versions cannot be updated.

- [ ] **Step 4: Implement nine-stage generation and audit data**

Persist search queries, retrieved/reranked chunk IDs, structured concepts, design/evidence summaries, atomic rubric, quality flags, generator model/snapshot, and no hidden chain-of-thought.

- [ ] **Step 5: Implement generation, review, and dataset UIs**

Match the Superdesign drafts, including three-pane review, immutable-version distinction, exact distribution panels, warnings, filters, and JSON export.

- [ ] **Step 6: Verify**

Run: `npm test -- tests/unit/distribution.test.ts && npm run test:integration -- tests/integration/review-dataset.test.ts && npm run typecheck`  
Expected: PASS.

### Task 6: Model provider adapters

**Files:**
- Create: `src/server/providers/types.ts`, `src/server/providers/registry.ts`, `src/server/providers/retry.ts`
- Create: `src/server/providers/gemini.ts`, `anthropic.ts`, `openai.ts`, `openai-compatible.ts`
- Test: `tests/unit/providers/*.test.ts`, `tests/unit/retry.test.ts`

**Interfaces:**
- Produces: `ModelProvider.generate(request): Promise<NormalizedGeneration>`, `providerRegistry.fromEnv()`, `withProviderRetry`.

- [ ] **Step 1: Write failing contract tests**

For fixture HTTP responses, assert all adapters return identical normalized fields: `text`, `raw`, `inputTokens`, `outputTokens`, `finishReason`, `requestId`, `modelId`, `latencyMs`.

- [ ] **Step 2: Verify red**

Run: `npm test -- tests/unit/providers`  
Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement native and compatible adapters**

Use Gemini `generateContent`, Anthropic `/v1/messages`, OpenAI `/v1/responses`, and OpenAI-compatible chat completions for Upstage plus environment-configured EXAONE/Mi:dm endpoints. Keep request construction provider-specific and response normalization shared.

- [ ] **Step 4: Write failing retry/error tests**

Assert 429 honors `Retry-After`, timeout/5xx use bounded jittered retry, and auth/invalid request never retry. Assert secret-bearing headers are removed from recorded errors.

- [ ] **Step 5: Implement retry and verify**

Run: `npm test -- tests/unit/providers tests/unit/retry.test.ts`  
Expected: PASS.

### Task 7: Benchmark controller and SSE

**Files:**
- Create: `src/server/jobs/handlers/benchmark.ts`, `src/server/runs/service.ts`
- Create: `src/app/api/runs/route.ts`, `src/app/api/runs/[id]/commands/route.ts`, `src/app/api/runs/[id]/events/route.ts`
- Create: `src/app/runs/page.tsx`, `src/app/runs/[id]/page.tsx`
- Create: `src/components/runs/run-controller.tsx`, `model-progress-table.tsx`, `event-log.tsx`
- Test: `tests/integration/run-controller.test.ts`, `tests/e2e/run-controller.spec.ts`

**Interfaces:**
- Produces: `createRun`, `commandRun`, `executeRunItem`, replayable SSE using `Last-Event-ID`.

- [ ] **Step 1: Write failing lifecycle integration tests**

Create a two-model/five-question run and assert exactly ten items, pause prevents new claims, resume enables claims, retry selects only failed items, and cancellation preserves completed responses.

- [ ] **Step 2: Verify red and implement service/handler**

Run before and after: `npm run test:integration -- tests/integration/run-controller.test.ts`.

- [ ] **Step 3: Write failing SSE replay test**

Append events 10–12, request with `Last-Event-ID: 10`, and assert only 11–12 stream in order with heartbeat comments.

- [ ] **Step 4: Implement SSE and controller UI**

Render total progress, six provider rows, controls, concurrency/rate settings, live log, failures, cost, and recovery state. Disable invalid commands according to the state machine.

- [ ] **Step 5: Verify E2E**

Run: `npm run test:e2e -- tests/e2e/run-controller.spec.ts`  
Expected: pause, reload, resume, and retry flow passes.

### Task 8: Scoring, statistics, and result analysis

**Files:**
- Create: `src/domain/scoring.ts`, `src/domain/statistics.ts`, `src/domain/cost.ts`
- Create: `src/server/jobs/handlers/scoring.ts`, `src/server/results/service.ts`
- Create: `src/app/api/results/[runId]/route.ts`, `src/app/results/page.tsx`, `src/app/results/[runId]/questions/[questionId]/page.tsx`
- Create: `src/components/results/metric-matrix.tsx`, `paired-comparison.tsx`, `slice-table.tsx`
- Test: `tests/unit/scoring.test.ts`, `tests/unit/statistics.test.ts`, `tests/integration/results.test.ts`

**Interfaces:**
- Produces: exact/normalized/rubric/claim scoring, `pairedBootstrap`, `mcnemar`, `buildResultMatrix`.

- [ ] **Step 1: Write failing score tests**

Assert Korean whitespace/punctuation normalization, allowed short answers, atomic rubric aggregation, unsupported claim counting, and failures excluded from scores but included in denominators and failure metrics.

- [ ] **Step 2: Write failing statistics tests**

Use a fixed RNG seed and fixture pairs to assert deterministic 95% bootstrap bounds; assert McNemar discordant-pair counts and zero-pair behavior.

- [ ] **Step 3: Verify red and implement scoring/statistics**

Run before and after: `npm test -- tests/unit/scoring.test.ts tests/unit/statistics.test.ts`.

- [ ] **Step 4: Implement result service and UI**

Return model×metric values with `n`, failures, CI, slice dimensions, profile versions, and paired differences. Render the Superdesign result workspace with no default single-score conclusion and neutral model treatment.

- [ ] **Step 5: Verify**

Run: `npm run test:integration -- tests/integration/results.test.ts && npm run typecheck`  
Expected: PASS.

### Task 9: Dashboard, settings, and report exports

**Files:**
- Create: `src/server/dashboard/service.ts`, `src/server/reports/export.ts`
- Create: `src/app/api/dashboard/route.ts`, `src/app/api/reports/route.ts`, `src/app/api/settings/route.ts`
- Complete: `src/app/dashboard/page.tsx`, `src/app/settings/page.tsx`
- Test: `tests/integration/dashboard.test.ts`, `tests/integration/export.test.ts`

**Interfaces:**
- Produces: `getDashboardSnapshot`, `exportRunJson`, `exportRunCsv`, `exportRunPdf`.

- [ ] **Step 1: Write failing dashboard consistency test**

Assert total run progress equals the sum of model progress, failed items appear in action-needed counts, approved count derives from the working dataset, and no provider connectivity field exists.

- [ ] **Step 2: Implement dashboard queries and UI**

Match the corrected Superdesign information hierarchy using real queries and current timestamps rather than fabricated hard-coded performance claims.

- [ ] **Step 3: Write failing export tests**

Assert JSON includes provenance/profile IDs, CSV uses UTF-8 BOM and stable Korean headers, and PDF includes dataset hash, run ID, sample sizes, failures, CI, and balanced strengths/limitations.

- [ ] **Step 4: Implement exports and settings**

Store generated artifacts with SHA-256. Settings may edit non-secret DB profiles and display only whether an environment variable name is configured, never its value and never a test button.

- [ ] **Step 5: Verify**

Run: `npm run test:integration -- tests/integration/dashboard.test.ts tests/integration/export.test.ts`  
Expected: PASS.

### Task 10: Docker, browser journeys, and completion verification

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.env.example`, `scripts/docker-entrypoint.ts`
- Create: `tests/e2e/core-workflow.spec.ts`, `tests/e2e/accessibility.spec.ts`
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `docker compose up --build` deployment and documented real/mock provider operation.

- [ ] **Step 1: Write failing browser workflow**

The test uploads a fixture PDF, advances it through mocked parse/embed, generates and approves a question, freezes a small test dataset, runs six mock providers, opens result slices, and downloads JSON. Each major route must have no serious axe violation.

- [ ] **Step 2: Verify red**

Run: `npm run test:e2e -- tests/e2e/core-workflow.spec.ts tests/e2e/accessibility.spec.ts`  
Expected: FAIL before Docker/application integration is complete.

- [ ] **Step 3: Implement containers and documentation**

Use `pgvector/pgvector:pg17`, Node 22.22 slim for web/worker, named DB/storage volumes, health checks, automatic migrations, and separate `web`/`worker` commands. Document `.env` variables, mock mode, real call warnings, backup, restore, and report locations.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run test:integration && npm run typecheck && npm run lint && npm run build && docker compose up -d --build && npm run test:e2e`  
Expected: every command exits 0; `db`, `web`, and `worker` are healthy.

- [ ] **Step 5: Inspect final UI and logs**

Open `/dashboard`, `/review`, `/runs/<seed-id>`, and `/results` at 1440×1000 and 1280×800. Confirm no horizontal clipping, no secret values, no misleading hard-coded results, and no unhandled browser/server errors.

## Self-review record

- Spec coverage: all eight UI routes, real APIs, local pgvector DB, document pipeline, generation/review/versioning, persistent runner, six provider adapters, scoring/statistics, exports, and Docker are assigned to tasks.
- Placeholder scan: implementation steps use concrete files, interfaces, commands, and assertions; no deferred feature markers are used.
- Type consistency: queue, provider, run, score, and result interfaces are defined once and consumed by later tasks with the same names.
- Execution choice: the user explicitly requested immediate development without an approval checkpoint, so this session proceeds with inline execution and verification.
