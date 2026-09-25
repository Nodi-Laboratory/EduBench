// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ResultDetailLive } from '@/components/results/result-detail-live';
import { parseEventCursor } from '@/domain/event-cursor';
import type { ResultDetails } from '@/server/results/details';
import { buildResultAnalytics } from '@/server/results/analytics';

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
  score?: string | null;
  eventCursor?: string;
  engineVerified?: boolean;
  modelExecution?: {
    totalItems: string;
    succeededItems: string;
    failedItems: string;
    representativeFailure: {
      code: string;
      message: string;
      count: string;
      latestAt: string;
    } | null;
  };
}): ResultDetails {
  const score = input?.score ?? null;
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
      retrievalModes:['LEGACY_EVIDENCE'],
      retrievalConfigSnapshot:{
        schemaVersion:1,
        strategy:'legacy-question-evidence',
      },
      retrievalConfigHash:null,
      retrievalSnapshotProvenance:'LEGACY_BACKFILL_UNVERIFIED',
    },
    scoringEngine: {
      id: engineVerified ? 'engine-v1-id' : null,
      version: engineVerified ? 'edubench-scoring-v2' : null,
      title: engineVerified ? 'EduBench 선수관계 평가 엔진 v2' : null,
      contentHash: engineVerified ? 'a'.repeat(64) : null,
      snapshotProvenance: engineVerified
        ? 'AT_CREATION_VERIFIED'
        : 'LEGACY_BACKFILL_UNVERIFIED',
      verified: engineVerified,
      currentVerified: engineVerified,
    },
    models: [{
      blindId: 'M01',
      retrievalMode:'LEGACY_EVIDENCE',
      displayName: 'Gemini',
      modelId: 'gemini-test',
      responses: input?.responses ?? '0',
      totalItems: input?.modelExecution?.totalItems ?? '2',
      succeededItems: input?.modelExecution?.succeededItems ?? '0',
      failedItems: input?.modelExecution?.failedItems ?? '0',
      representativeFailure: input?.modelExecution?.representativeFailure ?? null,
      latency: score == null ? null : '880',
      inputTokens: score == null ? null : '120',
      outputTokens: score == null ? null : '42',
      costKrw: score == null ? null : '3.5',
    }],
    metricSummary: score == null ? [] : [{
      blindId: 'M01',
      retrievalMode:'LEGACY_EVIDENCE',
      metricKey: 'accuracy',
      score,
      sampleCount: '1',
    }],
    capabilities: score == null ? [] : [{
      blindId: 'M01',
      retrievalMode:'LEGACY_EVIDENCE',
      purpose: '선수 관계',
      score,
      sampleCount: '1',
    }],
    analytics: {
      models: [{
        blindId: 'M01',
        retrievalMode:'LEGACY_EVIDENCE',
        seriesKey:'M01::LEGACY_EVIDENCE',
        displayName: 'Gemini',
        modelId: 'gemini-test',
        responses: Number(input?.responses ?? '0'),
        avgLatencyMs: score == null ? null : 880,
        costKrw: score == null ? null : 3.5,
        compositeScore: score == null ? null : Number(score),
        scoreCount: score == null ? 0 : 1,
      }],
      metricRows: score == null ? [] : [{
        metricKey: 'accuracy',
        label: '정확성',
        scores: { 'M01::LEGACY_EVIDENCE': Number(score) },
        counts: { 'M01::LEGACY_EVIDENCE': 1 },
      }],
      purposeRows: score == null ? [] : [{
        purpose: '선수 관계',
        scores: { 'M01::LEGACY_EVIDENCE': Number(score) },
        counts: { 'M01::LEGACY_EVIDENCE': 1 },
      }],
      prerequisiteRows: [],
      distributions: [{ blindId: 'M01::LEGACY_EVIDENCE', bins: [0, 0, 0, 0, score == null ? 0 : 1] }],
    },
    eventCursor: parseEventCursor(input?.eventCursor ?? '40')!,
  } as ResultDetails;
}

function heatmapPage() {
  return { page:1, pageSize:25, total:0, rows:[] };
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
    score: '0.9',
    eventCursor: '43',
  });
  const fetchMock = vi.fn(async (input: string) => ({
    ok: true,
    json: async () => input.includes('/heatmap') ? heatmapPage() : refreshed,
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
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => (
    input === '/api/results/run-1/details'
  ))).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/results/run-1/details',
    expect.objectContaining({ cache: 'no-store' }),
  );
  expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
  const modelTable = screen.getByRole('heading', { name: '모델별 실제 집계' })
    .closest('section');
  expect(modelTable).not.toBeNull();
  expect(within(modelTable!).getByText('880 ms')).toBeInTheDocument();
  expect(within(modelTable!).queryByText('완전 일치')).not.toBeInTheDocument();
  expect(screen.getByTestId('ranking-M01')).toHaveTextContent('90.0%');
  expect(screen.getByLabelText('상세 평가 지표')).toHaveValue('accuracy');
  expect(screen.queryByText('지표를 선택하세요.')).not.toBeInTheDocument();
});

