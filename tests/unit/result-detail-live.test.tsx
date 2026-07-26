// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ResultDetailLive } from '@/components/results/result-detail-live';
import { parseEventCursor } from '@/domain/event-cursor';
import type { ResultDetails } from '@/server/results/details';

class EventSourceStub {
  static instances: EventSourceStub[] = [];

  readonly url: string;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  emitActivity(id: string, eventType: string) {
    for (const listener of this.listeners.get('activity') ?? []) {
      listener(new MessageEvent('activity', {
        data: JSON.stringify({
          id,
          aggregate: 'benchmark_run',
          aggregateId: 'run-1',
          eventType,
          payload: {},
          createdAt: '2026-07-26T00:00:01.000Z',
        }),
        lastEventId: id,
      }));
    }
  }
}

function details(input?: {
  state?: string;
  eligibleItems?: number;
  responses?: string;
  exactMatch?: string | null;
  eventCursor?: string;
  engineVerified?: boolean;
}): ResultDetails {
  const exactMatch = input?.exactMatch ?? null;
  const engineVerified = input?.engineVerified ?? true;
  return {
    run: {
      id: 'run-1',
      publicId: 'RUN-1',
      title: '실시간 결과',
      state: input?.state ?? 'SCORING',
      datasetVersion: 'dataset-v1',
      scoreVersion: 'score-v1',
      totalItems: 2,
      completedItems: input?.eligibleItems ?? 0,
      eligibleItems: input?.eligibleItems ?? 0,
      failedItems: 0,
      parameters: {},
      scoreProfileSnapshotProvenance: 'CREATED_WITH_SNAPSHOT',
      profileReplacementRequired: false,
    },
    scoringEngine: {
      id: engineVerified ? 'engine-v1-id' : null,
      version: engineVerified ? 'edubench-scoring-v1' : null,
      title: engineVerified ? 'EduBench 선수관계 평가 엔진 v1' : null,
      contentHash: engineVerified ? 'a'.repeat(64) : null,
      snapshotProvenance: engineVerified
        ? 'AT_CREATION_VERIFIED'
        : 'LEGACY_BACKFILL_UNVERIFIED',
      verified: engineVerified,
      currentVerified: engineVerified,
    },
    models: [{
      blindId: 'M01',
      displayName: 'Gemini',
      modelId: 'gemini-test',
      responses: input?.responses ?? '0',
      exactMatch,
      latency: exactMatch == null ? null : '880',
      inputTokens: exactMatch == null ? null : '120',
      outputTokens: exactMatch == null ? null : '42',
      costKrw: exactMatch == null ? null : '3.5',
    }],
    metricSummary: exactMatch == null ? [] : [{
      blindId: 'M01',
      metricKey: 'accuracy',
      score: exactMatch,
      sampleCount: '1',
    }],
    capabilities: exactMatch == null ? [] : [{
      blindId: 'M01',
      purpose: '선수 관계',
      score: exactMatch,
      sampleCount: '1',
    }],
    analytics: {
      models: [{
        blindId: 'M01',
        displayName: 'Gemini',
        modelId: 'gemini-test',
        responses: Number(input?.responses ?? '0'),
        avgLatencyMs: exactMatch == null ? null : 880,
        costKrw: exactMatch == null ? null : 3.5,
        compositeScore: exactMatch == null ? null : Number(exactMatch),
        scoreCount: exactMatch == null ? 0 : 1,
      }],
      metricRows: exactMatch == null ? [] : [{
        metricKey: 'accuracy',
        label: '정확성',
        scores: { M01: Number(exactMatch) },
        counts: { M01: 1 },
      }],
      purposeRows: exactMatch == null ? [] : [{
        purpose: '선수 관계',
        scores: { M01: Number(exactMatch) },
        counts: { M01: 1 },
      }],
      prerequisiteRows: [],
      questionRows: [],
      distributions: [{ blindId: 'M01', bins: [0, 0, 0, 0, exactMatch == null ? 0 : 1] }],
    },
    eventCursor: parseEventCursor(input?.eventCursor ?? '40')!,
  } as ResultDetails;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  EventSourceStub.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('updates result summaries and charts from a coalesced score-event snapshot without polling', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const intervalSpy = vi.spyOn(window, 'setInterval');
  const refreshed = details({
    state: 'COMPLETED',
    eligibleItems: 1,
    responses: '1',
    exactMatch: '0.9',
    eventCursor: '43',
  });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => refreshed,
  }));
  vi.stubGlobal('fetch', fetchMock);

  render(<ResultDetailLive initialDetails={details()} />);

  expect(screen.getByRole('link', { name: /JSON/ })).toHaveAttribute(
    'href',
    '/api/results/run-1/export?format=json',
  );
  expect(screen.getByText('SCORING')).toBeInTheDocument();
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
  expect(EventSourceStub.instances[0]!.url).toBe(
    '/api/events/benchmark_run/run-1?after=40',
  );
  expect(intervalSpy.mock.calls.some(([, delay]) => (
    delay === 1_000 || delay === 1_500
  ))).toBe(false);

  act(() => {
    EventSourceStub.instances[0]!.emit('open');
    EventSourceStub.instances[0]!.emitActivity('41', 'RUN_SCORE_UPDATED');
    EventSourceStub.instances[0]!.emitActivity('42', 'RUN_SCORE_UPDATED');
    EventSourceStub.instances[0]!.emitActivity('43', 'RUN_COMPLETED');
  });

  expect(screen.getByText('실시간 연결')).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/results/run-1/details',
    expect.objectContaining({ cache: 'no-store' }),
  );
  expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
  const modelTable = screen.getByRole('heading', { name: '모델별 실제 집계' })
    .closest('section');
  expect(modelTable).not.toBeNull();
  expect(within(modelTable!).getByText('90.0%')).toBeInTheDocument();
  expect(screen.getByTestId('ranking-M01')).toHaveTextContent('90.0%');
  expect(screen.getByLabelText('상세 평가 지표')).toHaveValue('accuracy');
  expect(screen.queryByText('지표를 선택하세요.')).not.toBeInTheDocument();
});

