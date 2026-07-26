import {
  isRunScoreProfileUsable,
  scoreProfileReplacementRequiredMessage,
} from '@/domain/score-profile';
import {
  isCurrentScoringEngineSnapshot,
  isVerifiedScoringEngineSnapshot,
  scoringEngineReplacementRequiredMessage,
} from '@/domain/scoring-engine';
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
      if (score.value == null) continue;
      const value = Number(score.value);
      if (Number.isFinite(value))
        values.set(key, [...(values.get(key) ?? []), value]);
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
      row("Failed items", run.failed_items),
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
        `Limitations: ${Number(run.failed_items) > 0 ? `${run.failed_items} failed item(s); ` : ""}${summary.smallSample ? "small sample; " : ""}${(run.parameters as { sample_data?: boolean; mock_providers?: boolean } | undefined)?.sample_data || (run.parameters as { mock_providers?: boolean } | undefined)?.mock_providers ? "sample or mock data; " : ""}scores require interpretation with the exported item-level provenance.`,
      ),
    ),
  );
  return new Uint8Array(await renderToBuffer(document));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  if (!["json", "csv", "pdf"].includes(format))
    return new Response("UNSUPPORTED_EXPORT_FORMAT", { status: 400 });
  const snapshot = await withReadOnlyRepeatableReadTransaction(
    async (client) => {
      const run = await client.query(
        `select br.*,
       (select count(*)::int from eligible_model_responses eligible
        join run_items eligible_item on eligible_item.id=eligible.run_item_id
        where eligible_item.benchmark_run_id=br.id) eligible_response_count,
       dv.version as dataset_version, dv.content_hash as dataset_content_hash,
       br.score_profile_snapshot->>'version' as score_profile_version,
       br.score_profile_snapshot->>'contentHash' as score_profile_content_hash,
       br.score_profile_snapshot->'metrics' as score_profile_metrics,
       br.score_profile_snapshot->'weights' as score_profile_weights,
       br.score_profile_snapshot->>'rubricPrompt' as score_profile_rubric_prompt,
       br.score_profile_snapshot->>'judgeProvider' as judge_provider,
       br.score_profile_snapshot->>'judgeModel' as judge_model,
       br.scoring_engine_snapshot->>'version' as scoring_engine_version,
       br.scoring_engine_snapshot->>'contentHash' as scoring_engine_content_hash
     from benchmark_runs br join dataset_versions dv on dv.id = br.dataset_version_id
     where br.id = $1`,
        [id],
      );
      if (!run.rows[0]) return null;
      const items = await client.query(
        `select ri.id as run_item_id, mr.id as model_response_id,
       q.public_id as question_id, ri.question_revision,
       rm.blind_id, rm.display_name, rm.provider_key, rm.model_id, ri.state,
       br.score_profile_snapshot_provenance,
       qr.question_text, qr.answer_text, qr.scoring_criteria, q.evidence_mode,
       coalesce((select jsonb_agg(jsonb_build_object('chunkId', qe.source_chunk_id, 'quote', qe.quote_text, 'ordinal', qe.ordinal) order by qe.ordinal)
         from question_evidence qe where qe.question_id = ri.question_id and qe.question_revision = ri.question_revision), '[]'::jsonb) as question_evidence,
       mr.provider_request_id, mr.model_snapshot, mr.raw_response, mr.response_text, mr.normalized_text, mr.finish_reason, mr.retry_history,
       mr.input_tokens, mr.output_tokens, mr.latency_ms, mr.cost_native, mr.cost_currency, mr.cost_krw,
       coalesce((select jsonb_object_agg(
         s.metric_key,
         jsonb_build_object(
           'value',s.value,'label',s.label,'rationale',s.rationale,'evidence',s.evidence,
           'judgeProvider',s.judge_provider,'judgeModel',s.judge_model,
           'judgeRequestId',s.judge_request_id,
           'judgeInvocationId',s.judge_invocation_id,
           'provenance',s.provenance
         )
       ) from scores s
       where s.model_response_id=mr.id and s.score_profile_id=br.score_profile_id), '{}'::jsonb) as scores
     from run_items ri join benchmark_runs br on br.id=ri.benchmark_run_id
     join run_models rm on rm.id = ri.run_model_id join questions q on q.id = ri.question_id
     join question_revisions qr on qr.question_id = ri.question_id and qr.revision = ri.question_revision
     left join eligible_model_responses mr on mr.run_item_id = ri.id
     where ri.benchmark_run_id = $1 order by q.public_id,rm.blind_id`,
        [id],
      );
      const invocationRows = await client.query(
        `select invocation.*,response.run_item_id
     from judge_invocations invocation
     join model_responses response on response.id=invocation.model_response_id
     where invocation.benchmark_run_id=$1
     order by invocation.requested_at,invocation.id`,
        [id],
      );
      return { run, items, invocationRows };
    },
  );
  if (!snapshot) return new Response("RUN_NOT_FOUND", { status: 404 });
  const { run, items, invocationRows } = snapshot;
  if (
    format === 'pdf'
    && !isRunScoreProfileUsable({
      judgeProvider:run.rows[0].judge_provider,
      judgeModel:run.rows[0].judge_model,
      metrics:run.rows[0].score_profile_metrics,
      snapshotProvenance:run.rows[0].score_profile_snapshot_provenance,
    })
  ) {
    return Response.json({
      code:'SCORE_PROFILE_REPLACEMENT_REQUIRED',
      message:`${scoreProfileReplacementRequiredMessage} 공식 PDF 근거는 새 실행에서만 생성할 수 있습니다.`,
    }, { status:409 });
  }
  if (
    format === 'pdf'
    && !isCurrentScoringEngineSnapshot({
      scoringEngineVersionId:run.rows[0].scoring_engine_version_id,
      scoringEngineSnapshot:run.rows[0].scoring_engine_snapshot,
      provenance:run.rows[0].scoring_engine_snapshot_provenance,
    })
  ) {
    return Response.json({
      code:'SCORING_ENGINE_REPLACEMENT_REQUIRED',
      message:`${scoringEngineReplacementRequiredMessage} 공식 PDF 근거는 새 실행에서만 생성할 수 있습니다.`,
    }, { status:409 });
  }
  const judgeInvocations = invocationRows.rows.map(mapJudgeInvocation);
  const scoringEngine = scoringEngineExport(run.rows[0]);
  const exportItems = items.rows.map((row) => {
    const itemInvocations = judgeInvocations.filter(
      (invocation) => invocation.modelResponseId === row.model_response_id,
    );
    return {
      ...row,
      scoring_engine_version:scoringEngine.version,
      scoring_engine_content_hash:scoringEngine.contentHash,
      scoring_engine_snapshot_provenance:scoringEngine.snapshotProvenance,
      judge_invocation_ids:itemInvocations.map((invocation) => invocation.id),
      judge_invocation_states:itemInvocations.map((invocation) => invocation.state),
      judge_request_hashes:itemInvocations.map((invocation) => invocation.requestHash),
      judge_invocations:itemInvocations,
    };
  });
  if (format === "csv") {
    const keys = [
      "run_item_id",
      "model_response_id",
      "question_id",
      "question_revision",
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
    ];
    const structured = new Set([
      "scoring_criteria",
      "question_evidence",
      "raw_response",
      "retry_history",
      "scores",
      "judge_invocation_ids",
      "judge_invocation_states",
      "judge_request_hashes",
      "judge_invocations",
    ]);
    const csv =
      "\uFEFF" +
      [
        keys.join(","),
        ...exportItems.map((row) =>
          keys
            .map((key) =>
              csvCell(
                structured.has(key) ? JSON.stringify(row[key]) : row[key],
              ),
            )
            .join(","),
        ),
      ].join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${run.rows[0].public_id}-evidence.csv"`,
      },
    });
  }
  if (format === "pdf") {
    const pdf = await evidencePdf(run.rows[0], exportItems);
    return new Response(pdf as unknown as BodyInit, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${run.rows[0].public_id}-report.pdf"`,
      },
    });
  }
  return new Response(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        run: run.rows[0],
        scoringEngine,
        judgeInvocations,
        items: exportItems,
      },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${run.rows[0].public_id}-evidence.json"`,
      },
    },
  );
}
