import {
  parseBenchmarkRetrievalModes,
  type BenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import {
  isRunScoreProfileUsable,
  scoreProfileReplacementRequiredMessage,
} from '@/domain/score-profile';
import {
  isCurrentScoringEngineSnapshot,
  isVerifiedScoringEngineSnapshot,
  scoringEngineReplacementRequiredMessage,
} from '@/domain/scoring-engine';
import type { PoolClient } from 'pg';
import { db } from '@/server/db/pool';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';
import { createElement } from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

function csvCell(value: unknown): string {
  const valueText = value == null ? "" : String(value);
  return /[",\r\n]/.test(valueText)
    ? `"${valueText.replaceAll('"', '""')}"`
    : valueText;
}

const pdfStyles = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: "Helvetica", color: "#1d252c" },
  title: { fontSize: 20, marginBottom: 12 },
  section: { marginTop: 14, marginBottom: 5, fontSize: 12 },
  row: {
    flexDirection: "row",
    borderBottom: "1px solid #d9dee2",
    paddingVertical: 4,
  },
  key: { width: "36%", color: "#58636b" },
  value: { width: "64%" },
  note: { marginTop: 5, lineHeight: 1.4, color: "#46515a" },
});

export function summarizeExportRun(
  run: Record<string, unknown>,
): { eligibleResponseCount:number; smallSample:boolean } {
  const rawCount = run.eligible_response_count;
  if (rawCount == null || rawCount === '') {
    throw new Error("EXPORT_ELIGIBLE_RESPONSE_COUNT_MISSING");
  }
  const eligibleResponseCount = Number(rawCount);
  if (!Number.isInteger(eligibleResponseCount) || eligibleResponseCount < 0) {
    throw new Error("EXPORT_ELIGIBLE_RESPONSE_COUNT_MISSING");
  }
  return {
    eligibleResponseCount,
    smallSample:eligibleResponseCount < 30,
  };
}

function scoringEngineExport(run: Record<string, unknown>) {
  const snapshot = (
    run.scoring_engine_snapshot
    && typeof run.scoring_engine_snapshot === 'object'
    && !Array.isArray(run.scoring_engine_snapshot)
  )
    ? run.scoring_engine_snapshot as Record<string, unknown>
    : null;
  const verificationInput = {
    scoringEngineVersionId:typeof run.scoring_engine_version_id === 'string'
      ? run.scoring_engine_version_id
      : null,
    scoringEngineSnapshot:run.scoring_engine_snapshot,
    provenance:typeof run.scoring_engine_snapshot_provenance === 'string'
      ? run.scoring_engine_snapshot_provenance
      : null,
  };
  return {
    id:typeof snapshot?.id === 'string'
      ? snapshot.id
      : run.scoring_engine_version_id ?? null,
    version:typeof snapshot?.version === 'string' ? snapshot.version : null,
    title:typeof snapshot?.title === 'string' ? snapshot.title : null,
    definition:snapshot?.definition ?? null,
    contentHash:typeof snapshot?.contentHash === 'string'
      ? snapshot.contentHash
      : null,
    snapshotProvenance:run.scoring_engine_snapshot_provenance ?? null,
    verified:isVerifiedScoringEngineSnapshot(verificationInput),
    currentVerified:isCurrentScoringEngineSnapshot(verificationInput),
  };
}

function mapJudgeInvocation(row: Record<string, unknown>) {
  return {
    id:row.id,
    benchmarkRunId:row.benchmark_run_id,
    runItemId:row.run_item_id,
    modelResponseId:row.model_response_id,
    scoreProfileId:row.score_profile_id,
    scoringEngineVersionId:row.scoring_engine_version_id,
    parentInvocationId:row.parent_invocation_id,
    invocationKind:row.invocation_kind,
    attempt:row.attempt,
    logicalKey:row.logical_key,
    idempotencyKey:row.idempotency_key,
    state:row.state,
    requestedMetricKeys:row.requested_metric_keys,
    resolvedMetricKeys:row.resolved_metric_keys,
    missingMetricKeys:row.missing_metric_keys,
    requestSnapshot:row.request_snapshot,
    requestHash:row.request_hash,
    providerKey:row.provider_key,
    modelId:row.model_id,
    providerRequestId:row.provider_request_id,
    responseModelId:row.response_model_id,
    responseModelSnapshot:row.response_model_snapshot,
    finishReason:row.finish_reason,
    inputTokens:row.input_tokens,
    outputTokens:row.output_tokens,
    latencyMs:row.latency_ms,
    rawResponse:row.raw_response,
    responseText:row.response_text,
    parsedResponse:row.parsed_response,
    errorCode:row.error_code,
    errorMessage:row.error_message,
    errorStage:row.error_stage,
    requestedAt:row.requested_at,
    responseReceivedAt:row.response_received_at,
    parsedAt:row.parsed_at,
    persistedAt:row.persisted_at,
    failedAt:row.failed_at,
    updatedAt:row.updated_at,
  };
}

