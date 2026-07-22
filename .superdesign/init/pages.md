# Page dependency trees

All pages also depend on the root chain `src/app/layout.tsx` → `src/components/shell/app-shell.tsx` → `sidebar.tsx`, `navigation.ts`, `topbar.tsx`, and `src/app/globals.css`.

## `/dashboard`
- `src/app/dashboard/page.tsx`
  - `src/components/dashboard/dashboard-overview.tsx`
  - `src/server/db/pool.ts`

## `/sources`
- `src/app/sources/page.tsx`
  - `src/components/sources/sources-workspace.tsx`
  - `src/server/db/pool.ts`

## `/generation`
- `src/app/generation/page.tsx`
  - `src/components/generation/generation-workspace.tsx`
  - `src/server/db/pool.ts`

## `/review`
- `src/app/review/page.tsx`
  - `src/components/review/review-workspace.tsx`
  - `src/server/db/pool.ts`

## `/datasets`
- `src/app/datasets/page.tsx`
  - `src/components/datasets/dataset-workspace.tsx`
  - `src/server/db/pool.ts`

## `/runs`
- `src/app/runs/page.tsx`
  - `src/components/runs/run-workspace.tsx`
  - `src/server/db/pool.ts`

## `/runs/[id]`
- `src/app/runs/[id]/page.tsx`
  - `src/components/runs/run-controller.tsx`
  - `src/server/runs/service.ts`

## `/settings`
- `src/app/settings/page.tsx`
  - `src/components/settings/settings-workspace.tsx`

## Planned `/document-lab`
- `src/app/document-lab/page.tsx`
  - `src/components/document-lab/document-lab-workspace.tsx`

