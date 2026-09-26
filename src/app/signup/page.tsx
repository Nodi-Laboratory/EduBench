import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata = { title: '회원가입' };

export default function SignupPage() {
  return <Suspense><AuthForm mode="signup" /></Suspense>;
}
