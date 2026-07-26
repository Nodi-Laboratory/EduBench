// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';

const navigation = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

beforeEach(() => {
  navigation.pathname = '/dashboard';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('sidebar keeps every URL while using research workflow groups and no fake runtime strip', () => {
  render(<Sidebar />);

  for (const group of [
    'Monitor',
    'Corpus',
    'Question Pipeline',
    'Experiments',
    'Methods',
  ]) {
    expect(screen.getByText(group)).toBeInTheDocument();
  }

  expect(screen.getByRole('link', { name: 'Research Control Room' }))
    .toHaveAttribute('href', '/dashboard');
  expect(screen.getByRole('link', { name: '교과서 자료 관리' }))
    .toHaveAttribute('href', '/sources');
  expect(screen.getByRole('link', { name: '시스템 설정' }))
    .toHaveAttribute('href', '/settings');
  expect(screen.queryByText('DATABASE')).not.toBeInTheDocument();
  expect(screen.queryByText('QUEUE WORKER')).not.toBeInTheDocument();
  expect(screen.queryByText('APP VERSION')).not.toBeInTheDocument();
});

test('topbar derives context from pathname and marks the control room live', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-27T03:34:56.000Z'));

  render(<Topbar />);

  expect(screen.getByText('Monitor')).toBeInTheDocument();
  expect(screen.getByText('Research Control Room')).toBeInTheDocument();
  expect(screen.getByText('LIVE')).toBeInTheDocument();
  expect(screen.getByText('Asia/Seoul')).toBeInTheDocument();
  expect(screen.getByText(/2026.*07.*27/)).toBeInTheDocument();
  expect(screen.queryByText('WORKING SET')).not.toBeInTheDocument();
  expect(screen.queryByText('로컬 운영 모드')).not.toBeInTheDocument();
});

test('topbar server markup uses a deterministic clock placeholder for hydration safety', () => {
  const html = renderToString(<Topbar />);

  expect(html).toContain('--:--:--');
  expect(html).not.toContain('2026-07-20');
});

test('topbar resolves nested pages to their existing navigation context', () => {
  navigation.pathname = '/sources/source-1';

  render(<Topbar />);

  expect(screen.getByText('Corpus')).toBeInTheDocument();
  expect(screen.getByText('교과서 자료 관리')).toBeInTheDocument();
  expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
});
