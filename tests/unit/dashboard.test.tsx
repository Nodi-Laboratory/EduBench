// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';

afterEach(cleanup);

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

test('labels eligible result responses separately from raw execution completion', () => {
  render(<DashboardOverview
    latest={{
      id:'run-1',
      public_id:'RUN-1',
      title:'대시보드 실행',
      state:'CANCELLED',
      total_items:2,
      eligible_response_count:1,
      execution_completed_items:2,
      failed_items:0,
    }}
    models={[{
      display_name:'Gemini',
      model_id:'candidate-model',
      total:'2',
      done:'1',
      failed:'0',
      latency:null,
      tokens:null,
      cost:null,
    }]}
    recent={[{
      id:'run-1',
      public_id:'RUN-1',
      title:'대시보드 실행',
      state:'CANCELLED',
      total_items:2,
      eligible_response_count:1,
      execution_completed_items:2,
    }]}
  />);

  expect(screen.getByText('평가 가능 응답')).toBeInTheDocument();
  expect(screen.getByText(/실행 성공 2/)).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name:'평가 응답 / 전체' })).toBeInTheDocument();
  expect(screen.getAllByText('1 / 2').length).toBeGreaterThan(0);
});