async function evidencePdf(
  run: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
): Promise<Uint8Array> {
  const summary = summarizeExportRun(run);
  const values = new Map<string, number[]>();
  for (const item of items)
    for (const [key, score] of Object.entries(
      (item.scores ?? {}) as Record<string, { value?: number | string }>,
    )) {
      if (key === 'exact_match') continue;
      if (score.value == null) continue;
      const value = Number(score.value);
      const seriesKey = [
        String(item.blind_id ?? 'unknown-model'),
        String(item.retrieval_mode ?? 'LEGACY_EVIDENCE'),
        key,
      ].join(' · ');
      if (Number.isFinite(value))
        values.set(seriesKey, [...(values.get(seriesKey) ?? []), value]);
    }
  const averages = [...values]
    .map(
      ([key, scores]) =>
        [
          key,
          scores.reduce((sum, value) => sum + value, 0) / scores.length,
        ] as const,
    )
    .sort((a, b) => b[1] - a[1]);
  const row = (key: string, value: unknown) =>
    createElement(
      View,
      { style: pdfStyles.row, key },
      createElement(Text, { style: pdfStyles.key }, key),
      createElement(Text, { style: pdfStyles.value }, String(value ?? "N/A")),
    );
  const document = createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: pdfStyles.page },
      createElement(
        Text,
        { style: pdfStyles.title },
        "EduBench Evidence Report",
      ),
      row("Run ID", run.public_id),
      row("State", run.state),
      row("Dataset version", run.dataset_version),
      row("Dataset SHA-256", run.dataset_content_hash),
      row("Score profile", run.score_profile_version),
      row("Score profile SHA-256", run.score_profile_content_hash),
      row("Score profile snapshot provenance", run.score_profile_snapshot_provenance),
      row("Scoring engine", run.scoring_engine_version),
      row("Scoring engine SHA-256", run.scoring_engine_content_hash),
      row("Scoring engine snapshot provenance", run.scoring_engine_snapshot_provenance),
      row("Responses", summary.eligibleResponseCount),
      row("Failed items", run.selected_failed_items ?? run.failed_items),
      row("Exported UTC", new Date().toISOString()),
      createElement(Text, { style: pdfStyles.section }, "Metric averages"),
      ...averages.map(([key, value]) =>
        row(key, `${(value * 100).toFixed(2)}% (n=${values.get(key)!.length})`),
      ),
      createElement(Text, { style: pdfStyles.section }, "Interpretation"),
      createElement(
        Text,
        { style: pdfStyles.note },
        `Highest observed metrics: ${
          averages
            .slice(0, 3)
            .map(([key, value]) => `${key} ${(value * 100).toFixed(1)}%`)
            .join(", ") || "N/A"
        }.`,
      ),
      createElement(
        Text,
        { style: pdfStyles.note },
        `Limitations: ${Number(run.selected_failed_items ?? run.failed_items) > 0 ? `${run.selected_failed_items ?? run.failed_items} failed item(s); ` : ""}${summary.smallSample ? "small sample; " : ""}${(run.parameters as { sample_data?: boolean; mock_providers?: boolean } | undefined)?.sample_data || (run.parameters as { mock_providers?: boolean } | undefined)?.mock_providers ? "sample or mock data; " : ""}scores require interpretation with the exported item-level provenance.`,
      ),
    ),
  );
  return new Uint8Array(await renderToBuffer(document));
}

