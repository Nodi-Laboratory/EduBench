# Parallel Pipelines and Live Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallelize document parsing, embedding, and optional question generation while exposing live batch and per-question progress.

**Architecture:** A shared ordered concurrency helper limits provider pressure while preserving deterministic result order. Document pages and embedding batches use this helper; question generation emits durable job events and supports sequential or limited-parallel one-question requests. The generation UI polls lightweight APIs and renders batch/question activity without manual refresh.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL, Vitest, Docker Compose.

## Global Constraints

- Preserve cancellation through AbortSignal.
- Default provider concurrency is bounded and configurable by environment variables.
- Do not use Superdesign.
- Preserve existing database history and current uncommitted changes.

---

### Task 1: Ordered concurrency primitive

**Files:**
- Create: `src/domain/parallel.ts`
- Create: `tests/unit/parallel.test.ts`

- [ ] Write tests proving concurrency is bounded and outputs preserve input order.
- [ ] Run the tests and confirm failure because the helper is missing.
- [ ] Implement `mapConcurrentOrdered<T,R>(items, concurrency, mapper)`.
- [ ] Run the unit tests.

### Task 2: Parallel document and embedding pipeline

**Files:**
- Modify: `src/server/documents/pipeline.ts`
- Modify: `tests/unit/document-pipeline-pages.test.ts`

- [ ] Add a failing test proving page parses overlap and final HTML remains page ordered.
- [ ] Parse pages in configurable batches with bounded concurrency.
- [ ] Embed chunk batches concurrently while assigning vectors to their original indices.
- [ ] Emit batch start/completion events containing concurrency and counts.
- [ ] Run document pipeline tests.

### Task 3: Generation execution mode and live events

**Files:**
- Modify: `src/app/api/generation/route.ts`
- Create: `src/server/generation/activity.ts`
- Create: `src/app/api/generation/[id]/activity/route.ts`
- Modify: `src/server/questions/generator.ts`
- Modify: `src/worker.ts`
- Modify: `tests/integration/generation-api.test.ts`

- [ ] Add failing API tests for `executionMode: sequential|parallel`.
- [ ] Store execution mode in batch conditions.
- [ ] Generate one question per provider request; run sequentially or with bounded concurrency.
- [ ] Emit retrieval, per-question start/completion/failure, and batch completion events.
- [ ] Return batch, events, and persisted questions from the activity API.
- [ ] Run integration tests.

### Task 4: Select-all and real-time generation workspace

**Files:**
- Modify: `src/components/generation/generation-workspace.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/workflow-pages.test.tsx`

- [ ] Add failing UI tests for textbook TOC select-all and execution mode.
- [ ] Add per-textbook select-all/clear control with indeterminate state.
- [ ] Poll the batch list and selected batch activity automatically.
- [ ] Render progress, event accordions, and question result accordions.
- [ ] Run UI tests.

### Task 5: Verification and deployment

- [ ] Run typecheck, targeted unit tests, and integration tests.
- [ ] Rebuild web and worker images with Docker Compose.
- [ ] Verify service health and live API responses.
