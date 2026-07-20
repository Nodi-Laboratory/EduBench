# Upstage Page Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse every textbook PDF page as a full-page image with Upstage Enhanced mode and provide a one-off browser lab for inspecting the resulting HTML and raw response.

**Architecture:** A Poppler-backed renderer produces ordered PNG pages. One shared Upstage adapter owns the exact multipart settings used by both the persistent document pipeline and a stateless Document Lab API. A client workspace compares page image, sandboxed HTML, elements, and raw JSON.

**Tech Stack:** Next.js 16, TypeScript, React 19, Vitest, PostgreSQL/pgvector, Upstage REST API, Poppler `pdftoppm`, Docker.

## Global Constraints

- Upstage request fields are `ocr=force`, `mode=enhanced`, `base64_encoding=['footnote']`, and `output_formats=['html']`.
- Each PDF page is rasterized at 150 DPI and sent as one complete PNG image.
- Document Lab never persists its upload or response into operational source tables.
- API keys remain server-only.
- Provider base URLs are documented and populated only when an official managed endpoint exists.

---

### Task 1: Shared Upstage Enhanced request contract

**Files:**
- Modify: `tests/unit/providers/document.test.ts`
- Modify: `src/server/providers/upstage-document.ts`

**Interfaces:**
- Produces: `parse(bytes, filename, { mimeType, pageNumber, signal? })`
- Returns: `{ html, elements, raw, requestId, model, requestConfig }`

- [ ] **Step 1: Write the failing multipart contract test**

Assert the captured `FormData` contains `ocr=force`, `mode=enhanced`, `base64_encoding=['footnote']`, `output_formats=['html']`, the configured model, and an `image/png` document blob.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/unit/providers/document.test.ts`
Expected: FAIL because the current adapter sends PDF with `ocr=auto` and omits enhanced fields.

- [ ] **Step 3: Implement the minimal typed request contract**

Add `DocumentParseOptions` and normalize `raw.elements ?? []`; return a non-secret `requestConfig` object for audit UI.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm test -- tests/unit/providers/document.test.ts`
Expected: PASS.

### Task 2: Full-page PDF rasterization

**Files:**
- Create: `src/server/documents/page-renderer.ts`
- Create: `tests/unit/page-renderer.test.ts`
- Modify: `Dockerfile`
- Modify: `.env.example`

**Interfaces:**
- Produces: `renderPdfPages(bytes: Uint8Array, options?): Promise<RenderedPage[]>`
- `RenderedPage = { pageNumber:number; bytes:Uint8Array; mimeType:'image/png'; filename:string; dataUrl:string }`

- [ ] **Step 1: Write a failing renderer test**

Inject a command runner that records arguments and creates `page-1.png` and `page-2.png`; assert `-png -r 150`, numeric ordering, and returned data URLs.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/page-renderer.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement renderer and cleanup**

Use `mkdtemp`, `writeFile`, `execFile`, `readdir`, `readFile`, and `rm` in `finally`. Add `PDFTOPPM_PATH=pdftoppm`. Install `poppler-utils` in Docker runtime.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/unit/page-renderer.test.ts`
Expected: PASS.

### Task 3: Persistent page-by-page document pipeline

**Files:**
- Modify: `src/server/documents/pipeline.ts`
- Create: `tests/unit/document-pipeline-pages.test.ts`

**Interfaces:**
- Consumes: `renderPdfPages`, `UpstageDocumentParser.parse`
- Produces: combined page-section HTML and `{ pages:[...] }` raw revision provenance.

- [ ] **Step 1: Write a failing orchestration test**

Inject two rendered pages and a parser spy; assert two ordered PNG calls and combined `<section data-page="1">`, `<section data-page="2">` HTML.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/document-pipeline-pages.test.ts`
Expected: FAIL because the pipeline sends the original PDF once.

- [ ] **Step 3: Extract and implement `parseDocumentPages`**

