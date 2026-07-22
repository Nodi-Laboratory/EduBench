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

