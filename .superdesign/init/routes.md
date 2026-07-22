# Route map

Next.js 16 App Router; every route uses `src/app/layout.tsx` and the persistent `AppShell`.

| URL | Entry | Primary component |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Redirect to `/dashboard` |
| `/dashboard` | `src/app/dashboard/page.tsx` | `DashboardOverview` |
| `/sources` | `src/app/sources/page.tsx` | `SourcesWorkspace` |
| `/generation` | `src/app/generation/page.tsx` | `GenerationWorkspace` |
| `/review` | `src/app/review/page.tsx` | `ReviewWorkspace` |
| `/datasets` | `src/app/datasets/page.tsx` | `DatasetWorkspace` |
| `/runs` | `src/app/runs/page.tsx` | `RunWorkspace` |
| `/runs/[id]` | `src/app/runs/[id]/page.tsx` | `RunController` |
| `/results` | `src/app/results/page.tsx` | results list/server view |
| `/results/[id]` | `src/app/results/[id]/page.tsx` | run result/server view |
| `/settings` | `src/app/settings/page.tsx` | `SettingsWorkspace` |

The planned `/document-lab` route will use the same application shell and be grouped under 운영 navigation.

