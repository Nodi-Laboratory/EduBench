// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';

test('shows operational readiness and the three configured model rows', () => {
  render(<DashboardOverview />);

  expect(screen.getByRole('heading', { name: '벤치마크 운영 현황' })).toBeInTheDocument();
  expect(screen.getByText('실제 승인 문항')).toBeInTheDocument();
  expect(screen.queryByText('초기 작업공간')).not.toBeInTheDocument();
  expect(screen.getByText('EXAONE')).toBeInTheDocument();
  expect(screen.getByText('Gemini')).toBeInTheDocument();
  expect(screen.getByText('Upstage')).toBeInTheDocument();
  expect(screen.queryByText('Claude')).not.toBeInTheDocument();
});