const RESULT_EXPORT_BATCH_SIZE = 50;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const csvKeys = [
  "run_item_id",
  "model_response_id",
  "question_id",
  "question_revision",
  "retrieval_mode",
  "blind_id",
  "display_name",
  "provider_key",
  "model_id",
  "state",
  "score_profile_snapshot_provenance",
  "scoring_engine_version",
  "scoring_engine_content_hash",
  "scoring_engine_snapshot_provenance",
  "question_text",
  "answer_text",
  "scoring_criteria",
  "evidence_mode",
  "question_evidence",
  "retrieval_audit_id",
  "retrieval_root_audit_id",
  "retrieval_query",
  "retrieval_embedding_model",
  "retrieval_embedding_profile_hash",
  "retrieval_vector_space_id",
  "retrieval_candidate_scope",
  "retrieval_selected_chunks",
  "retrieval_graph_trace",
  "retrieval_config_snapshot",
  "retrieval_config_hash",
  "retrieval_rendered_context",
  "retrieval_context_hash",
  "retrieval_shared_snapshot_key",
  "retrieval_shared_from_retrieval_id",
  "provider_request_id",
  "model_snapshot",
  "raw_response",
  "response_text",
  "normalized_text",
  "finish_reason",
  "retry_history",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "cost_native",
  "cost_currency",
  "cost_krw",
  "scores",
  "judge_invocation_ids",
  "judge_invocation_states",
  "judge_request_hashes",
  "judge_invocations",
] as const;

const structuredCsvKeys = new Set<string>([
  "scoring_criteria",
  "question_evidence",
  "retrieval_candidate_scope",
  "retrieval_selected_chunks",
  "retrieval_graph_trace",
  "retrieval_config_snapshot",
  "raw_response",
  "retry_history",
  "scores",
  "judge_invocation_ids",
  "judge_invocation_states",
  "judge_request_hashes",
  "judge_invocations",
]);

type ExportRun = Record<string, unknown>;
type ExportItem = Record<string, unknown>;
type ScoringEngineExport = ReturnType<typeof scoringEngineExport>;

type ItemCursor = {
  questionId:string;
  blindId:string;
  retrievalMode:string;
  modelResponseId:string;
};

type InvocationCursor = {
  requestedAt:unknown;
  id:string;
};

async function loadExportRun(
  client:PoolClient,
  id:string,
  selectedModes:BenchmarkRetrievalMode[] | null,
):Promise<ExportRun | null> {
  const run = await client.query<ExportRun>(
    `select br.*,
       (select count(*)::int from eligible_model_responses eligible
        join run_items eligible_item on eligible_item.id=eligible.run_item_id
        where eligible_item.benchmark_run_id=br.id
          and ($2::text[] is null
            or eligible_item.retrieval_mode=any($2::text[]))
       ) eligible_response_count,
       (select count(*)::int from run_items failed_item
        where failed_item.benchmark_run_id=br.id
          and failed_item.state in ('FAILED','TERMINAL_FAILED')
          and ($2::text[] is null
            or failed_item.retrieval_mode=any($2::text[]))
       ) selected_failed_items,
       dv.version as dataset_version,dv.content_hash as dataset_content_hash,
       br.score_profile_snapshot->>'version' as score_profile_version,
       br.score_profile_snapshot->>'contentHash' as score_profile_content_hash,
       br.score_profile_snapshot->'metrics' as score_profile_metrics,
       br.score_profile_snapshot->'weights' as score_profile_weights,
       br.score_profile_snapshot->>'rubricPrompt'
         as score_profile_rubric_prompt,
       br.score_profile_snapshot->>'judgeProvider' as judge_provider,
       br.score_profile_snapshot->>'judgeModel' as judge_model,
       br.scoring_engine_snapshot->>'version' as scoring_engine_version,
       br.scoring_engine_snapshot->>'contentHash'
         as scoring_engine_content_hash
       from benchmark_runs br
       join dataset_versions dv on dv.id=br.dataset_version_id
      where br.id=$1`,
    [id, selectedModes],
  );
  return run.rows[0] ?? null;
}

