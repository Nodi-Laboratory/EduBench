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

const INVOCATION_BATCH_SIZE = 50;
const LARGE_INVOCATION_COUNT = INVOCATION_BATCH_SIZE + 1;
const LARGE_INVOCATION_PAYLOAD_SIZE = 8 * 1024;
const MAX_STREAM_CHUNK_SIZE = 16 * 1024;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const RESPONSE_ID = '10000000-0000-0000-0000-000000000001';
const REQUESTED_AT = '2026-07-30T00:00:00.000Z';

const mappedInvocationKeys = [
  'id',
  'benchmarkRunId',
  'runItemId',
  'modelResponseId',
  'scoreProfileId',
  'scoringEngineVersionId',
  'parentInvocationId',
  'invocationKind',
  'attempt',
  'logicalKey',
  'idempotencyKey',
  'state',
  'requestedMetricKeys',
  'resolvedMetricKeys',
  'missingMetricKeys',
  'requestSnapshot',
  'requestHash',
  'providerKey',
  'modelId',
  'providerRequestId',
  'responseModelId',
  'responseModelSnapshot',
  'finishReason',
  'inputTokens',
  'outputTokens',
  'latencyMs',
  'rawResponse',
  'responseText',
  'parsedResponse',
  'errorCode',
  'errorMessage',
  'errorStage',
  'requestedAt',
  'responseReceivedAt',
  'parsedAt',
  'persistedAt',
  'failedAt',
  'updatedAt',
];

function invocationId(ordinal:number):string {
  return `20000000-0000-0000-0000-${
    String(ordinal).padStart(12, '0')
  }`;
}

function largeInvocationRows():Array<Record<string, unknown>> {
  return Array.from({ length:LARGE_INVOCATION_COUNT }, (_, index) => {
    const ordinal = index + 1;
    return {
      id:invocationId(ordinal),
      benchmark_run_id:'run-large-invocations',
      run_item_id:'item-large-invocations',
      model_response_id:RESPONSE_ID,
      score_profile_id:'30000000-0000-0000-0000-000000000001',
      scoring_engine_version_id:'40000000-0000-0000-0000-000000000001',
      parent_invocation_id:null,
      invocation_kind:'PRIMARY',
      attempt:ordinal,
      logical_key:`large-invocation-${ordinal}`,
      idempotency_key:`large-invocation-key-${ordinal}`,
      state:'PERSISTED',
      requested_metric_keys:['accuracy'],
      resolved_metric_keys:['accuracy'],
      missing_metric_keys:[],
      request_snapshot:{ ordinal },
      request_hash:String(ordinal).padStart(64, '0'),
      provider_key:'mock',
      model_id:'judge-model',
      provider_request_id:`judge-request-${ordinal}`,
      response_model_id:'judge-model',
      response_model_snapshot:'judge-model-snapshot',
      finish_reason:'stop',
      input_tokens:ordinal,
      output_tokens:ordinal + 1,
      latency_ms:ordinal + 2,
      raw_response:{
        payload:`LARGE_INVOCATION_${String(ordinal).padStart(3, '0')}_${
          'x'.repeat(LARGE_INVOCATION_PAYLOAD_SIZE)
        }`,
      },
      response_text:`judge response ${ordinal}`,
      parsed_response:{ ordinal },
      error_code:null,
      error_message:null,
      error_stage:null,
      requested_at:REQUESTED_AT,
      response_received_at:REQUESTED_AT,
      parsed_at:REQUESTED_AT,
      persisted_at:REQUESTED_AT,
      failed_at:null,
      updated_at:REQUESTED_AT,
    };
  });
}

type InvocationQueryRecord = {
  scope:'run' | 'response';
  sql:string;
  values:unknown[];
  rowCount:number;
};

