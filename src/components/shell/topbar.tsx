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

