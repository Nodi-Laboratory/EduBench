// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';

test('shows operational readiness and the six neutral model rows', () => {
  render(<DashboardOverview />);

  expect(screen.getByRole('heading', { name: '벤치마크 운영 현황' })).toBeInTheDocument();
  expect(screen.getByText('근거 제공 400')).toBeInTheDocument();
  expect(screen.getByText('EXAONE')).toBeInTheDocument();
  expect(screen.getByText('Gemini')).toBeInTheDocument();
  expect(screen.getByText('Claude')).toBeInTheDocument();
  expect(screen.getByText('OpenAI')).toBeInTheDocument();
  expect(screen.getByText('Upstage')).toBeInTheDocument();
  expect(screen.getByText('KT Mi:dm')).toBeInTheDocument();
});