Keep DB persistence in `processDocument`; place page rendering/parsing in a pure injectable helper. Include page number in thrown errors.

- [ ] **Step 4: Verify GREEN**

Run the targeted tests and confirm ordered calls and provenance pass.

### Task 4: Stateless Document Lab API

**Files:**
- Create: `src/server/documents/lab.ts`
- Create: `src/app/api/document-lab/parse/route.ts`
- Create: `tests/unit/document-lab.test.ts`

**Interfaces:**
- Produces: `parseDocumentLabFile(file): Promise<{ pages, requestConfig, mock }>`
- Accepts PDF, PNG, JPEG, WebP up to 100MB.

- [ ] **Step 1: Write failing validation and MOCK tests**

Assert invalid magic bytes return 400; MOCK PDF returns page image, HTML, elements, raw response, and enhanced request settings without DB writes.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/document-lab.test.ts`
Expected: FAIL because the route and service do not exist.

- [ ] **Step 3: Implement route and service**

Return 409 `UPSTAGE_NOT_CONFIGURED` outside MOCK mode when the key is absent. Never return the key.

- [ ] **Step 4: Verify GREEN**

Run the targeted test; expect PASS.

### Task 5: Document Lab comparison workspace

**Files:**
- Create: `src/app/document-lab/page.tsx`
- Create: `src/components/document-lab/document-lab-workspace.tsx`
- Modify: `src/components/shell/navigation.ts`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/navigation.test.ts`
- Modify: `tests/unit/workflow-pages.test.tsx`

**Interfaces:**
- Consumes: `POST /api/document-lab/parse`
- Produces: upload, page selector, original image, sandboxed HTML iframe, elements, and JSON views.

- [ ] **Step 1: Write failing navigation and component tests**

Assert `/document-lab` navigation exists and the workspace exposes `테스트 파일`, `Enhanced`, `원본 페이지`, `변환 HTML`, and `원본 JSON`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/navigation.test.ts tests/unit/workflow-pages.test.tsx`
Expected: FAIL because the page is absent.

- [ ] **Step 3: Implement the comparison UI**

Use the existing console tokens. Keep the three panes information-dense, use a page-coordinate header as the signature, sandbox the iframe, add keyboard-visible tabs, loading, empty, and actionable error states.

- [ ] **Step 4: Verify GREEN and responsive layout**

Run component tests and typecheck; expect PASS.

### Task 6: Official provider base URL audit (last implementation task)

**Files:**
- Modify: `.env.example`
- Modify: `docs/research/2026-07-20-provider-api-research.md`
- Modify: `README.md`

**Interfaces:**
- Documents official managed base URLs and marks deployment-specific URLs explicitly.

- [ ] **Step 1: Verify each provider using primary documentation**

Record official URLs for Google Gemini, Anthropic, OpenAI, and Upstage. Verify whether EXAONE and KT Mi:dm expose a single public managed inference base URL.

- [ ] **Step 2: Update env defaults without inventing endpoints**

Populate `GEMINI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `UPSTAGE_BASE_URL`. Leave deployment-specific OpenAI-compatible URLs blank with explanatory comments.

- [ ] **Step 3: Ensure adapters consume the audited values**

Add or update unit assertions for environment overrides where an adapter currently hardcodes a base URL.

### Task 7: Full verification

**Files:**
- Modify only files required by defects found during verification.

- [ ] **Step 1: Run automated verification**

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, and `npm run build` with fail-fast exit handling.

- [ ] **Step 2: Rebuild Docker**

Run `docker compose build web worker` and recreate services. Confirm Poppler is present with `pdftoppm -v` in the worker.

- [ ] **Step 3: Browser verification**

Open `/document-lab`, upload a one-page fixture in MOCK mode, and verify original image, HTML, elements, JSON, responsive layout, and zero console errors.

- [ ] **Step 4: Commit**

Commit the verified implementation on `codex/upstage-page-parse` with a focused message.
