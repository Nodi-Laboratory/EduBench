// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { postWithProviderKeys, saveTestProviderKeys } from './helpers/provider-keys';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { RunController } from '@/components/runs/run-controller';
import { SourcesWorkspace } from '@/components/sources/sources-workspace';

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

  emitActivity(input: {
    id: string;
    aggregate: 'source' | 'generation' | 'benchmark_run';
    aggregateId: string;
    eventType: string;
  }) {
    const envelope = {
      ...input,
      payload: { marker: input.eventType },
      createdAt: '2026-07-26T00:00:01.000Z',
    };
    for (const listener of this.listeners.get('activity') ?? []) {
      listener(new MessageEvent('activity', {
        data: JSON.stringify(envelope),
        lastEventId: input.id,
      }));
    }
  }

  emitOpen() {
    for (const listener of this.listeners.get('open') ?? []) listener(new Event('open'));
  }
}

beforeEach(() => {
  saveTestProviderKeys();
});

afterEach(() => {
  localStorage.clear();
  cleanup();
  sessionStorage.clear();
  EventSourceStub.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a READY source outside the active research profiles exposes one-click reprocessing', async () => {
  const source = {
    id:'source-legacy',
    original_name:'legacy-science.pdf',
    subject:'과학',
    grade:'중2',
    byte_size:10,
    status:'READY',
    failed_stage:null,
    created_at:'2026-07-26T00:00:00.000Z',
    current_job_id:'job-old',
    current_job_state:'SUCCEEDED',
    reprocess_required:true,
  };
  const replacement = {
    ...source,
    id:'source-current',
    status:'UPLOADED',
    current_job_id:'job-new',
    current_job_state:'PENDING',
    reprocess_required:false,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === '/api/sources/source-legacy/reprocess'
      && init?.method === 'POST'
    ) {
      return {
        ok:true,
        json:async () => ({
          id:'source-current',
          jobId:'job-new',
          existing:false,
          reprocessedFrom:'source-legacy',
        }),
      };
    }
    if (url === '/api/sources') {
      return { ok:true, json:async () => ({ items:[replacement, source] }) };
    }
    if (url === '/api/sources/source-current/activity') {
      return {
        ok:true,
        json:async () => ({
          source:{ ...replacement, updated_at:replacement.created_at },
          job:{ id:'job-new', state:'PENDING', attempts:0, max_attempts:4 },
          events:[],
          eventCursor:'0',
        }),
      };
    }
    return { ok:false, json:async () => ({ message:'unexpected request' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<SourcesWorkspace initialSources={[source]} />);
  fireEvent.click(screen.getByRole('button', {
    name:'legacy-science.pdf 현재 설정으로 재처리',
  }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/sources/source-legacy/reprocess',
    postWithProviderKeys,
  ));
  expect(await screen.findByText(
    '현재 연구 설정으로 새 처리 계보를 시작했습니다.',
  )).toBeInTheDocument();
});

test('a delayed source retry refresh cannot overwrite the newly selected source', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const sources = [
    {
      id: 'source-a',
      original_name: 'a.pdf',
      subject: '과학',
      grade: '중2',
      byte_size: 10,
      status: 'FAILED',
      failed_stage: 'PARSING',
      created_at: '2026-07-26T00:00:00.000Z',
      current_job_id: 'job-a',
      current_job_state: 'FAILED',
    },
    {
      id: 'source-b',
      original_name: 'b.pdf',
      subject: '과학',
      grade: '중2',
      byte_size: 10,
      status: 'PARSING',
      failed_stage: null,
      created_at: '2026-07-26T00:00:01.000Z',
      current_job_id: 'job-b',
      current_job_state: 'LEASED',
    },
  ];
  let resolveRetrySnapshot!: (value: {
    ok: boolean;
    json: () => Promise<unknown>;
  }) => void;
  const retrySnapshot = new Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>((resolve) => {
    resolveRetrySnapshot = resolve;
  });
  const fullActivity = (source: typeof sources[number], state: string, eventType: string) => ({
    source: { ...source, updated_at: source.created_at },
    job: { id: source.current_job_id, state, attempts: 1, max_attempts: 4 },
    eventCursor: source.id === 'source-a' ? '10' : '20',
    events: [{
      id: source.id === 'source-a' ? '10' : '20',
      event_type: eventType,
      payload: {},
      created_at: source.created_at,
    }],
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/sources/source-a/retry' && init?.method === 'POST') {
      return { ok: true, json: async () => ({}) };
    }
    if (url === '/api/sources/source-a/activity?history=0') return retrySnapshot;
    if (url === '/api/sources/source-a/activity') {
      return { ok: true, json: async () => fullActivity(sources[0]!, 'A_INITIAL', 'A_INITIAL_EVENT') };
    }
    if (url === '/api/sources/source-b/activity') {
      return { ok: true, json: async () => fullActivity(sources[1]!, 'B_CURRENT', 'B_CURRENT_EVENT') };
    }
    return { ok: true, json: async () => ({ items: sources }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={sources} />);

  fireEvent.click(screen.getByText('a.pdf'));
  await screen.findByText('A_INITIAL_EVENT');
  fireEvent.click(screen.getByRole('button', { name: '문서 처리 재실행' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/sources/source-a/activity?history=0',
    expect.objectContaining({ cache: 'no-store' }),
  ));

  fireEvent.click(screen.getByText('b.pdf'));
  await screen.findByText('B_CURRENT');
  await act(async () => {
    resolveRetrySnapshot({
      ok: true,
      json: async () => ({
        ...fullActivity(sources[0]!, 'A_STALE_RETRY', 'UNUSED'),
        events: undefined,
      }),
    });
    await retrySnapshot;
  });

  expect(screen.getByText('B_CURRENT')).toBeInTheDocument();
  expect(screen.queryByText('A_STALE_RETRY')).not.toBeInTheDocument();
  expect(screen.getByText('B_CURRENT_EVENT')).toBeInTheDocument();
});

test('clicking the already selected source keeps its loaded activity instead of returning to an endless loader', async () => {
  const source = {
    id:'source-a',
    original_name:'science.pdf',
    subject:'과학',
    grade:'고1',
    byte_size:10,
    status:'PARSING',
    failed_stage:null,
    created_at:'2026-07-26T00:00:00.000Z',
    current_job_id:'job-a',
    current_job_state:'LEASED',
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/sources/source-a/activity') {
      return {
        ok:true,
        json:async () => ({
          source:{ ...source, updated_at:source.created_at },
          job:{ id:'job-a', state:'LEASED', attempts:1, max_attempts:4 },
          eventCursor:'10',
          events:[{
            id:'10',
            event_type:'DOCUMENT_PARSE_STARTED',
            payload:{},
            created_at:source.created_at,
          }],
        }),
      };
    }
    return { ok:true, json:async () => ({ items:[source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', EventSourceStub);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getAllByText('science.pdf')[0]!);
  await screen.findByText('Upstage Document Parse 시작');
  fireEvent.click(screen.getAllByText('science.pdf')[0]!);

  expect(screen.getByText('Upstage Document Parse 시작')).toBeInTheDocument();
  expect(screen.queryByText('기록을 불러오는 중입니다.')).not.toBeInTheDocument();
});

test('a delayed source deletion cannot close a newly selected source', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const sources = [
    {
      id: 'source-a',
      original_name: 'a.pdf',
      subject: '과학',
      grade: '중2',
      byte_size: 10,
      status: 'FAILED',
      failed_stage: 'PARSING',
      created_at: '2026-07-26T00:00:00.000Z',
      current_job_id: 'job-a',
      current_job_state: 'FAILED',
    },
    {
      id: 'source-b',
      original_name: 'b.pdf',
      subject: '과학',
      grade: '중2',
      byte_size: 10,
      status: 'PARSING',
      failed_stage: null,
      created_at: '2026-07-26T00:00:01.000Z',
      current_job_id: 'job-b',
      current_job_state: 'LEASED',
    },
  ];
  let resolveDelete!: (value: {
    ok: boolean;
    json: () => Promise<unknown>;
  }) => void;
  const deleteResponse = new Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>((resolve) => {
    resolveDelete = resolve;
  });
  const fullActivity = (source: typeof sources[number], state: string, eventType: string) => ({
    source: { ...source, updated_at: source.created_at },
    job: { id: source.current_job_id, state, attempts: 1, max_attempts: 4 },
    eventCursor: source.id === 'source-a' ? '10' : '20',
    events: [{
      id: source.id === 'source-a' ? '10' : '20',
      event_type: eventType,
      payload: {},
      created_at: source.created_at,
    }],
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/sources/source-a' && init?.method === 'DELETE') return deleteResponse;
    if (url === '/api/sources/source-a/activity') {
      return { ok: true, json: async () => fullActivity(sources[0]!, 'A_INITIAL', 'A_INITIAL_EVENT') };
    }
    if (url === '/api/sources/source-b/activity') {
      return { ok: true, json: async () => fullActivity(sources[1]!, 'B_CURRENT', 'B_CURRENT_EVENT') };
    }
    return { ok: true, json: async () => ({ items: sources }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={sources} />);

  fireEvent.click(screen.getByText('a.pdf'));
  await screen.findByText('A_INITIAL_EVENT');
  fireEvent.click(screen.getByRole('button', { name: 'a.pdf 삭제' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/sources/source-a',
    { method: 'DELETE' },
  ));

  fireEvent.click(screen.getByText('b.pdf'));
  await screen.findByText('B_CURRENT');
  await act(async () => {
    resolveDelete({ ok: true, json: async () => ({}) });
    await deleteResponse;
  });

  expect(screen.getByText('B_CURRENT')).toBeInTheDocument();
  expect(screen.getByText('B_CURRENT_EVENT')).toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: '교과서 처리 기록' })).toBeInTheDocument();
});

test('source replaces full-history polling with one activity stream and preserves logs across coalesced refresh', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const intervalSpy = vi.spyOn(window, 'setInterval');
  const serializePayload = vi.fn(() => ({ marker: 'SOURCE-PAYLOAD' }));
  const source = {
    id: 'source-a',
    original_name: 'science.pdf',
    subject: '과학',
    grade: '중2',
    byte_size: 10,
    status: 'PARSING',
    failed_stage: null,
    created_at: '2026-07-26T00:00:00.000Z',
    current_job_id: 'job-a',
    current_job_state: 'LEASED',
  };
  let pageInitialRequests = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/artifacts?kind=pages&limit=5')) {
      pageInitialRequests += 1;
      if (pageInitialRequests > 1) {
        return {
          ok: true,
          json: async () => ({
            kind: 'pages',
            source: { id: source.id, original_name: source.original_name },
            revision: { id: 'revision-2', revision: 2 },
            completeness: 'COMPLETE',
            expectedPageCount: 1,
            persistedPageCount: 1,
            total: 1,
            nextAfterPage: null,
            items: [{
              id: 'revision-2-page-1',
              pageNumber: 1,
              filename: 'page-1.png',
              mimeType: 'image/png',
              rawHtml: '<p>새 revision 페이지</p>',
              rawMarkdown: '새 revision 페이지',
              rawResponse: { page: 1 },
            }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          kind: 'pages',
          source: { id: source.id, original_name: source.original_name },
          revision: { id: 'revision-1', revision: 1 },
          completeness: 'COMPLETE',
          expectedPageCount: 3,
          persistedPageCount: 3,
          total: 3,
          nextAfterPage: 1,
          items: [{
            id: 'page-1',
            pageNumber: 1,
            filename: 'page-1.png',
            mimeType: 'image/png',
            rawHtml: '<p>첫 페이지</p>',
            rawMarkdown: '첫 페이지',
            rawResponse: { page: 1 },
          }],
        }),
      };
    }
    if (url.endsWith('/artifacts?kind=pages&limit=5&revisionId=revision-1&afterPage=1')) {
      return {
        ok: true,
        json: async () => ({
          kind: 'pages',
          source: { id: source.id, original_name: source.original_name },
          revision: { id: 'revision-1', revision: 1 },
          completeness: 'COMPLETE',
          expectedPageCount: 3,
          persistedPageCount: 3,
          total: 3,
          nextAfterPage: 2,
          items: [{
            id: 'page-2',
            pageNumber: 2,
            filename: 'page-2.png',
            mimeType: 'image/png',
            rawHtml: '<p>둘째 페이지</p>',
            rawMarkdown: '둘째 페이지',
            rawResponse: { page: 2 },
          }],
        }),
      };
    }
    if (url.endsWith('/artifacts?kind=pages&limit=5&revisionId=revision-1&afterPage=2')) {
      return {
        ok: true,
        json: async () => ({
          kind: 'pages',
          source: { id: source.id, original_name: source.original_name },
          revision: { id: 'revision-2', revision: 2 },
          completeness: 'COMPLETE',
          expectedPageCount: 1,
          persistedPageCount: 1,
          total: 1,
          nextAfterPage: null,
          items: [{
            id: 'mismatched-page',
            pageNumber: 1,
            filename: 'page-1.png',
            mimeType: 'image/png',
            rawHtml: '<p>혼합되면 안 되는 페이지</p>',
            rawMarkdown: '혼합되면 안 되는 페이지',
            rawResponse: { page: 1 },
          }],
        }),
      };
    }
    if (url.endsWith('/artifacts?kind=revision')) {
      return {
        ok: true,
        json: async () => ({
          kind: 'revision',
          source: { id: source.id, original_name: source.original_name },
          completeness: 'COMPLETE',
          artifact: {
            id: 'revision-1',
            revision: 1,
            parseModel: 'document-parse',
            parseRequestId: 'parse-request-1',
            rawHtml: '<h1>교과서 사람이 읽는 원문</h1>',
            rawMarkdown: '# 교과서 사람이 읽는 원문',
            rawResponse: { request_id: 'parse-request-1' },
            reviewedHtml: '<h1>교과서 사람이 읽는 원문</h1>',
            reviewSummary: '자동 검수',
            contentIncluded:true,
            contentAvailable:true,
            createdAt: source.created_at,
          },
        }),
      };
    }
    if (url.includes('/activity?history=0')) {
      return {
        ok: true,
        json: async () => ({
          source: { ...source, status: 'PARSED', updated_at: source.created_at },
          job: { id: 'job-a', state: 'SUCCEEDED', attempts: 1, max_attempts: 4 },
          eventCursor: '12',
        }),
      };
    }
    if (url.endsWith('/activity')) {
      return {
        ok: true,
        json: async () => ({
          source: { ...source, updated_at: source.created_at },
          job: { id: 'job-a', state: 'LEASED', attempts: 1, max_attempts: 4 },
          eventCursor: '10',
          events: [{
            id: '10',
            event_type: 'DOCUMENT_PARSE_STARTED',
            payload: { toJSON: serializePayload },
            created_at: source.created_at,
          }],
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getByText('science.pdf'));
  await screen.findByText('Upstage Document Parse 시작');
  expect(serializePayload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Upstage Document Parse 시작'));
  await waitFor(() => expect(serializePayload).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/SOURCE-PAYLOAD/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/artifacts?'))).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: '파싱 원문' }));
  expect(await screen.findByText('# 교과서 사람이 읽는 원문')).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/artifacts?kind=revision'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: '파싱 페이지' }));
  expect(await screen.findByText('첫 페이지')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '페이지 더 보기' }));
  expect(await screen.findByText('둘째 페이지')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/sources/source-a/artifacts?kind=pages&limit=5&revisionId=revision-1&afterPage=1',
    expect.objectContaining({ cache: 'no-store' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '페이지 더 보기' }));
  expect(await screen.findByText('새 revision 페이지')).toBeInTheDocument();
  expect(screen.queryByText('혼합되면 안 되는 페이지')).not.toBeInTheDocument();
  expect(screen.queryByText('첫 페이지')).not.toBeInTheDocument();
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
  expect(EventSourceStub.instances[0]!.url).toBe('/api/events/source/source-a?after=10');
  expect(intervalSpy.mock.calls.some(([, delay]) => delay === 1_000 || delay === 1_500)).toBe(false);

  act(() => {
    EventSourceStub.instances[0]!.emitOpen();
    EventSourceStub.instances[0]!.emitActivity({
      id: '11',
      aggregate: 'source',
      aggregateId: 'source-a',
      eventType: 'UNREGISTERED_SOURCE_EVENT',
    });
    EventSourceStub.instances[0]!.emitActivity({
      id: '12',
      aggregate: 'source',
      aggregateId: 'source-a',
      eventType: 'SECOND_SOURCE_EVENT',
    });
    EventSourceStub.instances[0]!.emitActivity({
      id: '13',
      aggregate: 'source',
      aggregateId: 'source-a',
      eventType: 'PIPELINE_COMPLETED',
    });
  });

  expect(screen.getByText('실시간 연결')).toBeInTheDocument();
  expect(screen.getByText('UNREGISTERED_SOURCE_EVENT')).toBeInTheDocument();
  expect(screen.getByText('SECOND_SOURCE_EVENT')).toBeInTheDocument();
  expect(screen.getByText('교과서 처리 완료')).toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => String(url).includes('/activity?history=0'),
  )).toHaveLength(1));
  expect(within(screen.getAllByText('science.pdf')[0]!.closest('tr')!).getByText('완료')).toBeInTheDocument();
  expect(screen.getByText('Upstage Document Parse 시작')).toBeInTheDocument();
  expect(screen.getByText('UNREGISTERED_SOURCE_EVENT')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '파싱 원문' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => String(url).includes('/artifacts?kind=revision'),
  )).toHaveLength(2));
});

test('generation uses one generic activity event and coalesces snapshot refresh without clearing history', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const intervalSpy = vi.spyOn(window, 'setInterval');
  const serializePayload = vi.fn(() => ({ marker: 'GENERATION-PAYLOAD' }));
  const batchId = 'batch-a';
  const activity = {
    batch: {
      id: batchId,
      state: 'RUNNING',
      requested_count: 2,
      conditions: { executionMode: 'parallel' },
      progress: { completedQuestions: 0, failedQuestions: 0 },
    },
    job: { state: 'LEASED', attempts: 1, max_attempts: 3 },
    eventCursor: '20',
    events: [{
      id: '20',
      event_type: 'GENERATION_STARTED',
      payload: { toJSON: serializePayload },
      created_at: '2026-07-26T00:00:00.000Z',
    }],
    questions: [],
    items: [],
    canResume: false,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/activity?history=0')) {
      return {
        ok: true,
        json: async () => ({
          ...activity,
          batch: {
            ...activity.batch,
            progress: { completedQuestions: 1, failedQuestions: 0 },
          },
          eventCursor: '21',
          events: undefined,
        }),
      };
    }
    if (url.endsWith('/activity')) {
      return { ok: true, json: async () => activity };
    }
    return {
      ok: true,
      json: async () => ({
        items: [{
          id: batchId,
          state: 'RUNNING',
          requested_count: 2,
          created_at: '2026-07-26T00:00:00.000Z',
          progress: { completedQuestions: 0, failedQuestions: 0 },
        }],
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<GenerationWorkspace sources={[]} batches={[{
    id: batchId,
    state: 'RUNNING',
    requested_count: 2,
    created_at: '2026-07-26T00:00:00.000Z',
  }]} />);

  await screen.findByText('생성 배치 시작');
  expect(serializePayload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('생성 배치 시작'));
  await waitFor(() => expect(serializePayload).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/GENERATION-PAYLOAD/)).toBeInTheDocument();
  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
  expect(EventSourceStub.instances[0]!.url).toBe('/api/events/generation/batch-a?after=20');
  expect(intervalSpy.mock.calls.some(([, delay]) => delay === 1_000 || delay === 1_500)).toBe(false);
  act(() => {
    EventSourceStub.instances[0]!.emitOpen();
    EventSourceStub.instances[0]!.emitActivity({
      id: '21',
      aggregate: 'generation',
      aggregateId: batchId,
      eventType: 'UNREGISTERED_GENERATION_EVENT',
    });
  });

  expect(screen.getByText('실시간 연결')).toBeInTheDocument();
  expect(screen.getByText('UNREGISTERED_GENERATION_EVENT')).toBeInTheDocument();
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('/activity?history=0'),
  )).toBe(true));
  expect(within(screen.getByText('batch-a').closest('button')!).getByText('1/2문항')).toBeInTheDocument();
  expect(screen.getByText('생성 배치 시작')).toBeInTheDocument();
  expect(screen.getByText('UNREGISTERED_GENERATION_EVENT')).toBeInTheDocument();
});

test('run starts after its atomic snapshot cursor and displays an unknown event without a whitelist', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const serializePayload = vi.fn(() => ({ marker: 'RUN-PAYLOAD' }));
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      run: {
        id: 'run-a',
        public_id: 'RUN-A',
        title: '실행',
        state: 'RUNNING',
        total_items: 1,
        completed_items: 1,
        failed_items: 0,
        dataset_version: 'actual-v1',
        score_version: 'score-v1',
        price_profile_version: 'price-v1',
        created_at: '2026-07-26T00:00:00.000Z',
      },
      items: [],
      eventCursor: '31',
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  render(<RunController
    initialRun={{ id:'run-a', public_id:'RUN-A', title:'실행', state:'RUNNING', total_items:1, completed_items:0, failed_items:0, dataset_version:'actual-v1', score_version:'score-v1', price_profile_version:'price-v1', created_at:'2026-07-26T00:00:00.000Z' }}
    models={[]}
    profile={{ version:'score-v1', title:'평가', metrics:[], rubricPrompt:'', judgeProvider:null, judgeModel:null, contentHash:'hash', dynamicMetrics:[] }}
    initialItems={[]}
    initialEvents={[{
      id: '30',
      event_type: 'RUN_STARTED',
      payload: { state: 'RUNNING', toJSON: serializePayload },
      created_at: '2026-07-26T00:00:00.000Z',
    }]}
    initialEventCursor="30"
  />);

  await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
  expect(EventSourceStub.instances[0]!.url).toBe('/api/events/benchmark_run/run-a?after=30');
  expect(screen.getByText('RUN_STARTED')).toBeInTheDocument();
  expect(serializePayload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('RUN_STARTED'));
  await waitFor(() => expect(serializePayload).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/RUN-PAYLOAD/)).toBeInTheDocument();
  act(() => {
    EventSourceStub.instances[0]!.emitOpen();
    EventSourceStub.instances[0]!.emitActivity({
      id: '31',
      aggregate: 'benchmark_run',
      aggregateId: 'run-a',
      eventType: 'UNREGISTERED_RUN_EVENT',
    });
  });

  expect(screen.getByText('실시간 연결')).toBeInTheDocument();
  expect(screen.getByText('UNREGISTERED_RUN_EVENT')).toBeInTheDocument();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/details?history=0'));
  expect(screen.getByText('RUN_STARTED')).toBeInTheDocument();
});
