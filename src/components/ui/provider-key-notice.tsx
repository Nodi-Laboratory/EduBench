'use client';

import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { providerKeyLabel } from '@/domain/provider-key-catalog';

/** Shown in place of a disabled action when the user has not entered a key. */
export function ProviderKeyNotice({ missing, feature }: { missing: string[]; feature: string }) {
  if (!missing.length) return null;
  return (
    <p className="provider-key-required" role="status">
      <KeyRound size={14} aria-hidden="true" />
      <span>
        {feature}에는 {missing.map(providerKeyLabel).join(', ')} API 키가 필요합니다.{' '}
        <Link href="/settings#api-keys">설정 화면에서 키 입력</Link>
      </span>
    </p>
  );
}
