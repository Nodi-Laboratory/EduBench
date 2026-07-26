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

test('renders the pinned scoring engine and expandable Judge invocation evidence without replacing payloads with addresses', () => {
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
  expect(screen.getByText('Judge 호출 2건')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Judge 호출 2건'));
  expect(screen.getByText(/PRIMARY · PARSED/)).toBeInTheDocument();
  expect(screen.getByText(/PRIMARY · FAILED/)).toBeInTheDocument();
  expect(screen.getByText(/judge-request-1/)).toBeInTheDocument();
  expect(screen.getByText('JUDGE_TIMEOUT')).toBeInTheDocument();
  expect(screen.getByText('Judge 응답 제한 시간을 초과했습니다.')).toBeInTheDocument();
  expect(screen.getByText(/raw judge payload/)).toBeInTheDocument();
  expect(screen.getByText(/"metricKey": "accuracy"/)).toBeInTheDocument();
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
