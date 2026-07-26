'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, CircleDot } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from './navigation';

function matchesPath(pathname: string, href: string) {
  return pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
}

function seoulClock(now: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
}

export function Topbar() {
  const pathname = usePathname();
  const [clock, setClock] = useState({
    iso: '',
    label: '--:--:--',
  });
  const context = useMemo(
    () => NAV_ITEMS.find((item) => matchesPath(pathname, item.href)) ?? {
      group: 'EduBench',
      label: 'Research Workspace',
      href: pathname,
    },
    [pathname],
  );
  const isControlRoom = context.href === '/dashboard';

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setClock({ iso: now.toISOString(), label: seoulClock(now) });
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="topbar">
      <div className="context-path">
        <span>{context.group}</span>
        <ChevronRight size={14} aria-hidden="true" />
        <strong>{context.label}</strong>
      </div>
      <div className="topbar-state">
        {isControlRoom && (
          <>
            <span className="topbar-live">
              <CircleDot size={14} aria-hidden="true" />
              LIVE
            </span>
            <span className="topbar-divider" />
          </>
        )}
        <span className="topbar-timezone">Asia/Seoul</span>
        <time dateTime={clock.iso || undefined}>{clock.label}</time>
      </div>
    </header>
  );
}

