import { expect, test, vi } from 'vitest';
import { parseEventCursor } from '@/domain/event-cursor';
import {
  createControlRoomEventResponse,
  mapControlRoomEventRow,
} from '@/server/research/control-room-events';

test('maps a job lifecycle event to its source aggregate without losing the raw payload', () => {
  const payload = {
    pageNumber: 7,
    completedPages: 7,
    totalPages: 173,
  };

  expect(mapControlRoomEventRow({
    id: parseEventCursor('9007199254740993')!,
    aggregate_type: 'job',
    aggregate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    event_type: 'DOCUMENT_PAGE_PARSE_STARTED',
    payload,
    created_at: new Date('2026-07-27T00:00:00.000Z'),
    job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    job_kind: 'document.parse',
    job_payload: {
      sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    label: '통합과학.pdf',
  })).toEqual({
    id: '9007199254740993',
    aggregateType: 'source',
    aggregateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    eventType: 'DOCUMENT_PAGE_PARSE_STARTED',
    stage: 'PARSING',
    state: 'RUNNING',
    summary: '통합과학.pdf · Document Page Parse Started',
    payload,
    createdAt: '2026-07-27T00:00:00.000Z',
  });
});

test('maps a direct scoring failure to a failed benchmark scoring event', () => {
  expect(mapControlRoomEventRow({
    id: parseEventCursor('44')!,
    aggregate_type: 'benchmark_run',
    aggregate_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    event_type: 'RUN_SCORING_FAILED',
    payload: {
      code: 'JUDGE_TIMEOUT',
      message: 'Judge 응답 시간이 초과되었습니다.',
    },
    created_at: new Date('2026-07-27T01:00:00.000Z'),
    job_id: null,
    job_kind: null,
    job_payload: null,
    label: '선수관계 벤치마크',
  })).toEqual({
    id: '44',
    aggregateType: 'benchmark_run',
    aggregateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    eventType: 'RUN_SCORING_FAILED',
    stage: 'SCORING',
    state: 'FAILED',
    summary: '선수관계 벤치마크 · Judge 응답 시간이 초과되었습니다.',
    payload: {
      code: 'JUDGE_TIMEOUT',
      message: 'Judge 응답 시간이 초과되었습니다.',
    },
    createdAt: '2026-07-27T01:00:00.000Z',
  });
});

test('redacts legacy retrieval chunk bodies from global research events', () => {
  const event = mapControlRoomEventRow({
    id:parseEventCursor('45')!,
    aggregate_type:'job',
    aggregate_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    event_type:'QUESTION_RETRIEVAL_COMPLETED',
    payload:{
      ordinal:1,
      selectedChunks:[{
        chunkId:'chunk-1',
        rank:1,
        content:'교과서 전체 본문이 관제 SSE에 노출되면 안 됩니다.',
      }],
    },
    created_at:new Date('2026-07-27T01:00:00.000Z'),
    job_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    job_kind:'question.generate',
    job_payload:{ batchId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    label:null,
  });

  expect(event.aggregateType).toBe('generation');
  expect(JSON.stringify(event.payload)).not.toContain('교과서 전체 본문');
  expect(event.payload).toMatchObject({
    selectedChunkIds:['chunk-1'],
    chunks:[{ chunkId:'chunk-1', rank:1 }],
  });
});

test('multiplexes global events after the greater resume cursor and emits heartbeats', async () => {
  const abort = new AbortController();
  let reads = 0;
  const readEvents = vi.fn(async () => {
    reads += 1;
    if (reads === 1) {
      return [{
        id: parseEventCursor('9223372036854775807')!,
        aggregateType: 'generation',
        aggregateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        eventType: 'QUESTION_GENERATION_COMPLETED',
        stage: 'QUESTION_GENERATION',
        state: 'SUCCEEDED',
        summary: 'Question Generation Completed',
        payload: { ordinal: 3 },
        createdAt: '2026-07-27T02:00:00.000Z',
      }];
    }
    abort.abort();
    return [];
  });
  const response = createControlRoomEventResponse(new Request(
    'http://localhost/api/research/control-room/events?after=9007199254740993',
    {
      headers: { 'Last-Event-ID': '9007199254740994' },
      signal: abort.signal,
    },
  ), {
    readEvents,
    pollIntervalMs: 1,
    heartbeatIntervalMs: 0,
  });
  const body = await response.text();

  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(readEvents).toHaveBeenCalledWith('9007199254740994', 200);
  expect(body).toContain('retry: 2000\n\n');
  expect(body).toContain('id: 9223372036854775807\n');
  expect(body).toContain('event: control-room\n');
  expect(body).toContain('"aggregateType":"generation"');
  expect(body).toContain(': heartbeat ');
});

test('stops global event polling when the response body is cancelled', async () => {
  let releaseRead!: () => void;
  const blockedRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readEvents = vi.fn(async () => {
    await blockedRead;
    return [];
  });
  const response = createControlRoomEventResponse(
    new Request('http://localhost/api/research/control-room/events'),
    { readEvents, pollIntervalMs: 1 },
  );
  const reader = response.body!.getReader();

  await reader.read();
  await reader.cancel();
  releaseRead();
  await new Promise((resolve) => setTimeout(resolve, 15));

  expect(readEvents).toHaveBeenCalledTimes(1);
});