async function loadExportItemBatch(
  client:PoolClient,
  id:string,
  selectedModes:BenchmarkRetrievalMode[] | null,
  cursor:ItemCursor | null,
):Promise<ExportItem[]> {
  const items = await client.query<ExportItem>(
    `select ri.id as run_item_id,mr.id as model_response_id,
       q.public_id as question_id,ri.question_revision,ri.retrieval_mode,
       rm.blind_id,rm.display_name,rm.provider_key,rm.model_id,ri.state,
       br.score_profile_snapshot_provenance,
       qr.question_text,qr.answer_text,qr.scoring_criteria,q.evidence_mode,
       coalesce((
         select jsonb_agg(jsonb_build_object(
           'chunkId',qe.source_chunk_id,'quote',qe.quote_text,
           'ordinal',qe.ordinal
         ) order by qe.ordinal)
           from question_evidence qe
          where qe.question_id=ri.question_id
            and qe.question_revision=ri.question_revision
       ),'[]'::jsonb) question_evidence,
       retrieval.id retrieval_audit_id,
       coalesce(retrieval.shared_from_retrieval_id,retrieval.id)
         retrieval_root_audit_id,
       coalesce(retrieval.query_text,retrieval_root.query_text)
         retrieval_query,
       coalesce(retrieval.embedding_model,retrieval_root.embedding_model)
         retrieval_embedding_model,
       coalesce(
         retrieval.embedding_profile_hash,
         retrieval_root.embedding_profile_hash
       ) retrieval_embedding_profile_hash,
       coalesce(retrieval.vector_space_id,retrieval_root.vector_space_id)
         retrieval_vector_space_id,
       coalesce(retrieval.candidate_scope,retrieval_root.candidate_scope)
         retrieval_candidate_scope,
       coalesce(retrieval.selected_chunks,retrieval_root.selected_chunks)
         retrieval_selected_chunks,
       coalesce(retrieval.graph_trace,retrieval_root.graph_trace)
         retrieval_graph_trace,
       coalesce(retrieval.config_snapshot,retrieval_root.config_snapshot)
         retrieval_config_snapshot,
       coalesce(retrieval.config_hash,retrieval_root.config_hash)
         retrieval_config_hash,
       coalesce(retrieval.rendered_context,retrieval_root.rendered_context)
         retrieval_rendered_context,
       coalesce(retrieval.context_hash,retrieval_root.context_hash)
         retrieval_context_hash,
       coalesce(
         retrieval.shared_snapshot_key,
         retrieval_root.shared_snapshot_key
       ) retrieval_shared_snapshot_key,
       retrieval.shared_from_retrieval_id
         retrieval_shared_from_retrieval_id,
       mr.provider_request_id,mr.model_snapshot,mr.raw_response,
       mr.response_text,mr.normalized_text,mr.finish_reason,mr.retry_history,
       mr.input_tokens,mr.output_tokens,mr.latency_ms,mr.cost_native,
       mr.cost_currency,mr.cost_krw,
       coalesce((
         select jsonb_object_agg(
           score.metric_key,
           jsonb_build_object(
             'value',score.value,'label',score.label,
             'rationale',score.rationale,'evidence',score.evidence,
             'judgeProvider',score.judge_provider,
             'judgeModel',score.judge_model,
             'judgeRequestId',score.judge_request_id,
             'judgeInvocationId',score.judge_invocation_id,
             'provenance',score.provenance
           )
         )
           from scores score
          where score.model_response_id=mr.id
            and score.score_profile_id=br.score_profile_id
            and score.metric_key<>'exact_match'
       ),'{}'::jsonb) scores
       from run_items ri
       join benchmark_runs br on br.id=ri.benchmark_run_id
       join run_models rm on rm.id=ri.run_model_id
       join questions q on q.id=ri.question_id
       join question_revisions qr
         on qr.question_id=ri.question_id
        and qr.revision=ri.question_revision
       left join run_item_retrievals retrieval
         on retrieval.run_item_id=ri.id
       left join run_item_retrievals retrieval_root
         on retrieval_root.id=retrieval.shared_from_retrieval_id
       left join eligible_model_responses mr on mr.run_item_id=ri.id
      where ri.benchmark_run_id=$1
        and ($2::text[] is null or ri.retrieval_mode=any($2::text[]))
        and (
          $3::text is null
          or (
            q.public_id,
            rm.blind_id,
            ri.retrieval_mode,
            coalesce(mr.id,'${ZERO_UUID}'::uuid)
          ) > ($3::text,$4::text,$5::text,$6::uuid)
        )
      order by q.public_id,rm.blind_id,ri.retrieval_mode,
        coalesce(mr.id,'${ZERO_UUID}'::uuid)
      limit $7`,
    [
      id,
      selectedModes,
      cursor?.questionId ?? null,
      cursor?.blindId ?? null,
      cursor?.retrievalMode ?? null,
      cursor?.modelResponseId ?? ZERO_UUID,
      RESULT_EXPORT_BATCH_SIZE,
    ],
  );
  return items.rows;
}