function createLargeInvocationExportHarness() {
  const rows = largeInvocationRows();
  const release = vi.fn();
  const invocationQueries:InvocationQueryRecord[] = [];
  const transactionStatements:string[] = [];
  const pageAfter = (cursorId:unknown, limit:unknown) => {
    const normalizedCursor = typeof cursorId === 'string'
      ? cursorId
      : ZERO_UUID;
    const cursorIndex = normalizedCursor === ZERO_UUID
      ? -1
      : rows.findIndex((row) => row.id === normalizedCursor);
    return rows.slice(
      cursorIndex + 1,
      cursorIndex + 1 + Number(limit),
    );
  };
  const clientQuery = vi.fn(async (
    sql:string,
    values:unknown[] = [],
  ) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if ([
      'begin isolation level repeatable read read only',
      'commit',
      'rollback',
    ].includes(normalized)) {
      transactionStatements.push(normalized);
      return { rows:[] };
    }
    if (normalized.includes('from benchmark_runs br join dataset_versions')) {
      return {
        rows:[{
          id:'run-large-invocations',
          public_id:'RUN-LARGE-INVOCATIONS',
          scoring_engine_version_id:null,
          scoring_engine_snapshot:null,
          scoring_engine_snapshot_provenance:'LEGACY_BACKFILL_UNVERIFIED',
        }],
      };
    }
    if (
      normalized.includes(
        'where invocation.model_response_id=any($1::uuid[])',
      )
    ) {
      invocationQueries.push({
        scope:'response',
        sql:normalized,
        values,
        rowCount:rows.length,
      });
      return { rows };
    }
    if (
      normalized.includes('where invocation.model_response_id=$1')
    ) {
      const page = pageAfter(values[2], values[3]);
      invocationQueries.push({
        scope:'response',
        sql:normalized,
        values,
        rowCount:page.length,
      });
      return { rows:page };
    }
    if (
      normalized.includes('where invocation.benchmark_run_id=$1')
    ) {
      const page = pageAfter(values[3], values[4]);
      invocationQueries.push({
        scope:'run',
        sql:normalized,
        values,
        rowCount:page.length,
      });
      return { rows:page };
    }
    if (normalized.includes('from run_items ri join benchmark_runs')) {
      return {
        rows:[{
          run_item_id:'item-large-invocations',
          model_response_id:RESPONSE_ID,
          question_id:'Q-LARGE-INVOCATIONS',
          question_revision:1,
          retrieval_mode:'NONE',
          blind_id:'M01',
          state:'COMPLETED',
          scores:{},
        }],
      };
    }
    throw new Error(`Unexpected query: ${normalized}`);
  });
  database.connect.mockResolvedValue({
    query:clientQuery,
    release,
  });
  database.query.mockRejectedValue(new Error('AUTOCOMMIT_QUERY_USED'));
  return {
    clientQuery,
    invocationQueries,
    release,
    rows,
    transactionStatements,
  };
}

async function readResponseChunks(response:Response):Promise<{
  body:string;
  chunks:Array<{ byteLength:number; text:string }>;
}> {
  if (!response.body) throw new Error('Expected an export response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks:Array<{ byteLength:number; text:string }> = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push({
      byteLength:next.value.byteLength,
      text:decoder.decode(next.value, { stream:true }),
    });
  }
  const remainder = decoder.decode();
  if (remainder) chunks.push({ byteLength:0, text:remainder });
  return {
    body:chunks.map((chunk) => chunk.text).join(''),
    chunks,
  };
}

function expectBoundedInvocationChunks(
  chunks:Array<{ byteLength:number; text:string }>,
) {
  for (const chunk of chunks) {
    const markers = chunk.text.match(/LARGE_INVOCATION_\d{3}_/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(1);
    expect(chunk.byteLength).toBeLessThanOrEqual(MAX_STREAM_CHUNK_SIZE);
  }
}

function expectBoundedKeysetInvocationQueries(
  records:InvocationQueryRecord[],
) {
  expect(records.length).toBeGreaterThan(2);
  for (const record of records) {
    expect(record.sql).toMatch(/\blimit \$\d+\b/);
    expect(record.rowCount).toBeLessThanOrEqual(INVOCATION_BATCH_SIZE);
    if (record.scope === 'run') {
      expect(record.sql).toContain(
        '(invocation.requested_at,invocation.id) > '
          + '($3::timestamptz,$4::uuid)',
      );
      expect(record.values[4]).toBe(INVOCATION_BATCH_SIZE);
    } else {
      expect(record.sql).toContain(
        '(invocation.requested_at,invocation.id) > '
          + '($2::timestamptz,$3::uuid)',
      );
      expect(record.values[3]).toBe(INVOCATION_BATCH_SIZE);
    }
  }
  const responseRecords = records.filter(
    (record) => record.scope === 'response',
  );
  expect(responseRecords.some((record) => (
    record.values[1] === REQUESTED_AT
    && record.values[2] === invocationId(INVOCATION_BATCH_SIZE)
  ))).toBe(true);
}

function parseCsvRecord(record:string):string[] {
  const values:string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index]!;
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

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
          question_revision: 1,
          retrieval_mode: 'NONE',
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
  expect(release).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    items:[{
      run_item_id:'item-1',
      question_id:'Q-1',
      retrieval_mode:'NONE',
    }],
  });
  expect(release).toHaveBeenCalledTimes(1);
  expect(clientQuery.mock.calls.map(([sql]) => (
    String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
  ))).toEqual([
    'begin isolation level repeatable read read only',
    expect.stringContaining('from benchmark_runs br join dataset_versions'),
    expect.stringContaining('from judge_invocations invocation'),
    expect.stringContaining('from run_items ri join benchmark_runs'),
    'commit',
  ]);
});

