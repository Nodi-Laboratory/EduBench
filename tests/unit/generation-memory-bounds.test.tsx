// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';

class EventSourceStub {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function generationItem(
  id:string,
  ordinal:number,
  state = 'FAILED',
) {
  return {
    id,
    ordinal,
    state,
    attempts:1,
    retryable:true,
    direction:{
      directionSummary:`direction-${ordinal}`,
      rawOnly:{ marker:`DIRECTION-RAW-${ordinal}` },
    },
    error:{
      code:'GENERATION_PARSE_FAILED',
      message:`${ordinal}번 실패`,
      retryable:true,
    },
    latestRetrieval:null,
    providerInvocationSummary:{
      total:1,
      requested:0,
      completed:1,
      failed:0,
      abandoned:0,
    },
    questionId:null,
    questionPublicId:null,
    startedAt:null,
    completedAt:null,
    updatedAt:'2026-07-30T00:00:00.000Z',
  };
}

function auditPage(itemId:string, marker:string) {
  return {
    batchId:'batch-memory',
    itemId,
    latestRetrieval:{
      id:`retrieval-${itemId}`,
      attempt:1,
      queryText:`query-${marker}`,
      candidateScope:{ rawOnlyMarker:`RETRIEVAL-RAW-${marker}` },
      selectedChunks:[{
        chunkId:`chunk-${marker}`,
        rank:1,
        content:`chunk-content-${marker}`,
      }],
      createdAt:'2026-07-30T00:00:00.000Z',
    },
    providerInvocations:[{
      id:`invocation-${itemId}`,
      itemAttempt:1,
      stage:'QUESTION',
      state:'COMPLETED',
      provider:'gemini',
      modelId:'gemini-test',
      requestSnapshot:{
        system:'system',
        prompt:`prompt-${marker}`,
        requestOnlyMarker:`REQUEST-RAW-${marker}`,
      },
      responseSnapshot:{ text:`response-${marker}` },
      rawResponse:{ rawOnlyMarker:`PROVIDER-RAW-${marker}` },
      requestId:`request-${itemId}`,
      modelSnapshot:'gemini-test',
      finishReason:'STOP',
      inputTokens:10,
      outputTokens:20,
      latencyMs:30,
      error:null,
      startedAt:'2026-07-30T00:00:00.000Z',
      completedAt:'2026-07-30T00:00:01.000Z',
    }],
    pagination:{ limit:20, offset:0, total:1, nextOffset:null },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('generation keeps raw audit data only for the explicitly requested item', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const activity = {
    batch:{
      id:'batch-memory',
      state:'FAILED',
      requested_count:2,
      conditions:{ executionMode:'parallel' },
      progress:{ completedQuestions:0, failedQuestions:2 },
    },
    job:null,
    eventCursor:'0',
    events:[],
    questions:[],
    items:[
      generationItem('item-a', 1),
      generationItem('item-b', 2),
    ],
    canResume:true,
  };
  const fetchMock = vi.fn(async (input:RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/generation/batch-memory/activity') {
      return { ok:true, json:async () => activity };
    }
    if (url.includes('/items/item-a/audit')) {
      return { ok:true, json:async () => auditPage('item-a', 'RAW-A') };
    }
    if (url.includes('/items/item-b/audit')) {
      return { ok:true, json:async () => auditPage('item-b', 'RAW-B') };
    }
    return { ok:true, json:async () => ({ items:[] }) };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<GenerationWorkspace sources={[]} batches={[{
    id:'batch-memory',
    state:'FAILED',
    requested_count:2,
    created_at:'2026-07-30T00:00:00.000Z',
  }]} />);

  await screen.findByText('1번 문항');
  const firstItem = screen.getByText('1번 문항').closest('details');
  expect(firstItem).not.toBeNull();
  fireEvent(firstItem!, new Event('toggle'));
  await Promise.resolve();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/audit'))).toBe(false);

  const auditButtons = screen.getAllByRole('button', {
    name:'상세 감사 기록 불러오기',
  });
  fireEvent.click(auditButtons[0]!);
  expect(await screen.findByText('실제 질문 생성 프롬프트')).toBeInTheDocument();
  expect(screen.queryByText('prompt-RAW-A')).not.toBeInTheDocument();
  expect(screen.queryByText('response-RAW-A')).not.toBeInTheDocument();
  expect(screen.queryByText(/RETRIEVAL-RAW-RAW-A/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByText('검색 감사 상세'));
  expect(await screen.findByText('chunk-content-RAW-A')).toBeInTheDocument();
  expect(screen.queryByText(/RETRIEVAL-RAW-RAW-A/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('검색 감사 원본'));
  expect(await screen.findByText(/RETRIEVAL-RAW-RAW-A/)).toBeInTheDocument();

  fireEvent.click(screen.getByText('실제 질문 생성 프롬프트'));
  expect(await screen.findByText('response-RAW-A')).toBeInTheDocument();
  expect(screen.getByText('prompt-RAW-A')).toBeInTheDocument();
  expect(screen.queryByText(/REQUEST-RAW-RAW-A/)).not.toBeInTheDocument();
  expect(screen.queryByText(/PROVIDER-RAW-RAW-A/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('전체 요청 스냅샷'));
  expect(await screen.findByText(/REQUEST-RAW-RAW-A/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Provider 원시 응답'));
  expect(await screen.findByText(/PROVIDER-RAW-RAW-A/)).toBeInTheDocument();

  fireEvent.click(within(firstItem!).getByText('방향성'));
  expect(screen.queryByText(/DIRECTION-RAW-1/)).not.toBeInTheDocument();
  fireEvent.click(within(firstItem!).getByText('원본 방향성 기록'));
  expect(await screen.findByText(/DIRECTION-RAW-1/)).toBeInTheDocument();

  fireEvent.click(auditButtons[1]!);
  expect(await screen.findByText('실제 질문 생성 프롬프트')).toBeInTheDocument();
  expect(screen.queryByText('response-RAW-B')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('실제 질문 생성 프롬프트'));
  expect(await screen.findByText('response-RAW-B')).toBeInTheDocument();
  expect(screen.queryByText('response-RAW-A')).not.toBeInTheDocument();
});

test('closing a generation item aborts, evicts, and rejects its late audit response', async () => {
  vi.stubGlobal('EventSource', EventSourceStub);
  const activity = {
    batch:{
      id:'batch-memory',
      state:'RUNNING',
      requested_count:1,
      conditions:{ executionMode:'parallel' },
      progress:{ completedQuestions:0, failedQuestions:0 },
    },
    job:null,
    eventCursor:'0',
    events:[],
    questions:[],
    items:[generationItem('item-a', 1, 'RUNNING')],
    canResume:false,
  };
  let resolveStale!: (value:{
    ok:boolean;
    json:() => Promise<ReturnType<typeof auditPage>>;
  }) => void;
  const staleResponse = new Promise<{
    ok:boolean;
    json:() => Promise<ReturnType<typeof auditPage>>;
  }>((resolve) => {
    resolveStale = resolve;
  });
  let auditCalls = 0;
  const fetchMock = vi.fn(async (
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    const url = String(input);
    if (url === '/api/generation/batch-memory/activity') {
      return { ok:true, json:async () => activity };
    }
    if (url.includes('/items/item-a/audit')) {
      auditCalls += 1;
      if (auditCalls === 1) return staleResponse;
      return { ok:true, json:async () => auditPage('item-a', 'FRESH') };
    }
    void init;
    return { ok:true, json:async () => ({ items:[] }) };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<GenerationWorkspace sources={[]} batches={[{
    id:'batch-memory',
    state:'RUNNING',
    requested_count:1,
    created_at:'2026-07-30T00:00:00.000Z',
  }]} />);

  await screen.findByText('1번 문항');
  const item = screen.getByText('1번 문항').closest('details')!;
  item.open = true;
  fireEvent(item, new Event('toggle'));
  await waitFor(() => expect(auditCalls).toBe(1));
  const auditCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('/items/item-a/audit'),
  )!;
  const signal = auditCall[1]?.signal as AbortSignal;

  item.open = false;
  fireEvent(item, new Event('toggle'));
  expect(signal.aborted).toBe(true);

  await act(async () => {
    resolveStale({
      ok:true,
      json:async () => auditPage('item-a', 'STALE'),
    });
    await Promise.resolve();
  });
  expect(screen.queryByText('실제 질문 생성 프롬프트')).not.toBeInTheDocument();

  item.open = true;
  fireEvent(item, new Event('toggle'));
  await waitFor(() => expect(auditCalls).toBe(2));
  const invocation = await screen.findByText('실제 질문 생성 프롬프트');
  fireEvent.click(invocation);
  expect(await screen.findByText('prompt-FRESH')).toBeInTheDocument();
  expect(screen.queryByText('prompt-STALE')).not.toBeInTheDocument();
});
