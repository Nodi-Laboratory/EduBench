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
import { RunController } from '@/components/runs/run-controller';

class RealtimeEventSourceStub {
  static instances: RealtimeEventSourceStub[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor() {
    RealtimeEventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emitActivity(id: string, eventType: string) {
    for (const listener of this.listeners.get('activity') ?? []) {
      listener(new MessageEvent('activity', {
        data: JSON.stringify({
          id,
          aggregate: 'benchmark_run',
          aggregateId: 'run-audit',
          eventType,
          payload: {},
          createdAt: '2026-07-26T00:00:01.000Z',
        }),
        lastEventId: id,
      }));
    }
  }
}

afterEach(() => {
  cleanup();
  RealtimeEventSourceStub.instances = [];
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const baseRun = {
  id:'run-audit',
  public_id:'RUN-AUDIT',
  title:'채점 감사 실행',
  state:'SCORING',
  total_items:1,
  completed_items:1,
  failed_items:0,
  dataset_version:'dataset-v1',
  score_version:'score-v1',
  price_profile_version:'price-v1',
  created_at:'2026-07-26T00:00:00Z',
};

const baseProfile = {
  version:'score-v1',
  title:'선수관계 평가',
  metrics:['accuracy'],
  rubricPrompt:'교과서 근거로 평가한다.',
  judgeProvider:'gemini',
  judgeModel:'gemini-judge',
  contentHash:'profile-hash',
  dynamicMetrics:[],
  snapshotProvenance:'AT_CREATION_VERIFIED',
};

const models = [{
  id:'model-1',
  provider_key:'gemini',
  display_name:'Gemini',
  blind_id:'M01',
  model_id:'gemini-candidate',
  protocol:'gemini',
  concurrency:1,
}];

function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function summaryItem(
  id:string,
  questionText:string,
  state = 'SUCCEEDED',
  retrievalMode:'LEGACY_EVIDENCE' | 'NONE' | 'VECTOR' | 'PIKE'
    = 'LEGACY_EVIDENCE',
) {
  return {
    id,
    runModelId:'model-1',
    state,
    attempts:1,
    maxAttempts:4,
    errorCode:null,
    errorMessage:null,
    questionPublicId:`Q-${id}`,
    questionText,
    providerKey:'gemini',
    displayName:'Gemini',
    modelId:'gemini-candidate',
    blindId:'M01',
    retrievalMode,
    hasResponse:true,
  };
}

function overviewPage(
  item:ReturnType<typeof summaryItem>,
  page:number,
  totalPages = 2,
) {
  return {
    ok:true,
    json:async () => ({
      run:baseRun,
      items:[item],
      providerCooldowns:[],
      counters:{
        itemTotal:51,
        scoreEligibleItems:1,
        requiredScorePairs:1,
        scoredPairs:0,
      },
      itemPagination:{
        page,
        pageSize:50,
        total:51,
        totalPages,
      },
      itemFilters:{ runModelId:null, state:null, retrievalMode:null },
      itemFilterOptions:{
        models:models.map((model) => ({
          runModelId:model.id,
          providerKey:model.provider_key,
          displayName:model.display_name,
          blindId:model.blind_id,
          modelId:model.model_id,
        })),
        states:['FAILED', 'SUCCEEDED'],
        retrievalModes:['LEGACY_EVIDENCE', 'NONE'],
      },
    }),
  };
}

function itemDetailResponse(
  item:ReturnType<typeof summaryItem>,
  questionText = item.questionText,
) {
  return {
    ok:true,
    json:async () => ({
      runId:'run-audit',
      item:{
        ...item,
        questionText,
        retrieval:null,
        request:null,
        response:null,
        requiredMetricKeys:[],
        scores:[],
        judgeInvocations:[],
      },
      judgePagination:{ limit:20, offset:0, total:0, nextOffset:null },
    }),
  };
}

test('renders the pinned scoring engine and expandable Judge invocation evidence without replacing payloads with addresses', async () => {
  class EventSourceStub {
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', EventSourceStub);

  render(<RunController
    initialRun={baseRun}
    models={models}
    profile={baseProfile}
    scoringEngine={{
      id:'engine-1',
      version:'edubench-scoring-v1',
      title:'EduBench 선수관계 평가 엔진 v1',
      definition:{
        deterministic:{ exactMatch:{ implementationVersion:'normalize-korean-answer-v1' } },
        judge:{ systemPrompt:'EDUBENCH_JUDGE_JSON', sampling:{ maxOutputTokens:8192 } },
        lazyMarker:'ENGINE-DEFINITION-RAW',
      },
      contentHash:'a'.repeat(64),
      snapshotProvenance:'AT_CREATION_VERIFIED',
      verified:true,
    }}
    initialItems={[{
      id:'item-1',
      state:'SUCCEEDED',
      attempts:1,
      errorCode:null,
      errorMessage:null,
      questionPublicId:'Q-1',
      questionText:'선수 개념을 적용하라.',
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-candidate',
      blindId:'M01',
      request:{ system:'candidate system', prompt:'candidate prompt' },
      response:{
        text:'후보 답변',
        raw:{ candidate:'raw' },
        requestId:'candidate-request',
        retryHistory:[],
      },
      scores:[],
      judgeInvocations:[{
        id:'invocation-parsed',
        parentInvocationId:null,
        invocationKind:'PRIMARY',
        attempt:1,
        logicalKey:'accuracy',
        state:'PARSED',
        requestedMetricKeys:['accuracy'],
        resolvedMetricKeys:['accuracy'],
        missingMetricKeys:[],
        requestSnapshot:{ system:'judge system', prompt:'judge request body' },
        requestHash:'b'.repeat(64),
        providerKey:'gemini',
        modelId:'gemini-judge',
        providerRequestId:'judge-request-1',
        responseModelId:'gemini-judge',
        responseModelSnapshot:'gemini-judge-2026-07',
        finishReason:'STOP',
        inputTokens:20,
        outputTokens:10,
        latencyMs:42,
        rawResponse:{ providerPayload:{ answer:'raw judge payload' } },
        responseText:'{"scores":[{"metricKey":"accuracy","value":1}]}',
        parsedResponse:{ scores:[{ metricKey:'accuracy', value:1 }] },
        errorCode:null,
        errorMessage:null,
        errorStage:null,
        requestedAt:'2026-07-26T00:00:01Z',
        responseReceivedAt:'2026-07-26T00:00:02Z',
        parsedAt:'2026-07-26T00:00:03Z',
        persistedAt:null,
        failedAt:null,
        updatedAt:'2026-07-26T00:00:03Z',
      }, {
        id:'invocation-failed',
        parentInvocationId:null,
        invocationKind:'PRIMARY',
        attempt:2,
        logicalKey:'faithfulness',
        state:'FAILED',
        requestedMetricKeys:['faithfulness'],
        resolvedMetricKeys:[],
        missingMetricKeys:[],
        requestSnapshot:{ system:'judge system', prompt:'failed request body' },
        requestHash:'c'.repeat(64),
        providerKey:'gemini',
        modelId:'gemini-judge',
        providerRequestId:null,
        responseModelId:null,
        responseModelSnapshot:null,
        finishReason:null,
        inputTokens:null,
        outputTokens:null,
        latencyMs:null,
        rawResponse:null,
        responseText:null,
        parsedResponse:null,
        errorCode:'JUDGE_TIMEOUT',
        errorMessage:'Judge 응답 제한 시간을 초과했습니다.',
        errorStage:'PROVIDER',
        requestedAt:'2026-07-26T00:00:04Z',
        responseReceivedAt:null,
        parsedAt:null,
        persistedAt:null,
        failedAt:'2026-07-26T00:00:05Z',
        updatedAt:'2026-07-26T00:00:05Z',
      }],
    }]}
  />);

  expect(screen.getByRole('heading', { name:'채점 엔진' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name:'채점 일시정지' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name:'채점 중지' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name:'영구 취소' })).toBeInTheDocument();
  expect(screen.getByText('EduBench 선수관계 평가 엔진 v1')).toBeInTheDocument();
  expect(screen.getByText(/내용 해시 a{64}/)).toBeInTheDocument();
  expect(screen.queryByText(/ENGINE-DEFINITION-RAW/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('엔진 정의 전체 보기'));
  expect(await screen.findByText(/ENGINE-DEFINITION-RAW/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Q-1'));
  expect(screen.getByText('Judge 호출 2건')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Judge 호출 2건'));
  expect(await screen.findByText(/PRIMARY · PARSED/)).toBeInTheDocument();
  expect(screen.getByText(/PRIMARY · FAILED/)).toBeInTheDocument();
  expect(screen.queryByText(/raw judge payload/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByText(/PRIMARY · PARSED/));
  expect(await screen.findByText(/호출 invocation-parsed/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('원본 Judge 응답'));
  expect(await screen.findByText(/judge-request-1/)).toBeInTheDocument();
  expect(await screen.findByText(/raw judge payload/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('파싱 결과'));
  expect(await screen.findByText(/"metricKey": "accuracy"/)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/PRIMARY · FAILED/));
  expect(await screen.findByText('JUDGE_TIMEOUT')).toBeInTheDocument();
  expect(screen.getByText('Judge 응답 제한 시간을 초과했습니다.')).toBeInTheDocument();
  expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
});

test('marks missing legacy scoring-engine provenance as unverified instead of inferring an engine', () => {
  render(<RunController
    initialRun={{ ...baseRun, id:'legacy-run', public_id:'LEGACY-RUN' }}
    models={models}
    profile={baseProfile}
    scoringEngine={{
      id:null,
      version:null,
      title:null,
      definition:null,
      contentHash:null,
      snapshotProvenance:'LEGACY_BACKFILL_UNVERIFIED',
      verified:false,
    }}
    initialItems={[]}
  />);

  expect(screen.getByText(/채점 엔진 출처를 검증할 수 없습니다/)).toBeInTheDocument();
  expect(screen.getByText(/기존 실행의 엔진 정의를 추정하거나 복원하지 않습니다/)).toBeInTheDocument();
  expect(screen.queryByText('EduBench 선수관계 평가 엔진 v1')).not.toBeInTheDocument();
});

test('loads a run item audit on expand without serializing nested raw response data', async () => {
  const fetchMock = vi.fn(async () => ({
    ok:true,
    json:async () => ({
      runId:'run-audit',
      item:{
        id:'item-lazy',
        state:'SUCCEEDED',
        attempts:1,
        maxAttempts:4,
        errorCode:null,
        errorMessage:null,
        questionPublicId:'Q-LAZY',
        questionText:'지연 상세 질문',
        providerKey:'gemini',
        displayName:'Gemini',
        modelId:'gemini-candidate',
        blindId:'M01',
        retrievalMode:'NONE',
        retrieval:null,
        request:{ system:'candidate system', prompt:'candidate prompt' },
        response:{
          text:'지연 후보 답변',
          raw:{ secretPayload:'raw only after expand' },
          requestId:'candidate-request',
          retryHistory:[],
        },
        requiredMetricKeys:['accuracy'],
        scores:[],
        judgeInvocations:[],
      },
      judgePagination:{
        limit:20,
        offset:0,
        total:0,
        nextOffset:null,
      },
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={baseRun}
    models={models}
    profile={baseProfile}
    initialItems={[{
      id:'item-lazy',
      state:'SUCCEEDED',
      attempts:1,
      maxAttempts:4,
      errorCode:null,
      errorMessage:null,
      questionPublicId:'Q-LAZY',
      questionText:'지연 상세 질문',
      providerKey:'gemini',
      displayName:'Gemini',
      modelId:'gemini-candidate',
      blindId:'M01',
      retrievalMode:'NONE',
      hasResponse:true,
    }]}
  />);

  expect(screen.queryByText(/raw only after expand/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/M01 · Gemini/));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/runs/run-audit/items/item-lazy/details?judgeLimit=20&judgeOffset=0',
    expect.objectContaining({ cache:'no-store' }),
  ));
  await screen.findByText('원본 응답·재시도 기록');
  expect(screen.queryByText(/raw only after expand/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('원본 응답·재시도 기록'));
  expect(await screen.findByText(/raw only after expand/)).toBeInTheDocument();
});

test('switching and closing run item details aborts stale requests and evicts prior audits', async () => {
  const firstItem = summaryItem('item-a', '첫 요약 문항');
  const secondItem = summaryItem('item-b', '둘째 요약 문항');
  const firstRequest = deferred<ReturnType<typeof itemDetailResponse>>();
  const secondRequest = deferred<ReturnType<typeof itemDetailResponse>>();
  let secondItemCalls = 0;
  const fetchMock = vi.fn((
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    const url = String(input);
    if (url.includes('/items/item-a/details')) return firstRequest.promise;
    if (url.includes('/items/item-b/details')) {
      secondItemCalls += 1;
      return secondItemCalls === 1
        ? secondRequest.promise
        : Promise.resolve(itemDetailResponse(secondItem, 'FRESH-B-DETAIL'));
    }
    void init;
    return Promise.resolve(overviewPage(firstItem, 1, 1));
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={{ ...baseRun, total_items:2, completed_items:2 }}
    models={models}
    profile={baseProfile}
    initialItems={[firstItem, secondItem]}
  />);

  fireEvent.click(screen.getByText('Q-item-a'));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('/items/item-a/details'),
  )).toBe(true));
  const firstCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('/items/item-a/details'),
  )!;
  const firstSignal = firstCall[1]?.signal as AbortSignal | undefined;
  expect(firstSignal).toBeInstanceOf(AbortSignal);

  fireEvent.click(screen.getByText('Q-item-b'));
  await waitFor(() => expect(secondItemCalls).toBe(1));
  expect(firstSignal?.aborted).toBe(true);
  const secondCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('/items/item-b/details'),
  )!;
  const secondSignal = secondCall[1]?.signal as AbortSignal | undefined;
  expect(secondSignal).toBeInstanceOf(AbortSignal);

  fireEvent.click(screen.getByText('Q-item-b'));
  await waitFor(() => expect(secondSignal?.aborted).toBe(true));

  await act(async () => {
    firstRequest.resolve(itemDetailResponse(firstItem, 'STALE-A-DETAIL'));
    secondRequest.resolve(itemDetailResponse(secondItem, 'STALE-B-DETAIL'));
    await Promise.resolve();
  });
  expect(screen.queryByText('STALE-A-DETAIL')).not.toBeInTheDocument();
  expect(screen.queryByText('STALE-B-DETAIL')).not.toBeInTheDocument();

  fireEvent.click(screen.getByText('Q-item-b'));
  expect(await screen.findByText('FRESH-B-DETAIL')).toBeInTheDocument();
  expect(secondItemCalls).toBe(2);
});

test('changing a run filter aborts the active item detail request', async () => {
  const item = summaryItem('filter-abort', '필터 전 문항');
  const detailRequest = deferred<ReturnType<typeof itemDetailResponse>>();
  const fetchMock = vi.fn((
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    const url = String(input);
    if (url.includes('/items/filter-abort/details')) return detailRequest.promise;
    void init;
    return Promise.resolve(overviewPage(
      summaryItem('filtered-result', '필터 후 문항', 'FAILED'),
      1,
      1,
    ));
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={baseRun}
    models={models}
    profile={baseProfile}
    initialItems={[item]}
    initialItemFilterOptions={{
      states:['FAILED', 'SUCCEEDED'],
      retrievalModes:['LEGACY_EVIDENCE'],
    }}
  />);

  fireEvent.click(screen.getByText('Q-filter-abort'));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('/items/filter-abort/details'),
  )).toBe(true));
  const detailCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('/items/filter-abort/details'),
  )!;
  const detailSignal = detailCall[1]?.signal as AbortSignal | undefined;
  expect(detailSignal).toBeInstanceOf(AbortSignal);

  fireEvent.change(screen.getByLabelText('상태'), {
    target:{ value:'FAILED' },
  });
  await waitFor(() => expect(detailSignal?.aborted).toBe(true));
});

test('unmounting the run controller aborts the active item detail request', async () => {
  const item = summaryItem('unmount-abort', '언마운트 전 문항');
  const detailRequest = deferred<ReturnType<typeof itemDetailResponse>>();
  const fetchMock = vi.fn((
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    void init;
    if (String(input).includes('/items/unmount-abort/details')) {
      return detailRequest.promise;
    }
    return Promise.resolve(overviewPage(item, 1, 1));
  });
  vi.stubGlobal('fetch', fetchMock);

  const { unmount } = render(<RunController
    initialRun={baseRun}
    models={models}
    profile={baseProfile}
    initialItems={[item]}
  />);
  fireEvent.click(screen.getByText('Q-unmount-abort'));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('/items/unmount-abort/details'),
  )).toBe(true));
  const detailCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('/items/unmount-abort/details'),
  )!;
  const detailSignal = detailCall[1]?.signal as AbortSignal | undefined;
  expect(detailSignal).toBeInstanceOf(AbortSignal);

  unmount();
  expect(detailSignal?.aborted).toBe(true);
});

test('uses run-wide filter options and resets server pagination when filters change', async () => {
  const filteredItem = summaryItem(
    'filtered',
    '서버 필터 결과',
    'FAILED',
    'NONE',
  );
  const fetchMock = vi.fn(async (input:RequestInfo | URL) => {
    void input;
    return {
      ...overviewPage(filteredItem, 1, 1),
      json:async () => ({
        ...(await overviewPage(filteredItem, 1, 1).json()),
        itemPagination:{ page:1, pageSize:50, total:1, totalPages:1 },
        itemFilters:{ state:'FAILED', retrievalMode:'NONE' },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={{ ...baseRun, total_items:51 }}
    models={models}
    profile={baseProfile}
    initialItems={[summaryItem('page-two', '현재 페이지 성공 항목')]}
    initialItemPagination={{ page:2, pageSize:50, total:51, totalPages:2 }}
    initialCounters={{
      itemTotal:51,
      scoreEligibleItems:1,
      requiredScorePairs:1,
      scoredPairs:0,
    }}
    initialItemFilters={{ state:null, retrievalMode:null }}
    initialItemFilterOptions={{
      states:['FAILED', 'SUCCEEDED'],
      retrievalModes:['LEGACY_EVIDENCE', 'NONE'],
    }}
  />);

  expect(screen.getByRole('option', { name:'FAILED' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name:'일반' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('상태'), {
    target:{ value:'FAILED' },
  });
  fireEvent.change(screen.getByLabelText('검색 조건'), {
    target:{ value:'NONE' },
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
  expect(lastUrl).toContain('page=1');
  expect(lastUrl).toContain('state=FAILED');
  expect(lastUrl).toContain('retrievalMode=NONE');
  expect(await screen.findByText('Q-filtered')).toBeInTheDocument();
});

test('resets server pagination and sends a stable run model id when the model changes', async () => {
  const secondModel = {
    id:'model-2',
    provider_key:'openai',
    display_name:'OpenAI',
    blind_id:'M02',
    model_id:'openai-candidate',
    protocol:'openai-responses',
    concurrency:1,
  };
  const targetItem = {
    ...summaryItem('target-model', '다음 페이지 모델 항목'),
    runModelId:secondModel.id,
    providerKey:secondModel.provider_key,
    displayName:secondModel.display_name,
    modelId:secondModel.model_id,
    blindId:secondModel.blind_id,
  };
  const fetchMock = vi.fn(async (input:RequestInfo | URL) => {
    void input;
    return {
      ...overviewPage(targetItem, 1, 1),
      json:async () => ({
        ...(await overviewPage(targetItem, 1, 1).json()),
        itemPagination:{ page:1, pageSize:50, total:1, totalPages:1 },
        itemFilters:{
          runModelId:secondModel.id,
          state:null,
          retrievalMode:null,
        },
        itemFilterOptions:{
          models:[...models, secondModel].map((model) => ({
            runModelId:model.id,
            providerKey:model.provider_key,
            displayName:model.display_name,
            blindId:model.blind_id,
            modelId:model.model_id,
          })),
          states:['SUCCEEDED'],
          retrievalModes:['LEGACY_EVIDENCE'],
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={{ ...baseRun, total_items:51 }}
    models={[...models, secondModel]}
    profile={baseProfile}
    initialItems={[summaryItem('page-two', '현재 페이지 모델 항목')]}
    initialItemPagination={{ page:2, pageSize:50, total:51, totalPages:2 }}
    initialCounters={{
      itemTotal:51,
      scoreEligibleItems:1,
      requiredScorePairs:1,
      scoredPairs:0,
    }}
    initialItemFilters={{
      runModelId:null,
      state:null,
      retrievalMode:null,
    }}
    initialItemFilterOptions={{
      models:[...models, secondModel].map((model) => ({
        runModelId:model.id,
        providerKey:model.provider_key,
        displayName:model.display_name,
        blindId:model.blind_id,
        modelId:model.model_id,
      })),
      states:['SUCCEEDED'],
      retrievalModes:['LEGACY_EVIDENCE'],
    }}
  />);

  fireEvent.change(screen.getByLabelText('모델'), {
    target:{ value:secondModel.id },
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const requestUrl = String(fetchMock.mock.calls[0]![0]);
  expect(requestUrl).toContain('page=1');
  expect(requestUrl).toContain(`runModelId=${secondModel.id}`);
  expect(await screen.findByText('Q-target-model')).toBeInTheDocument();
});

test('keeps the newest page snapshot when an SSE refresh overlaps navigation', async () => {
  vi.stubGlobal('EventSource', RealtimeEventSourceStub);
  const requests = [
    deferred<ReturnType<typeof overviewPage>>(),
    deferred<ReturnType<typeof overviewPage>>(),
  ];
  const fetchMock = vi.fn((input:RequestInfo | URL) => {
    void input;
    return requests[fetchMock.mock.calls.length - 1]!.promise;
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={{ ...baseRun, total_items:51 }}
    models={models}
    profile={baseProfile}
    initialItems={[summaryItem('initial', '첫 페이지 초기 항목')]}
    initialItemPagination={{ page:1, pageSize:50, total:51, totalPages:2 }}
    initialCounters={{
      itemTotal:51,
      scoreEligibleItems:1,
      requiredScorePairs:1,
      scoredPairs:0,
    }}
    initialEventCursor="80"
  />);
  await waitFor(() => expect(RealtimeEventSourceStub.instances).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name:'다음 페이지' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    RealtimeEventSourceStub.instances[0]!.emitActivity('81', 'RUN_ITEM_COMPLETED');
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.every(
    ([url]) => String(url).includes('page=2'),
  )).toBe(true);

  await act(async () => {
    requests[1]!.resolve(overviewPage(
      summaryItem('newer', '최신 두 번째 페이지'),
      2,
    ));
    await Promise.resolve();
  });
  expect(await screen.findByText('Q-newer')).toBeInTheDocument();

  await act(async () => {
    requests[0]!.resolve(overviewPage(
      summaryItem('stale', '오래된 두 번째 페이지'),
      2,
    ));
    await Promise.resolve();
  });
  expect(screen.getByText('Q-newer')).toBeInTheDocument();
  expect(screen.queryByText('Q-stale')).not.toBeInTheDocument();
});

test('ignores a late item detail response after leaving its page', async () => {
  const lateDetail = deferred<{
    ok:boolean;
    json:() => Promise<Record<string, unknown>>;
  }>();
  let detailCalls = 0;
  let detailSignal:AbortSignal | undefined;
  const oldSummary = summaryItem('old-item', '이전 페이지 항목');
  const nextSummary = summaryItem('next-item', '다음 페이지 항목');
  const fetchMock = vi.fn((input:RequestInfo | URL, init?:RequestInit) => {
    const url = String(input);
    if (url.includes('/items/old-item/details')) {
      detailSignal = init?.signal as AbortSignal | undefined;
      detailCalls += 1;
      if (detailCalls === 1) return lateDetail.promise;
      return Promise.resolve({
        ok:true,
        json:async () => ({
          runId:'run-audit',
          item:{
            ...oldSummary,
            request:null,
            response:null,
            retrieval:null,
            scores:[],
            judgeInvocations:[],
          },
          judgePagination:{ limit:20, offset:0, total:0, nextOffset:null },
        }),
      });
    }
    if (url.includes('page=2')) {
      return Promise.resolve(overviewPage(nextSummary, 2));
    }
    return Promise.resolve(overviewPage(oldSummary, 1));
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={{ ...baseRun, total_items:51 }}
    models={models}
    profile={baseProfile}
    initialItems={[oldSummary]}
    initialItemPagination={{ page:1, pageSize:50, total:51, totalPages:2 }}
    initialCounters={{
      itemTotal:51,
      scoreEligibleItems:1,
      requiredScorePairs:1,
      scoredPairs:0,
    }}
  />);
  fireEvent.click(screen.getByText(/Q-old-item/));
  await waitFor(() => expect(detailCalls).toBe(1));
  fireEvent.click(screen.getByRole('button', { name:'다음 페이지' }));
  expect(detailSignal).toBeInstanceOf(AbortSignal);
  expect(detailSignal?.aborted).toBe(true);
  expect(await screen.findByText('Q-next-item')).toBeInTheDocument();

  await act(async () => {
    lateDetail.resolve({
      ok:true,
      json:async () => ({
        runId:'run-audit',
        item:{
          ...oldSummary,
          request:null,
          response:{
            text:'늦게 도착한 원시 응답',
            raw:{ stale:true },
            requestId:null,
            retryHistory:[],
          },
          retrieval:null,
          scores:[],
          judgeInvocations:[],
        },
        judgePagination:{ limit:20, offset:0, total:0, nextOffset:null },
      }),
    });
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole('button', { name:'이전 페이지' }));
  expect(await screen.findByText('Q-old-item')).toBeInTheDocument();
  fireEvent.click(screen.getByText(/Q-old-item/));
  await waitFor(() => expect(detailCalls).toBe(2));
  expect(screen.queryByText('늦게 도착한 원시 응답')).not.toBeInTheDocument();
});

test('retries a failed final-event detail request and applies the terminal run snapshot', async () => {
  vi.stubGlobal('EventSource', RealtimeEventSourceStub);
  const completedRun = {
    ...baseRun,
    state: 'COMPLETED',
    completed_items: 1,
  };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ code: 'TEMPORARY_FAILURE' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        run: completedRun,
        items: [],
        scoringEngine: {
          id: 'engine-1',
          version: 'edubench-scoring-v1',
          title: 'EduBench 선수관계 평가 엔진 v1',
          definition: {},
          contentHash: 'a'.repeat(64),
          snapshotProvenance: 'AT_CREATION_VERIFIED',
          verified: true,
        },
      }),
    });
  vi.stubGlobal('fetch', fetchMock);

  render(<RunController
    initialRun={baseRun}
    models={models}
    profile={baseProfile}
    initialItems={[]}
    initialEventCursor="70"
  />);
  await waitFor(() => expect(RealtimeEventSourceStub.instances).toHaveLength(1));

  act(() => {
    RealtimeEventSourceStub.instances[0]!.emitActivity('71', 'RUN_COMPLETED');
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
});
