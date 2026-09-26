'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogOut } from 'lucide-react';

export function UserMenu({ displayName, username }: { displayName: string; username: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <div className="user-menu">
      <span className="user-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
      <span className="user-name" title={username}>{displayName}</span>
      <button className="icon-text-button" type="button" onClick={logout} disabled={pending}>
        <LogOut size={13} aria-hidden="true" />
        로그아웃
      </button>
    </div>
  );
}