async function loadInvocationBatch(
  client:PoolClient,
  id:string,
  selectedModes:BenchmarkRetrievalMode[] | null,
  cursor:InvocationCursor | null,
):Promise<Array<Record<string, unknown>>> {
  const invocations = await client.query<Record<string, unknown>>(
    `select invocation.*,response.run_item_id
       from judge_invocations invocation
       join model_responses response
         on response.id=invocation.model_response_id
       join run_items item on item.id=response.run_item_id
      where invocation.benchmark_run_id=$1
        and ($2::text[] is null or item.retrieval_mode=any($2::text[]))
        and (
          $3::timestamptz is null
          or (invocation.requested_at,invocation.id)
             > ($3::timestamptz,$4::uuid)
        )
      order by invocation.requested_at,invocation.id
      limit $5`,
    [
      id,
      selectedModes,
      cursor?.requestedAt ?? null,
      cursor?.id ?? ZERO_UUID,
      RESULT_EXPORT_BATCH_SIZE,
    ],
  );
  return invocations.rows;
}

type ResponseInvocationProjection =
  | 'id'
  | 'state'
  | 'requestHash'
  | 'invocation';

const responseInvocationSelections:Record<
  ResponseInvocationProjection,
  string
> = {
  id:'invocation.id,invocation.requested_at',
  state:'invocation.id,invocation.requested_at,invocation.state',
  requestHash:
    'invocation.id,invocation.requested_at,invocation.request_hash',
  invocation:'invocation.*,response.run_item_id',
};

async function loadResponseInvocationBatch(
  client:PoolClient,
  responseId:string,
  cursor:InvocationCursor | null,
  projection:ResponseInvocationProjection,
):Promise<Array<Record<string, unknown>>> {
  const invocations = await client.query<Record<string, unknown>>(
    `select ${responseInvocationSelections[projection]}
       from judge_invocations invocation
       join model_responses response
         on response.id=invocation.model_response_id
      where invocation.model_response_id=$1
        and (
          $2::timestamptz is null
          or (invocation.requested_at,invocation.id)
             > ($2::timestamptz,$3::uuid)
        )
      order by invocation.requested_at,invocation.id
      limit $4`,
    [
      responseId,
      cursor?.requestedAt ?? null,
      cursor?.id ?? ZERO_UUID,
      RESULT_EXPORT_BATCH_SIZE,
    ],
  );
  return invocations.rows;
}

function decorateExportItemBase(
  row:ExportItem,
  scoringEngine:ScoringEngineExport,
):ExportItem {
  return {
    ...row,
    scoring_engine_version:scoringEngine.version,
    scoring_engine_content_hash:scoringEngine.contentHash,
    scoring_engine_snapshot_provenance:scoringEngine.snapshotProvenance,
  };
}

function responseInvocationValue(
  row:Record<string, unknown>,
  projection:ResponseInvocationProjection,
):unknown {
  switch (projection) {
    case 'id':
      return row.id;
    case 'state':
      return row.state;
    case 'requestHash':
      return row.request_hash;
    case 'invocation':
      return mapJudgeInvocation(row);
  }
}

async function* responseInvocationValues(
  client:PoolClient,
  responseId:string,
  projection:ResponseInvocationProjection,
):AsyncGenerator<unknown> {
  let cursor:InvocationCursor | null = null;
  while (true) {
    const rows = await loadResponseInvocationBatch(
      client,
      responseId,
      cursor,
      projection,
    );
    if (!rows.length) break;
    for (const row of rows) {
      yield responseInvocationValue(row, projection);
    }
    const last = rows[rows.length - 1]!;
    cursor = {
      requestedAt:last.requested_at,
      id:String(last.id),
    };
    if (rows.length < RESULT_EXPORT_BATCH_SIZE) break;
  }
}

