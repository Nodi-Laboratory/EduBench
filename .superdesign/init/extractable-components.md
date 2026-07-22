# Extractable components

## AppShell
- Source: `src/components/shell/app-shell.tsx`
- Category: layout
- Description: Persistent fixed sidebar, sticky topbar, and content canvas.
- Extractable props: none; page content is the slot.
- Hardcoded: layout classes and shell structure.

## Sidebar
- Source: `src/components/shell/sidebar.tsx`
- Category: layout
- Description: Grouped workflow navigation with local system status.
- Extractable props: `activeItem` (string, default `dashboard`).
- Hardcoded: wordmark, Korean labels, navigation icon choices, system-status rows.

## Topbar
- Source: `src/components/shell/topbar.tsx`
- Category: layout
- Description: Working dataset context and local mode indicator.
- Extractable props: none.
- Hardcoded: working-set label, mode and timezone.

