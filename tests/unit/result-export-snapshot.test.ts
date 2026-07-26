import { beforeEach, expect, test, vi } from 'vitest';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/server/db/pool', () => ({
  db: database,
}));

import { GET } from '@/app/api/results/[id]/export/route';

beforeEach(() => {
  database.connect.mockReset();
  database.query.mockReset();
});

test('reads the exported run, items, and Judge invocations through one repeatable-read client', async () => {
  const release = vi.fn();
  const clientQuery = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin isolation level repeatable read read only') {
      return { rows: [] };
    }
    if (normalized === 'commit') return { rows: [] };
    if (normalized.includes('from benchmark_runs br join dataset_versions')) {
      return {
        rows: [{
          id: 'run-export',
          public_id: 'RUN-EXPORT',
          scoring_engine_version_id: null,
          scoring_engine_snapshot: null,
          scoring_engine_snapshot_provenance: 'LEGACY_BACKFILL_UNVERIFIED',
        }],
      };
    }
    if (normalized.includes('from run_items ri join benchmark_runs')) {
      return {
        rows: [{
          run_item_id: 'item-1',
          model_response_id: null,
          question_id: 'Q-1',
          blind_id: 'M01',
          state: 'PENDING',
          scores: {},
        }],
      };
    }
    if (normalized.includes('from judge_invocations invocation')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${normalized}`);
  });
  database.connect.mockResolvedValue({
    query: clientQuery,
    release,
  });
  database.query.mockRejectedValue(new Error('AUTOCOMMIT_QUERY_USED'));

  const response = await GET(
    new Request('http://localhost/api/results/run-export/export?format=json'),
    { params: Promise.resolve({ id: 'run-export' }) },
  );

  expect(response.status).toBe(200);
  expect(database.query).not.toHaveBeenCalled();
  expect(database.connect).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(clientQuery.mock.calls.map(([sql]) => (
    String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
  ))).toEqual([
    'begin isolation level repeatable read read only',
    expect.stringContaining('from benchmark_runs br join dataset_versions'),
    expect.stringContaining('from run_items ri join benchmark_runs'),
    expect.stringContaining('from judge_invocations invocation'),
    'commit',
  ]);
});