function prettyJson(value:unknown):string {
  return JSON.stringify(value, null, 2);
}

function indentedJson(value:unknown, spaces:number):string {
  const indentation = ' '.repeat(spaces);
  return indentation + prettyJson(value)
    .replaceAll('\n', `\n${indentation}`);
}

function jsonValueAfterProperty(value:unknown):string {
  return prettyJson(value).replaceAll('\n', '\n  ');
}

function indentedObjectWithoutClosing(
  value:Record<string, unknown>,
  spaces:number,
):string {
  const serialized = indentedJson(value, spaces);
  const closing = `\n${' '.repeat(spaces)}}`;
  if (!serialized.endsWith(closing)) {
    throw new Error('EXPORT_ITEM_SERIALIZATION_FAILED');
  }
  return serialized.slice(0, -closing.length);
}

async function* jsonResponseInvocationArrayChunks(
  client:PoolClient,
  responseId:string | null,
  projection:ResponseInvocationProjection,
  closingIndent:number,
):AsyncGenerator<string> {
  if (!responseId) {
    yield '[]';
    return;
  }
  const values = responseInvocationValues(client, responseId, projection);
  const first = await values.next();
  if (first.done) {
    yield '[]';
    return;
  }
  yield '[';
  yield `\n${indentedJson(first.value, closingIndent + 2)}`;
  for await (const value of values) {
    yield `,\n${indentedJson(value, closingIndent + 2)}`;
  }
  yield `\n${' '.repeat(closingIndent)}]`;
}

function csvJsonFragment(value:unknown):string {
  const serialized = JSON.stringify(value);
  return (serialized ?? 'null').replaceAll('"', '""');
}

async function* csvResponseInvocationArrayChunks(
  client:PoolClient,
  responseId:string | null,
  projection:ResponseInvocationProjection,
):AsyncGenerator<string> {
  if (!responseId) {
    yield '[]';
    return;
  }
  const values = responseInvocationValues(client, responseId, projection);
  const first = await values.next();
  if (first.done) {
    yield '[]';
    return;
  }
  yield '"[';
  yield csvJsonFragment(first.value);
  for await (const value of values) {
    yield `,${csvJsonFragment(value)}`;
  }
  yield ']"';
}

async function* jsonExportChunks(
  client:PoolClient,
  input:{
    id:string;
    selectedModes:BenchmarkRetrievalMode[] | null;
    run:ExportRun;
    scoringEngine:ScoringEngineExport;
    exportedAt:string;
  },
):AsyncGenerator<string> {
  yield `{\n  "exportedAt": ${jsonValueAfterProperty(input.exportedAt)},`
    + `\n  "selectedRetrievalModes": ${
      jsonValueAfterProperty(input.selectedModes)
    },`
    + `\n  "run": ${jsonValueAfterProperty(input.run)},`
    + `\n  "scoringEngine": ${
      jsonValueAfterProperty(input.scoringEngine)
    },`
    + '\n  "judgeInvocations": ';

  let invocationCursor:InvocationCursor | null = null;
  let wroteInvocation = false;
  while (true) {
    const rows = await loadInvocationBatch(
      client,
      input.id,
      input.selectedModes,
      invocationCursor,
    );
    if (!rows.length) break;
    if (!wroteInvocation) yield '[';
    for (const row of rows) {
      const invocation = mapJudgeInvocation(row);
      yield `${wroteInvocation ? ',\n' : '\n'}${
        indentedJson(invocation, 4)
      }`;
      wroteInvocation = true;
    }
    const last = rows[rows.length - 1]!;
    invocationCursor = {
      requestedAt:last.requested_at,
      id:String(last.id),
    };
    if (rows.length < RESULT_EXPORT_BATCH_SIZE) break;
  }
  yield wroteInvocation
    ? '\n  ],\n  "items": '
    : '[],\n  "items": ';

  let itemCursor:ItemCursor | null = null;
  let wroteItem = false;
  while (true) {
    const rows = await loadExportItemBatch(
      client,
      input.id,
      input.selectedModes,
      itemCursor,
    );
    if (!rows.length) break;
    if (!wroteItem) yield '[';
    for (const row of rows) {
      const responseId = typeof row.model_response_id === 'string'
        ? row.model_response_id
        : null;
      yield `${wroteItem ? ',\n' : '\n'}${
        indentedObjectWithoutClosing(
          decorateExportItemBase(row, input.scoringEngine),
          4,
        )
      },\n      "judge_invocation_ids": `;
      yield* jsonResponseInvocationArrayChunks(
        client,
        responseId,
        'id',
        6,
      );
      yield ',\n      "judge_invocation_states": ';
      yield* jsonResponseInvocationArrayChunks(
        client,
        responseId,
        'state',
        6,
      );
      yield ',\n      "judge_request_hashes": ';
      yield* jsonResponseInvocationArrayChunks(
        client,
        responseId,
        'requestHash',
        6,
      );
      yield ',\n      "judge_invocations": ';
      yield* jsonResponseInvocationArrayChunks(
        client,
        responseId,
        'invocation',
        6,
      );
      yield '\n    }';
      wroteItem = true;
    }
    const last = rows[rows.length - 1]!;
    itemCursor = {
      questionId:String(last.question_id),
      blindId:String(last.blind_id),
      retrievalMode:String(last.retrieval_mode),
      modelResponseId:typeof last.model_response_id === 'string'
        ? last.model_response_id
        : ZERO_UUID,
    };
    if (rows.length < RESULT_EXPORT_BATCH_SIZE) break;
  }
  yield wroteItem ? '\n  ]\n}' : '[]\n}';
}