test('reads result items in bounded keyset batches', async () => {
  const release = vi.fn();
  const itemQueries:Array<unknown[]> = [];
  const clientQuery = vi.fn(async (
    sql:string,
    values:unknown[] = [],
  ) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin isolation level repeatable read read only') {
      return { rows:[] };
    }
    if (normalized === 'commit') return { rows:[] };
    if (normalized.includes('from benchmark_runs br join dataset_versions')) {
      return {
        rows:[{
          id:'run-batched-export',
          public_id:'RUN-BATCHED-EXPORT',
          scoring_engine_version_id:null,
          scoring_engine_snapshot:null,
          scoring_engine_snapshot_provenance:'LEGACY_BACKFILL_UNVERIFIED',
        }],
      };
    }
    if (normalized.includes('from judge_invocations invocation')) {
      return { rows:[] };
    }
    if (normalized.includes('from run_items ri join benchmark_runs')) {
      itemQueries.push(values);
      const firstOrdinal = values[2] == null ? 1 : 51;
      const count = values[2] == null ? 50 : 1;
      return {
        rows:Array.from({ length:count }, (_, index) => {
          const ordinal = firstOrdinal + index;
          return {
            run_item_id:`item-${ordinal}`,
            model_response_id:null,
            question_id:`Q-${String(ordinal).padStart(3, '0')}`,
            question_revision:1,
            retrieval_mode:'NONE',
            blind_id:'M01',
            state:'PENDING',
            scores:{},
          };
        }),
      };
    }
    throw new Error(`Unexpected query: ${normalized}`);
  });
  database.connect.mockResolvedValue({
    query:clientQuery,
    release,
  });
  database.query.mockRejectedValue(new Error('AUTOCOMMIT_QUERY_USED'));

  const response = await GET(
    new Request(
      'http://localhost/api/results/run-batched-export/export?format=json',
    ),
    { params:Promise.resolve({ id:'run-batched-export' }) },
  );
  const body = await response.json() as {
    items:Array<{ question_id:string }>;
  };

  expect(body.items).toHaveLength(51);
  expect(body.items.at(-1)?.question_id).toBe('Q-051');
  expect(itemQueries).toHaveLength(2);
  expect(itemQueries[0]?.[2]).toBeNull();
  expect(itemQueries[0]?.[6]).toBe(50);
  expect(itemQueries[1]?.[2]).toBe('Q-050');
  expect(itemQueries[1]?.[6]).toBe(50);
  expect(release).toHaveBeenCalledTimes(1);
});

