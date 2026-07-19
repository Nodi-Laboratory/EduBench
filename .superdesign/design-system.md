# EduBench Enterprise Console Design System

## Product context

EduBench is a real, local-first operations console for producing defensible evidence about how six AI models perform on Korean textbook-based educational tasks. It is not a marketing demo. The primary users are benchmark operators and researchers who upload textbooks, curate questions, control thousands of API calls, audit evidence, and export comparison reports.

The default landing page is `/dashboard`, titled `벤치마크 운영 현황`. The main workflow is:

1. 교과서 자료 관리
2. 질문 생성
3. 질문 검수
4. 데이터셋 관리
5. 벤치마크 실행
6. 결과 분석

The application has no authentication, account menu, role management, onboarding wizard, or security administration.

## Design direction

Use a reality-first technical enterprise console: structured, restrained, information-dense, and audit-friendly. Adapt the selected Superdesign `saas-landing-page-for-developer-tool` modernist grid style to an operations application rather than a landing page.

- Light mode only for the initial release.
- Flat surfaces, thin borders, almost no decorative shadow.
- White and cool gray canvas with one cobalt-blue accent.
- Clear hierarchy from typography, spacing, alignment, and rule lines.
- Avoid gradients, glass effects, oversized hero sections, decorative illustrations, and consumer-app cards.
- Prefer precise tables, status strips, split panes, charts, and traceability panels.
- Korean interface text is primary; English is limited to model names, API identifiers, and compact technical labels.

## Color tokens

- `canvas`: `#F4F6F8`
- `surface`: `#FFFFFF`
- `surface-subtle`: `#F8FAFC`
- `surface-selected`: `#EEF5FF`
- `ink`: `#111827`
- `ink-secondary`: `#475569`
- `ink-muted`: `#7C899A`
- `border`: `#D8DEE8`
- `border-strong`: `#B9C3D1`
- `brand`: `#1351AA`
- `brand-hover`: `#0D428E`
- `brand-soft`: `#E8F1FC`
- `success`: `#16845B`
- `success-soft`: `#E8F6F0`
- `warning`: `#B76B00`
- `warning-soft`: `#FFF4DB`
- `danger`: `#C33D3D`
- `danger-soft`: `#FDECEC`
- `info`: `#246BCE`
- Model colors for charts only: EXAONE `#1351AA`, Gemini `#6D5BD0`, Claude `#C46B32`, OpenAI `#16845B`, Upstage `#D14F78`, Mi:dm `#617083`.

Never encode a model's quality using its brand color alone. Every chart and status also needs a label, value, or symbol.

## Typography

- UI family: `Pretendard Variable`, `Pretendard`, `Noto Sans KR`, `Inter`, system sans-serif.
- Numeric/technical family: `JetBrains Mono`, `SFMono-Regular`, Consolas, monospace.
- Page title: 24px / 32px, weight 700, letter-spacing -0.02em.
- Section title: 16px / 24px, weight 700.
- Card metric: 28px / 34px, weight 700, tabular numbers.
- Body: 14px / 21px, weight 400.
- Table and controls: 13px / 20px.
- Metadata label: 11px / 16px, weight 700, letter-spacing 0.06em; uppercase only for short English labels.
- Dense log/code content: 12px / 18px, monospace.

Use tabular numerals for progress, cost, latency, tokens, versions, and confidence intervals.

## Layout

- Desktop-first, minimum supported width 1280px; usable down to 1024px.
- Fixed left sidebar: 232px wide, white background, right border.
- Main top bar: 56px high, white background, bottom border; contains breadcrumb, dataset/run context, and compact utility actions only.
- Main content: fluid, max width none, 24px outer padding, 20px vertical section gaps.
- Base grid: 12 columns, 16px gutters.
- Dashboard metric strip: 4 equal columns at wide desktop, 2 at narrower desktop.
- Tables use sticky headers. Detail-heavy pages use a resizable or fixed 42/58 split pane.
- Page headers use title and one-line description on the left, primary action and secondary actions on the right.

## Spacing and shape

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40.
- Control height: 36px; compact control height: 30px; primary large control: 40px.
- Surface radius: 6px. Do not exceed 8px.
- Buttons and inputs: 5px radius.
- Status pills: full radius only when needed for compact status labels.
- Borders: 1px solid `border`; selected/focused borders use `brand`.
- Shadows: none by default; floating menus may use `0 8px 24px rgba(15, 23, 42, 0.10)`.

## Navigation

Sidebar header contains a compact `EDUBENCH` wordmark, a small blue square mark, and `교육 AI 평가 운영체계` subtitle. The first item is `운영 현황`, followed by the six workflow pages. Group `운영` and `설정` with subtle labels. `API 연결 확인` must not exist. Active navigation uses a pale blue fill, blue 3px left rule, and dark text.

Sidebar footer shows local system status only: database state, queue worker state, and app version. It does not show a user profile.

## Core components

### Buttons

- Primary: brand background, white text, 36px height, semibold.
- Secondary: white surface, border, ink text.
- Destructive: danger text/border; solid danger only in confirmation dialogs.
- Icon buttons always include tooltip and accessible label.
- Loading buttons preserve width and show a spinner plus action text.