test('refreshes on another terminal run event and keeps the last good snapshot on failure', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => details({ state: 'FAILED', eventCursor: '51' }),
    })
    .mockRejectedValue(new Error('network unavailable'));
  vi.stubGlobal('fetch', fetchMock);

  render(<ResultDetailLive initialDetails={details({ eventCursor: '49' })} />);
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

  act(() => {
    EventSourceStub.instances[0]!.emitActivity('50', 'RUN_FAILED');
  });
  expect(await screen.findByText('FAILED')).toBeInTheDocument();

  act(() => {
    EventSourceStub.instances[0]!.emitActivity('51', 'RUN_SCORING_FAILED');
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByText('FAILED')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(
    '최신 결과를 불러오지 못했습니다',
  );
});

test('retries one failed final-event snapshot and applies the completed result without another event', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ code: 'TEMPORARY_FAILURE' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => details({
        state: 'COMPLETED',
        eligibleItems: 2,
        responses: '2',
        exactMatch: '0.85',
        eventCursor: '60',
      }),
    });
  vi.stubGlobal('fetch', fetchMock);

  render(<ResultDetailLive initialDetails={details({ eventCursor: '59' })} />);
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

  act(() => {
    EventSourceStub.instances[0]!.emitActivity('60', 'RUN_COMPLETED');
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
  expect(screen.getByTestId('ranking-M01')).toHaveTextContent('85.0%');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows scoring-engine provenance and explicitly marks legacy charts as non-official', () => {
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResultDetailLive initialDetails={details({
    engineVerified: false,
    exactMatch: '0.7',
  })} />);

  expect(screen.getByRole('heading', { name: '채점 엔진 검증' }))
    .toBeInTheDocument();
  expect(screen.getByText(/provenance LEGACY_BACKFILL_UNVERIFIED/))
    .toBeInTheDocument();
  expect(screen.getByText(/비공식 분석/)).toBeInTheDocument();
  expect(screen.getByLabelText('비공식 벤치마크 분석 차트'))
    .toHaveAttribute('data-official', 'false');
});
