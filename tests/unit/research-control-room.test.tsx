// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ResearchControlRoom } from '@/components/research-control-room/research-control-room';
import type { ControlRoomSnapshot } from '@/components/research-control-room/types';

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

  emit(type: 'open' | 'error') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  emitControlRoom(event: ControlRoomSnapshot['recentEvents'][number]) {
    for (const listener of this.listeners.get('control-room') ?? []) {
      listener(new MessageEvent('control-room', {
        data: JSON.stringify(event),
        lastEventId: event.id,
      }));
    }
  }
}

const snapshot: ControlRoomSnapshot = {
  eventCursor: '941',
  generatedAt: '2026-07-27T04:00:00.000Z',
  system: {
    database: { state: 'HEALTHY', latencyMs: 12 },
    worker: { state: 'HEALTHY', activeLeases: 3, staleLeases: 1 },
    queue: { pending: 7, retryWait: 2, leased: 3 },
  },
  pipelineStages: [
    { key: 'upload', label: 'Upload', active: 1, failed: 0, ready: 12 },
    { key: 'parse', label: 'Parse', active: 2, failed: 1, ready: 11 },
    { key: 'chunk', label: 'Chunk', active: 0, failed: 0, ready: 10 },
    { key: 'embed', label: 'Embed', active: 1, failed: 0, ready: 9 },
    { key: 'generate', label: 'Generate', active: 4, failed: 1, ready: 20 },
    { key: 'review', label: 'Review', active: 3, failed: 0, ready: 17 },
    { key: 'freeze', label: 'Freeze', active: 0, failed: 0, ready: 6 },
    { key: 'execute', label: 'Execute', active: 9, failed: 2, ready: 35 },
    { key: 'score', label: 'Score', active: 2, failed: 0, ready: 33 },
  ],
  activeOperations: [{
    aggregateType: 'source',
    aggregateId: 'source-8f53ba3c',
    label: '중학교 과학 2 교과서 파싱',
    stage: 'PARSE',
    state: 'LEASED',
    progress: { pagesCompleted: 42, pagesTotal: 180 },
    updatedAt: '2026-07-27T03:59:50.000Z',
    error: null,
  }],
  failures: [{
    aggregateType: 'source',
    aggregateId: 'source-141d7aa0',
    label: '한국사 교과서 표 추출',
    stage: 'PARSE',
    code: 'PARSE_TIMEOUT',
    message: 'Document Parse 응답 제한 시간을 초과했습니다.',
    updatedAt: '2026-07-27T03:58:00.000Z',
  }],
  failureTotal: 9,
  recentEvents: [{
    id: '941',
    aggregateType: 'benchmark_run',
    aggregateId: 'run-829d61a5',
    eventType: 'MODEL_RESPONSE_SCORED',
    stage: 'SCORE',
    state: 'SUCCEEDED',
    summary: 'Gemini 응답의 선수관계 추론 점수를 저장했습니다.',
    payload: {
      model: 'gemini-2.5-pro',
      metric: 'prerequisite_reasoning',
      value: 0.825,
    },
    createdAt: '2026-07-27T03:59:55.000Z',
  }],
  profiles: [{
    kind: 'embedding_rag',
    id: 'profile-rag-1',
    version: 'v3',
    title: 'PIKE-RAG 교과서 검색 프로필',
    hash: 'sha256:0123456789abcdef',
    activatedAt: '2026-07-27T00:00:00.000Z',
  }],
  scoreboard: [{
    runId: 'run-829d61a5',
    runLabel: '한국사 선수관계 실험 07',
    model: 'Gemini 2.5 Pro',
    metric: 'Prerequisite reasoning',
    mean: 0.825,
    scored: 8,
    eligible: 10,
  }],
  scoreboardTotal: 12,
};

function response(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  EventSourceStub.instances = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('renders the real system, pipeline, operation, profile, and score snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(snapshot)));
  vi.stubGlobal('EventSource', EventSourceStub);

  const { container } = render(<ResearchControlRoom />);

  expect(await screen.findByRole('heading', { name: 'Research Control Room' }))
    .toBeInTheDocument();
  expect(screen.getByText('12 ms')).toBeInTheDocument();
  expect(screen.getByText('대기 7')).toBeInTheDocument();
  expect(screen.getByText('중학교 과학 2 교과서 파싱')).toBeInTheDocument();
  expect(screen.getByText('PIKE-RAG 교과서 검색 프로필')).toBeInTheDocument();
  expect(screen.getByText('Gemini 2.5 Pro')).toBeInTheDocument();
  expect(screen.getByText('82.5%')).toBeInTheDocument();
  expect(screen.getByText('8 / 10')).toBeInTheDocument();
  expect(screen.getByText('표시 1 / 전체 9')).toBeInTheDocument();
  expect(screen.getByText('표시 1 / 전체 12')).toBeInTheDocument();
  expect(container.querySelector('main')).toBeNull();
  expect(container.querySelector('section.research-control-room'))
    .toHaveAttribute('aria-labelledby', 'research-control-room-title');

  for (const label of [
    'Upload',
    'Parse',
    'Chunk',
    'Embed',
    'Generate',
    'Review',
    'Freeze',
    'Execute',
    'Score',
  ]) {
    expect(screen.getByRole('button', { name: new RegExp(label) }))
      .toBeInTheDocument();
  }
});

