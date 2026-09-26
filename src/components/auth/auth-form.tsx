'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { LogIn, UserPlus } from 'lucide-react';

type Mode = 'login' | 'signup';

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignup = mode === 'signup';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
      ...(isSignup ? { displayName: String(form.get('displayName') ?? '') } : {}),
    };
    if (isSignup && body.password !== String(form.get('passwordConfirm') ?? '')) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        setError(payload?.message ?? '요청을 처리하지 못했습니다.');
        return;
      }
      router.replace(safeNext(searchParams.get('next')));
      router.refresh();
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-row auth-brand">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <strong>EDUBENCH</strong>
        </div>
        <p className="auth-tagline">K-12 AI EVALUATION LAB</p>
        <h1 id="auth-title">{isSignup ? '계정 만들기' : '로그인'}</h1>
        <p className="auth-copy">
          {isSignup
            ? '아이디와 비밀번호로 연구 워크스페이스 계정을 만듭니다.'
            : '교과서 기반 AI 모델 벤치마크 워크스페이스에 로그인합니다.'}
        </p>
        <form className="dense-form auth-form" onSubmit={submit}>
          <label>
            아이디
            <input name="username" autoComplete="username" required minLength={3} maxLength={32} autoFocus />
          </label>
          {isSignup && (
            <label>
              표시 이름 <small>(선택, 비우면 아이디 사용)</small>
              <input name="displayName" autoComplete="name" maxLength={60} />
            </label>
          )}
          <label>
            비밀번호
            <input
              name="password"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              required
              minLength={8}
              maxLength={128}
            />
          </label>
          {isSignup && (
            <label>
              비밀번호 확인
              <input name="passwordConfirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} />
            </label>
          )}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button primary" type="submit" disabled={pending}>
            {isSignup ? <UserPlus size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}
            {pending ? '처리 중…' : isSignup ? '가입하고 시작하기' : '로그인'}
          </button>
        </form>
        <p className="auth-switch">
          {isSignup ? '이미 계정이 있나요? ' : '계정이 없나요? '}
          <Link href={isSignup ? '/login' : '/signup'}>{isSignup ? '로그인' : '회원가입'}</Link>
        </p>
        {!isSignup && (
          <p className="auth-demo">데모 계정: <b className="mono">demo</b> / <b className="mono">demo1234</b></p>
        )}
      </section>
    </div>
  );
}