test('streams large per-response Judge invocations as bounded keyset JSON chunks', async () => {
  const harness = createLargeInvocationExportHarness();
  const response = await GET(
    new Request(
      'http://localhost/api/results/run-large-invocations/export?format=json',
    ),
    { params:Promise.resolve({ id:'run-large-invocations' }) },
  );

  const streamed = await readResponseChunks(response);
  const body = JSON.parse(streamed.body) as {
    judgeInvocations:Array<Record<string, unknown>>;
    items:Array<Record<string, unknown>>;
  };
  const expectedIds = Array.from(
    { length:LARGE_INVOCATION_COUNT },
    (_, index) => invocationId(index + 1),
  );

  expect(body.judgeInvocations.map((row) => row.id)).toEqual(expectedIds);
  expect(body.judgeInvocations[0]).toMatchObject({
    id:invocationId(1),
    attempt:1,
    requestedAt:REQUESTED_AT,
    rawResponse:{
      payload:expect.stringMatching(/^LARGE_INVOCATION_001_/),
    },
  });
  expect(Object.keys(body.judgeInvocations[0] ?? {})).toEqual(
    mappedInvocationKeys,
  );
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    run_item_id:'item-large-invocations',
    model_response_id:RESPONSE_ID,
    judge_invocation_ids:expectedIds,
    judge_invocation_states:Array.from(
      { length:LARGE_INVOCATION_COUNT },
      () => 'PERSISTED',
    ),
    judge_request_hashes:Array.from(
      { length:LARGE_INVOCATION_COUNT },
      (_, index) => String(index + 1).padStart(64, '0'),
    ),
  });
  expect(
    (body.items[0]?.judge_invocations as Array<Record<string, unknown>>)
      .map((row) => row.id),
  ).toEqual(expectedIds);
  expect(
    Object.keys(
      (body.items[0]?.judge_invocations as Array<Record<string, unknown>>)[0]
        ?? {},
    ),
  ).toEqual(mappedInvocationKeys);
  expectBoundedKeysetInvocationQueries(harness.invocationQueries);
  expectBoundedInvocationChunks(streamed.chunks);
  expect(harness.transactionStatements.at(-1)).toBe('commit');
  expect(harness.release).toHaveBeenCalledTimes(1);
});

test('streams large per-response Judge invocations without changing CSV columns or values', async () => {
  const harness = createLargeInvocationExportHarness();
  const response = await GET(
    new Request(
      'http://localhost/api/results/run-large-invocations/export?format=csv',
    ),
    { params:Promise.resolve({ id:'run-large-invocations' }) },
  );

  const streamed = await readResponseChunks(response);
  const [headerLine, rowLine] = streamed.body.split('\r\n');
  const headers = parseCsvRecord(headerLine!.slice(1));
  const values = parseCsvRecord(rowLine!);
  const item = Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? '']),
  );
  const expectedIds = Array.from(
    { length:LARGE_INVOCATION_COUNT },
    (_, index) => invocationId(index + 1),
  );
  const invocations = JSON.parse(item.judge_invocations!) as Array<
    Record<string, unknown>
  >;

  expect(headers.slice(-4)).toEqual([
    'judge_invocation_ids',
    'judge_invocation_states',
    'judge_request_hashes',
    'judge_invocations',
  ]);
  expect(values).toHaveLength(headers.length);
  expect(JSON.parse(item.judge_invocation_ids!)).toEqual(expectedIds);
  expect(JSON.parse(item.judge_invocation_states!)).toEqual(
    Array.from(
      { length:LARGE_INVOCATION_COUNT },
      () => 'PERSISTED',
    ),
  );
  expect(JSON.parse(item.judge_request_hashes!)).toEqual(
    Array.from(
      { length:LARGE_INVOCATION_COUNT },
      (_, index) => String(index + 1).padStart(64, '0'),
    ),
  );
  expect(invocations.map((row) => row.id)).toEqual(expectedIds);
  expect(Object.keys(invocations[0] ?? {})).toEqual(mappedInvocationKeys);
  expect(invocations[0]).toMatchObject({
    id:invocationId(1),
    rawResponse:{
      payload:expect.stringMatching(/^LARGE_INVOCATION_001_/),
    },
  });
  expectBoundedInvocationChunks(streamed.chunks);
  expectBoundedKeysetInvocationQueries(harness.invocationQueries);
  expect(harness.transactionStatements.at(-1)).toBe('commit');
  expect(harness.release).toHaveBeenCalledTimes(1);
});

test('keeps export reads pull-driven and rolls back a cancelled stream', async () => {
  const harness = createLargeInvocationExportHarness();
  const response = await GET(
    new Request(
      'http://localhost/api/results/run-large-invocations/export?format=json',
    ),
    { params:Promise.resolve({ id:'run-large-invocations' }) },
  );
  if (!response.body) throw new Error('Expected an export response body');
  const reader = response.body.getReader();

  expect(harness.invocationQueries).toHaveLength(0);
  await reader.read();
  await reader.read();
  expect(
    harness.invocationQueries.filter((query) => query.scope === 'run'),
  ).toHaveLength(1);
  expect(
    harness.invocationQueries.filter((query) => query.scope === 'response'),
  ).toHaveLength(0);

  await reader.cancel();

  expect(harness.transactionStatements).toContain('rollback');
  expect(harness.transactionStatements).not.toContain('commit');
  expect(harness.release).toHaveBeenCalledTimes(1);
  expect(harness.invocationQueries).toHaveLength(1);
});