test('opens a human-readable inspector and exposes the actual JSON payload', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  vi.stubGlobal('fetch', vi.fn(async () => response(snapshot)));
  vi.stubGlobal('EventSource', EventSourceStub);
  render(<ResearchControlRoom />);

  fireEvent.click(await screen.findByRole('button', {
    name: /한국사 교과서 표 추출/,
  }));

  const inspector = screen.getByRole('complementary', { name: 'Inspector Dock' });
  expect(inspector).toHaveTextContent('Document Parse 응답 제한 시간을 초과했습니다.');
  expect(inspector).toHaveTextContent('PARSE');
  expect(inspector).toHaveTextContent('PARSE_TIMEOUT');
  expect(inspector).toHaveTextContent('2026');
  expect(inspector).toHaveTextContent('"aggregateId": "source-141d7aa0"');

  fireEvent.click(screen.getByRole('button', { name: 'JSON 복사' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(
    expect.stringContaining('"code": "PARSE_TIMEOUT"'),
  ));

  fireEvent.click(screen.getByRole('button', { name: /Gemini 응답의 선수관계/ }));
  expect(inspector).toHaveTextContent('MODEL_RESPONSE_SCORED');
  expect(inspector).toHaveTextContent('"metric": "prerequisite_reasoning"');
  expect(screen.getByRole('button', { name: 'JSON 복사' })).toBeInTheDocument();
});

test('renders explicit empty states without inventing operational data', async () => {
  const empty: ControlRoomSnapshot = {
    ...snapshot,
    pipelineStages: [],
    activeOperations: [],
    failures: [],
    failureTotal: 0,
    recentEvents: [],
    profiles: [],
    scoreboard: [],
    scoreboardTotal: 0,
  };
  vi.stubGlobal('fetch', vi.fn(async () => response(empty)));
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResearchControlRoom />);

  expect(await screen.findByText('파이프라인 집계가 없습니다.')).toBeInTheDocument();
  expect(screen.getByText('활성 작업이 없습니다.')).toBeInTheDocument();
  expect(screen.getByText('실패 기록이 없습니다.')).toBeInTheDocument();
  expect(screen.getByText('최근 이벤트가 없습니다.')).toBeInTheDocument();
  expect(screen.getByText('활성 프로필이 없습니다.')).toBeInTheDocument();
  expect(screen.getByText('집계 가능한 점수가 없습니다.')).toBeInTheDocument();
});

test('waits for the initial snapshot cursor before opening the event stream', async () => {
  let resolveSnapshot!: (value: Response) => void;
  const initialSnapshot = new Promise<Response>((resolve) => {
    resolveSnapshot = resolve;
  });
  vi.stubGlobal('fetch', vi.fn(() => initialSnapshot));
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResearchControlRoom />);
  await act(async () => {
    await Promise.resolve();
  });

  expect(EventSourceStub.instances).toHaveLength(0);

  await act(async () => {
    resolveSnapshot(response(snapshot));
    await initialSnapshot;
    await Promise.resolve();
  });

  expect(EventSourceStub.instances).toHaveLength(1);
  expect(EventSourceStub.instances[0]?.url)
    .toBe('/api/research/control-room/events?after=941');
});

test('ignores replayed event cursors and refreshes only after a newer cursor is accepted', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => response(snapshot));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResearchControlRoom />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const stream = EventSourceStub.instances[0];

  act(() => {
    stream?.emitControlRoom({ ...snapshot.recentEvents[0]!, id: '940' });
    stream?.emitControlRoom({ ...snapshot.recentEvents[0]!, id: '941' });
  });
  await act(async () => {
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  act(() => {
    stream?.emitControlRoom({ ...snapshot.recentEvents[0]!, id: '942' });
  });
  await act(async () => {
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('coalesces burst SSE events into one snapshot refresh after 800 ms', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => response(snapshot));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<ResearchControlRoom />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const stream = EventSourceStub.instances[0];
  expect(stream?.url).toBe('/api/research/control-room/events?after=941');

  act(() => {
    stream?.emit('open');
    stream?.emitControlRoom(snapshot.recentEvents[0]!);
    stream?.emitControlRoom({ ...snapshot.recentEvents[0]!, id: '942' });
    stream?.emitControlRoom({ ...snapshot.recentEvents[0]!, id: '943' });
  });
  expect(screen.getByText('LIVE 연결됨')).toBeInTheDocument();
  expect(screen.getByText(/마지막 이벤트.*방금 전/)).toBeInTheDocument();

  await act(async () => {
    vi.advanceTimersByTime(799);
    await Promise.resolve();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