async function* csvExportChunks(
  client:PoolClient,
  input:{
    id:string;
    selectedModes:BenchmarkRetrievalMode[] | null;
    scoringEngine:ScoringEngineExport;
  },
):AsyncGenerator<string> {
  yield `\uFEFF${csvKeys.join(',')}`;
  const baseCsvKeys = csvKeys.slice(0, -4);
  let cursor:ItemCursor | null = null;
  while (true) {
    const rows = await loadExportItemBatch(
      client,
      input.id,
      input.selectedModes,
      cursor,
    );
    if (!rows.length) break;
    for (const row of rows) {
      const item = decorateExportItemBase(row, input.scoringEngine);
      const responseId = typeof row.model_response_id === 'string'
        ? row.model_response_id
        : null;
      yield `\r\n${baseCsvKeys.map((key) =>
        csvCell(
          structuredCsvKeys.has(key)
            ? JSON.stringify(item[key])
            : item[key],
        )).join(',')},`;
      yield* csvResponseInvocationArrayChunks(
        client,
        responseId,
        'id',
      );
      yield ',';
      yield* csvResponseInvocationArrayChunks(
        client,
        responseId,
        'state',
      );
      yield ',';
      yield* csvResponseInvocationArrayChunks(
        client,
        responseId,
        'requestHash',
      );
      yield ',';
      yield* csvResponseInvocationArrayChunks(
        client,
        responseId,
        'invocation',
      );
    }
    const last = rows[rows.length - 1]!;
    cursor = {
      questionId:String(last.question_id),
      blindId:String(last.blind_id),
      retrievalMode:String(last.retrieval_mode),
      modelResponseId:typeof last.model_response_id === 'string'
        ? last.model_response_id
        : ZERO_UUID,
    };
    if (rows.length < RESULT_EXPORT_BATCH_SIZE) break;
  }
}

function databaseExportStream(
  client:PoolClient,
  chunks:AsyncGenerator<string>,
):ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let released = false;
  const finish = async (commit:boolean) => {
    if (released) return;
    released = true;
    try {
      if (commit) {
        try {
          await client.query('commit');
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        }
      } else {
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          await finish(true);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        await finish(false).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined).catch(() => undefined);
      await finish(false);
    },
  });
}

