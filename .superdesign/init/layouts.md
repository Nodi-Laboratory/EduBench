# Shared layouts

## `src/app/layout.tsx`

Root Next.js layout. It loads the global stylesheet and wraps every route in the application shell.

```tsx
import type { Metadata } from 'next';
import { AppShell } from '@/components/shell/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'EduBench', template: '%s · EduBench' },
  description: '국내 교과서 기반 AI 모델 벤치마크 운영체계',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
```

## `src/components/shell/app-shell.tsx`

Persistent sidebar, sticky topbar, and content canvas.

```tsx
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <main className="page-canvas">{children}</main>
      </div>
    </div>
  );
}
```

## `src/components/shell/sidebar.tsx`

Primary grouped navigation and local system status.

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from './navigation';

function isActive(pathname: string, href: string) {
  return pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar" aria-label="주요 탐색">
      <div className="brand-block">
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <strong>EDUBENCH</strong>
        </div>
        <p>교육 AI 평가 운영체계</p>
      </div>

      <nav className="nav-stack">
        {(['운영', '설정'] as const).map((group) => (
          <div className="nav-group" key={group}>
            <p className="nav-group-label">{group}</p>
            {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <Link className={`nav-item${active ? ' active' : ''}`} href={item.href} aria-current={active ? 'page' : undefined} key={item.href}>
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="system-strip" aria-label="로컬 시스템 상태">
        <div><span>DATABASE</span><b className="status-ok">준비</b></div>
        <div><span>QUEUE WORKER</span><b className="status-idle">대기</b></div>
        <div><span>APP VERSION</span><b className="mono">0.1.0</b></div>
      </div>
    </aside>
  );
}
```

## `src/components/shell/topbar.tsx`

Sticky working-set context and local operating state.

```tsx
import { ChevronRight, CircleDot } from 'lucide-react';

export function Topbar() {
  return (
    <header className="topbar">
      <div className="context-path">
        <span>작업 데이터셋</span>
        <ChevronRight size={14} aria-hidden="true" />
        <strong className="mono">WORKING SET</strong>
      </div>
      <div className="topbar-state">
        <CircleDot size={14} aria-hidden="true" />
        <span>로컬 운영 모드</span>
        <span className="topbar-divider" />
        <time dateTime="2026-07-20T00:00:00+09:00">Asia/Seoul</time>
      </div>
    </header>
  );
}
```

## `src/components/shell/navigation.ts`

Sidebar route and Lucide icon mapping.

```ts
import type { LucideIcon } from 'lucide-react';
import { BarChart3, BookOpen, ClipboardCheck, Database, LayoutDashboard, PlayCircle, Settings, Sparkles } from 'lucide-react';

export type NavItem = { href: string; label: string; icon: LucideIcon; group: '운영' | '설정' };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: '운영 현황', icon: LayoutDashboard, group: '운영' },
  { href: '/sources', label: '교과서 자료 관리', icon: BookOpen, group: '운영' },
  { href: '/generation', label: '질문 생성', icon: Sparkles, group: '운영' },
  { href: '/review', label: '질문 검수', icon: ClipboardCheck, group: '운영' },
  { href: '/datasets', label: '데이터셋 관리', icon: Database, group: '운영' },
  { href: '/runs', label: '벤치마크 실행', icon: PlayCircle, group: '운영' },
  { href: '/results', label: '결과 분석', icon: BarChart3, group: '운영' },
  { href: '/settings', label: '시스템 설정', icon: Settings, group: '설정' },
] as const;
```

