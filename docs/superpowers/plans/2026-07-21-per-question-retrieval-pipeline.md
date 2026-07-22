# Per-Question Retrieval Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one batch-wide retrieval with an independent direction → vector retrieval → generation pipeline for every question and raise the final generation output budget to 16,384 tokens.

**Architecture:** A small structured Gemini call first produces a search-only question direction. That direction is embedded and searched independently, then only that question's retrieved chunks are passed to the final question generator. Existing sequential/parallel mode controls how many complete per-question pipelines run concurrently.

**Tech Stack:** TypeScript, Next.js, Gemini structured output and embeddings, PostgreSQL/pgvector, Vitest.

## Global Constraints

- Keep existing generation batch and question persistence schemas.
- Persist one `generation_retrievals` row per requested question with its ordinal and direction.
- Do not create a question or answer during the direction stage.
- Use `maxOutputTokens: 16384` for final question generation.

---

### Task 1: Structured question direction

**Files:**
- Create: `src/server/questions/direction.ts`
- Test: `tests/unit/question-direction.test.ts`

**Interfaces:**
- Produces: `buildQuestionDirectionInstructions`, `parseQuestionDirectionResponse`, `questionDirectionJsonSchema`, `QUESTION_GENERATION_MAX_OUTPUT_TOKENS`.

- [x] Write tests requiring a distinct search-ready direction per ordinal and a 16,384-token output limit.
- [x] Run the test and confirm it fails because the direction module does not exist.
- [x] Implement the structured direction contract and parser.
- [x] Run the test and confirm all direction tests pass.

### Task 2: Independent retrieval pipelines

**Files:**
- Modify: `src/server/questions/generator.ts`
- Test: `tests/integration/per-question-retrieval.test.ts`

**Interfaces:**
- Consumes: one `QuestionDirection` per ordinal.
- Produces: one embedding request, chunk set, retrieval audit row, and generated question per ordinal.

- [x] Move vector embedding and chunk retrieval inside the per-question concurrent worker.
- [x] Store the ordinal and complete direction in `candidate_scope`.
- [x] Pass the direction summary and that question's evidence only to the final generator.
- [x] Verify two questions create two distinct retrieval audit rows.

### Task 3: Live activity and deployment

**Files:**
- Modify: `src/components/generation/generation-workspace.tsx`

**Interfaces:**
- Produces: readable labels for direction and per-question retrieval events.

- [x] Add direction start/completion and retrieval start/completion event labels.
- [x] Run all unit and integration tests.
- [x] Build the production application.
- [x] Rebuild and restart Docker services, then verify HTTP health.