async function loadPdfItems(
  client:PoolClient,
  id:string,
  selectedModes:BenchmarkRetrievalMode[] | null,
):Promise<ExportItem[]> {
  const items = await client.query<ExportItem>(
    `select rm.blind_id,ri.retrieval_mode,
       coalesce((
         select jsonb_object_agg(
           score.metric_key,
           jsonb_build_object('value',score.value)
         )
           from scores score
          where score.model_response_id=response.id
            and score.score_profile_id=run.score_profile_id
            and score.metric_key<>'exact_match'
       ),'{}'::jsonb) scores
       from run_items ri
       join benchmark_runs run on run.id=ri.benchmark_run_id
       join run_models rm on rm.id=ri.run_model_id
       left join eligible_model_responses response
         on response.run_item_id=ri.id
      where ri.benchmark_run_id=$1
        and ($2::text[] is null or ri.retrieval_mode=any($2::text[]))
      order by rm.blind_id,ri.retrieval_mode,response.id`,
    [id, selectedModes],
  );
  return items.rows;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const format = searchParams.get("format") ?? "json";
  if (!["json", "csv", "pdf"].includes(format))
    return new Response("UNSUPPORTED_EXPORT_FORMAT", { status: 400 });
  let selectedModes:BenchmarkRetrievalMode[] | null = null;
  const rawModes = searchParams.get('modes');
  if (rawModes != null) {
    try {
      selectedModes = parseBenchmarkRetrievalModes(
        rawModes.split(',').filter(Boolean),
      );
    } catch {
      return new Response('INVALID_RETRIEVAL_MODES', { status:400 });
    }
  }

  if (format === 'pdf') {
    const snapshot = await withReadOnlyRepeatableReadTransaction(
      async (client) => {
        const run = await loadExportRun(client, id, selectedModes);
        if (!run) return null;
        return {
          run,
          items:await loadPdfItems(client, id, selectedModes),
        };
      },
    );
    if (!snapshot) return new Response("RUN_NOT_FOUND", { status:404 });
    if (!isRunScoreProfileUsable({
      judgeProvider:typeof snapshot.run.judge_provider === 'string'
        ? snapshot.run.judge_provider
        : null,
      judgeModel:typeof snapshot.run.judge_model === 'string'
        ? snapshot.run.judge_model
        : null,
      metrics:snapshot.run.score_profile_metrics,
      snapshotProvenance:
        typeof snapshot.run.score_profile_snapshot_provenance === 'string'
          ? snapshot.run.score_profile_snapshot_provenance
          : null,
    })) {
      return Response.json({
        code:'SCORE_PROFILE_REPLACEMENT_REQUIRED',
        message:`${scoreProfileReplacementRequiredMessage} 공식 PDF 근거는 새 실행에서만 생성할 수 있습니다.`,
      }, { status:409 });
    }
    if (!isCurrentScoringEngineSnapshot({
      scoringEngineVersionId:
        typeof snapshot.run.scoring_engine_version_id === 'string'
          ? snapshot.run.scoring_engine_version_id
          : null,
      scoringEngineSnapshot:snapshot.run.scoring_engine_snapshot,
      provenance:
        typeof snapshot.run.scoring_engine_snapshot_provenance === 'string'
          ? snapshot.run.scoring_engine_snapshot_provenance
          : null,
    })) {
      return Response.json({
        code:'SCORING_ENGINE_REPLACEMENT_REQUIRED',
        message:`${scoringEngineReplacementRequiredMessage} 공식 PDF 근거는 새 실행에서만 생성할 수 있습니다.`,
      }, { status:409 });
    }
    const pdf = await evidencePdf(snapshot.run, snapshot.items);
    return new Response(pdf as unknown as BodyInit, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition":
          `attachment; filename="${snapshot.run.public_id}-report.pdf"`,
      },
    });
  }

  const client = await db.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const run = await loadExportRun(client, id, selectedModes);
    if (!run) {
      await client.query('rollback');
      client.release();
      return new Response("RUN_NOT_FOUND", { status:404 });
    }
    const scoringEngine = scoringEngineExport(run);
    const chunks = format === 'csv'
      ? csvExportChunks(client, { id, selectedModes, scoringEngine })
      : jsonExportChunks(client, {
        id,
        selectedModes,
        run,
        scoringEngine,
        exportedAt:new Date().toISOString(),
      });
    return new Response(databaseExportStream(client, chunks), {
      headers: {
        "content-type":format === 'csv'
          ? "text/csv; charset=utf-8"
          : "application/json; charset=utf-8",
        "content-disposition":format === 'csv'
          ? `attachment; filename="${run.public_id}-evidence.csv"`
          : `attachment; filename="${run.public_id}-evidence.json"`,
      },
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    client.release();
    throw error;
  }
}