test('shows execution coverage and an explicit reason when a model has zero responses because every item failed', () => {
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResultDetailLive initialDetails={details({
    responses: '0',
    modelExecution: {
      totalItems: '2',
      succeededItems: '0',
      failedItems: '2',
      representativeFailure: {
        code: 'OPENAI_INCOMPLETE_RESPONSE',
        message: 'OpenAI 응답이 출력 한도 전에 완료되지 않았습니다.',
        count: '2',
        latestAt: '2026-07-28T04:15:00.000Z',
      },
    },
  })} />);

  const modelTable = screen.getByRole('heading', { name: '모델별 실제 집계' })
    .closest('section');
  expect(modelTable).not.toBeNull();
  expect(within(modelTable!).getByText('성공 0 / 전체 2')).toBeInTheDocument();
  expect(within(modelTable!).getByText('실패 2')).toBeInTheDocument();
  expect(within(modelTable!).getByText('응답 0 · 전체 실패')).toBeInTheDocument();
  expect(within(modelTable!).getByText('OPENAI_INCOMPLETE_RESPONSE · 2건'))
    .toBeInTheDocument();
  expect(within(modelTable!).getByText(
    'OpenAI 응답이 출력 한도 전에 완료되지 않았습니다.',
  )).toBeInTheDocument();
});

test('applies the 일반, RAG, and Pike selection to tables and export links', () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const comparison = details({ responses:'1', score:'0.8' });
  comparison.run.retrievalModes = ['NONE', 'VECTOR', 'PIKE'];
  comparison.run.retrievalConfigHash = 'a'.repeat(64);
  comparison.run.retrievalSnapshotProvenance = 'AT_CREATION_VERIFIED';
  comparison.models = ['NONE', 'VECTOR', 'PIKE'].map((retrievalMode) => ({
    ...comparison.models[0]!,
    retrievalMode:retrievalMode as 'NONE' | 'VECTOR' | 'PIKE',
  }));
  comparison.metricSummary = ['NONE', 'VECTOR', 'PIKE'].map(
    (retrievalMode) => ({
      ...comparison.metricSummary[0]!,
      retrievalMode:retrievalMode as 'NONE' | 'VECTOR' | 'PIKE',
    }),
  );
  comparison.capabilities = ['NONE', 'VECTOR', 'PIKE'].map(
    (retrievalMode) => ({
      ...comparison.capabilities[0]!,
      retrievalMode:retrievalMode as 'NONE' | 'VECTOR' | 'PIKE',
    }),
  );
  comparison.analytics = buildResultAnalytics({
    models:comparison.models.map((model) => ({
      blindId:model.blindId,
      retrievalMode:model.retrievalMode,
      displayName:model.displayName,
      modelId:model.modelId,
      responses:Number(model.responses),
      avgLatencyMs:Number(model.latency),
      costKrw:Number(model.costKrw),
    })),
    scores:['NONE', 'VECTOR', 'PIKE'].map((retrievalMode) => ({
      blindId:'M01',
      retrievalMode:retrievalMode as 'NONE' | 'VECTOR' | 'PIKE',
      questionId:'q1',
      questionPublicId:'Q-1',
      questionText:'질문',
      purpose:'선수 관계',
      metricKey:'accuracy',
      value:0.8,
    })),
  });

  render(<ResultDetailLive initialDetails={comparison} />);
  const modelTable = screen.getByRole('heading', { name:'모델별 실제 집계' })
    .closest('section')!;
  expect(within(modelTable).getAllByRole('row')).toHaveLength(4);
  const rag = screen.getByRole('button', { name:'RAG 결과 표시' });
  fireEvent.click(rag);
  expect(within(modelTable).getAllByRole('row')).toHaveLength(3);
  expect(screen.getByRole('link', { name:/JSON/ })).toHaveAttribute(
    'href',
    '/api/results/run-1/export?format=json&modes=NONE%2CPIKE',
  );
});

test('refreshes on another terminal run event and keeps the last good snapshot on failure', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  let detailRequests = 0;
  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes('/heatmap')) return { ok:true, json:async () => heatmapPage() };
    detailRequests += 1;
    if (detailRequests === 1) {
      return { ok:true, json:async () => details({ state:'FAILED', eventCursor:'51' }) };
    }
    throw new Error('network unavailable');
  });
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
  await waitFor(() => expect(detailRequests).toBe(2));
  expect(screen.getByText('FAILED')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(
    '최신 결과를 불러오지 못했습니다',
  );
});

test('retries one failed final-event snapshot and applies the completed result without another event', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  let detailRequests = 0;
  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes('/heatmap')) return { ok:true, json:async () => heatmapPage() };
    detailRequests += 1;
    if (detailRequests === 1) {
      return { ok:false, status:500, json:async () => ({ code:'TEMPORARY_FAILURE' }) };
    }
    return {
      ok:true,
      json:async () => details({
        state:'COMPLETED', eligibleItems:2, responses:'2', score:'0.85', eventCursor:'60',
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<ResultDetailLive initialDetails={details({ eventCursor: '59' })} />);
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

  act(() => {
    EventSourceStub.instances[0]!.emitActivity('60', 'RUN_COMPLETED');
  });

  await waitFor(() => expect(detailRequests).toBe(2));
  expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
  expect(screen.getByTestId('ranking-M01')).toHaveTextContent('85.0%');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows scoring-engine provenance and explicitly marks legacy charts as non-official', () => {
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResultDetailLive initialDetails={details({
    engineVerified: false,
    score: '0.7',
  })} />);

  expect(screen.getByRole('heading', { name: '채점 엔진 검증' }))
    .toBeInTheDocument();
  expect(screen.getByText(/provenance LEGACY_BACKFILL_UNVERIFIED/))
    .toBeInTheDocument();
  expect(screen.getByText(/비공식 분석/)).toBeInTheDocument();
  expect(screen.getByLabelText('비공식 벤치마크 분석 차트'))
    .toHaveAttribute('data-official', 'false');
});