### Status

- Use icon + Korean label + optional count.
- States: 대기, 처리 중, 완료, 일시 중지, 실패, 취소됨, 검수 필요, 승인됨.
- Animated indicators are allowed only for actively running work.

### Metric cards

Flat bordered panels with a small label, large tabular value, comparison delta or denominator, and optional sparkline. Do not use decorative icons in circles.

### Tables

Dense, scan-friendly rows at 44px minimum height. Support sorting, filters, column visibility, bulk selection, pagination, empty state, and row-level overflow actions. IDs and model versions use monospace. Numeric values are right-aligned.

### Filters

Use a horizontal filter bar for common filters and a side sheet for advanced filters. Show active filter chips and a clear-all action. Persist filters in the URL where practical.

### Split-pane inspector

Used for question review and response comparison. Left side is the queue/list or question content; right side is evidence, rubric, model answers, and audit history. Keep primary actions sticky.

### Charts

Charts are analytical, not decorative. Always include exact values in tooltips and accessible tables or labels. Use zero-based axes where appropriate, show sample size `n`, uncertainty/95% CI when available, and make failed calls visible rather than silently excluded.

### Logs

Monospace, virtualized list, timestamp + severity + model + question ID + message. Offer pause autoscroll, severity filter, copy, and download. Never expose secret keys.

## Page specifications

### 1. 운영 현황 `/dashboard`

Default page. Show current dataset version, latest run state, document/question readiness, and overall system activity. Top metric strip: active run progress, approved questions / 500, ready textbook files, failures requiring action. Main area: large live run progress panel; six compact model rows with completion, success/failure, latency, tokens, cost; dataset composition chart; recent runs table; action-needed rail. If no run exists, preserve the same structure with useful empty states and shortcuts.

### 2. 교과서 자료 `/sources`

Upload zone plus document table. Each row exposes Parse, HTML review, chunk, embedding states and retry at the failed stage. Detail route `/sources/[id]` uses tabs for source metadata, extracted HTML editor, page preview, chunk inspector, and processing history.

### 3. 질문 생성 `/generation`

Two-column workspace. Left: condition form for subject, grade, source files, units, purpose, type, difficulty, direction, chunk count, and cross-unit option. Right: estimated coverage, selected-source summary, pipeline stages, and generated draft queue. Batch generation is first-class and progress persists.

### 4. 질문 검수 `/review`

Dense three-region experience: review queue, central editable question/answer/rubric, right evidence inspector. Approve, edit-and-approve, hold, delete, and regeneration variants stay visible. Show quality flags and possible generator-style bias. Keyboard shortcuts may accelerate review but must never hide actions.

### 5. 데이터셋 `/datasets`

Version header, 500-question readiness gauge, distribution charts, imbalance warnings, question table, version history, freeze/create-version, JSON export. Clearly separate editable working set from immutable published versions.

### 6. 벤치마크 실행 `/runs`

Run list and primary `새 실행` action. `/runs/[id]` is the controller: total progress, start/pause/resume/cancel/retry controls, six model status panels, concurrency/rate settings, live log, failed-call table, and persistent recovery status. Destructive cancel requires confirmation.

### 7. 결과 분석 `/results`

The most important analysis page. Show no single score as the sole conclusion. Use metric matrix, model ranking by selected metric, subject/grade/purpose/type/difficulty slices, paired model comparison, accuracy/faithfulness/hallucination/curriculum alignment/student-level fit, latency/token/cost/failure measures, confidence intervals, and sample size. EXAONE is available as a comparison anchor but receives no visually biased treatment. `/results/[runId]/questions/[questionId]` shows blinded side-by-side responses, rubric-level scores, evidence claims, judge records, and human overrides. Export PDF/CSV/JSON.

### 8. 설정 `/settings`

Local operational settings only: provider model identifiers and base URLs, default concurrency, retry policy, scoring profile versions, price profiles, and system prompt profiles. API keys are read from `.env` and are never displayed or tested here.

## Interaction and motion

- 120–180ms ease-out for hover/focus/state transitions.
- Progress bars may animate linearly when values change.
- Respect reduced-motion preferences.
- No entrance animations for tables or primary data.
- Toasts confirm reversible actions; persistent errors appear inline with a retry path.

## Accessibility and data integrity

- Meet WCAG AA contrast.
- Full keyboard navigation, visible focus rings, correctly associated labels, and semantic tables.
- Do not communicate status with color alone.
- Confirm destructive actions and explain whether work is recoverable.
- Show timezone `Asia/Seoul` and ISO-like timestamps where auditability matters.
- Preserve raw responses, normalized responses, scoring versions, provider request IDs, retry histories, and failure rows in the interface.

## Content style

Use direct Korean operational language: `실행 시작`, `일시 중지`, `실패 12건 재실행`, `검수 대기 38건`. Avoid marketing phrases, gamification, congratulatory copy, and fabricated performance claims. Empty states should say what is missing and offer the exact next action.
