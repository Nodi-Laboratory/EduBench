import { db } from "@/server/db/pool";
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

async function evidencePdf(
  run: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
): Promise<Uint8Array> {
  const values = new Map<string, number[]>();
  for (const item of items)
    for (const [key, score] of Object.entries(
      (item.scores ?? {}) as Record<string, { value?: number | string }>,
    )) {
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
      row("Responses", items.length),
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
        `Limitations: ${Number(run.failed_items) > 0 ? `${run.failed_items} failed item(s); ` : ""}${items.length < 30 ? "small sample; " : ""}${(run.parameters as { sample_data?: boolean; mock_providers?: boolean } | undefined)?.sample_data || (run.parameters as { mock_providers?: boolean } | undefined)?.mock_providers ? "sample or mock data; " : ""}scores require interpretation with the exported item-level provenance.`,
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
  const run = await db.query(
    `select br.*, dv.version as dataset_version, dv.content_hash as dataset_content_hash,
       sp.version as score_profile_version, sp.content_hash as score_profile_content_hash,
       sp.metrics as score_profile_metrics, sp.judge_provider, sp.judge_model
     from benchmark_runs br join dataset_versions dv on dv.id = br.dataset_version_id
     join score_profiles sp on sp.id = br.score_profile_id where br.id = $1`,
    [id],
  );
  if (!run.rows[0]) return new Response("RUN_NOT_FOUND", { status: 404 });
  const items = await db.query(
    `select ri.id as run_item_id, q.public_id as question_id, ri.question_revision,
       rm.blind_id, rm.display_name, rm.provider_key, rm.model_id, ri.state,
       qr.question_text, qr.answer_text, qr.scoring_criteria, q.evidence_mode,
       coalesce((select jsonb_agg(jsonb_build_object('chunkId', qe.source_chunk_id, 'quote', qe.quote_text, 'ordinal', qe.ordinal) order by qe.ordinal)
         from question_evidence qe where qe.question_id = ri.question_id and qe.question_revision = ri.question_revision), '[]'::jsonb) as question_evidence,
       mr.provider_request_id, mr.model_snapshot, mr.raw_response, mr.response_text, mr.normalized_text, mr.finish_reason, mr.retry_history,
       mr.input_tokens, mr.output_tokens, mr.latency_ms, mr.cost_native, mr.cost_currency, mr.cost_krw,
       coalesce(jsonb_object_agg(s.metric_key, jsonb_build_object('value', s.value, 'label', s.label, 'rationale', s.rationale, 'evidence', s.evidence, 'judgeProvider', s.judge_provider, 'judgeModel', s.judge_model, 'judgeRequestId', s.judge_request_id)) filter (where s.id is not null), '{}'::jsonb) as scores
     from run_items ri join run_models rm on rm.id = ri.run_model_id join questions q on q.id = ri.question_id
     join question_revisions qr on qr.question_id = ri.question_id and qr.revision = ri.question_revision
     left join model_responses mr on mr.run_item_id = ri.id left join scores s on s.model_response_id = mr.id
     where ri.benchmark_run_id = $1 group by ri.id,q.id,rm.id,qr.id,mr.id order by q.public_id,rm.blind_id`,
    [id],
  );
  if (format === "csv") {
    const keys = [
      "run_item_id",
      "question_id",
      "question_revision",
      "blind_id",
      "display_name",
      "provider_key",
      "model_id",
      "state",
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
    ];
    const structured = new Set([
      "scoring_criteria",
      "question_evidence",
      "raw_response",
      "retry_history",
      "scores",
    ]);
    const csv =
      "\uFEFF" +
      [
        keys.join(","),
        ...items.rows.map((row) =>
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
    const pdf = await evidencePdf(run.rows[0], items.rows);
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
        items: items.rows,
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
