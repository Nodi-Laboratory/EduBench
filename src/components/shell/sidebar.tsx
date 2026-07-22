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
                <Link
                  className={`nav-item${active ? ' active' : ''}`}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  key={item.href}
                >
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

