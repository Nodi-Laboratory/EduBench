import { db } from '@/server/db/pool';

function csvCell(value: unknown): string { const valueText = value == null ? '' : String(value); return /[",\r\n]/.test(valueText) ? `"${valueText.replaceAll('"', '""')}"` : valueText; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params; const format = new URL(request.url).searchParams.get('format') ?? 'json';
  const run = await db.query('select * from benchmark_runs where id = $1', [id]);
  if (!run.rows[0]) return new Response('RUN_NOT_FOUND', { status: 404 });
  const items = await db.query(
    `select ri.id as run_item_id, q.public_id as question_id, ri.question_revision,
       rm.blind_id, rm.display_name, rm.provider_key, rm.model_id, ri.state,
       qr.question_text, qr.answer_text, mr.response_text, mr.normalized_text,
       mr.input_tokens, mr.output_tokens, mr.latency_ms, mr.cost_native, mr.cost_currency, mr.cost_krw,
       coalesce(jsonb_object_agg(s.metric_key, s.value) filter (where s.id is not null), '{}'::jsonb) as scores
     from run_items ri join run_models rm on rm.id = ri.run_model_id join questions q on q.id = ri.question_id
     join question_revisions qr on qr.question_id = ri.question_id and qr.revision = ri.question_revision
     left join model_responses mr on mr.run_item_id = ri.id left join scores s on s.model_response_id = mr.id
     where ri.benchmark_run_id = $1 group by ri.id,q.public_id,rm.id,qr.id,mr.id order by q.public_id,rm.blind_id`, [id],
  );
  if (format === 'csv') {
    const keys = ['run_item_id','question_id','question_revision','blind_id','display_name','provider_key','model_id','state','question_text','answer_text','response_text','normalized_text','input_tokens','output_tokens','latency_ms','cost_native','cost_currency','cost_krw','scores'];
    const csv = '\uFEFF' + [keys.join(','), ...items.rows.map((row) => keys.map((key) => csvCell(key === 'scores' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\r\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${run.rows[0].public_id}-evidence.csv"` } });
  }
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), run: run.rows[0], items: items.rows }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${run.rows[0].public_id}-evidence.json"` } });
}
