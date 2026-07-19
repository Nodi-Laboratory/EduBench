import { exactMatch, normalizeKoreanAnswer, tokenCost } from '@/domain/scoring';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';

type ScoreRow = {
  response_id: string; response_text: string; input_tokens: number | null; output_tokens: number | null;
  score_profile_id: string; price_profile_version: string; provider_key: string; model_id: string;
  answer_text: string; accepted_answers: unknown;
};

export async function scoreRun(runId: string): Promise<{ scoredResponses: number }> {
  const rows = await db.query<ScoreRow>(
    `select mr.id as response_id, mr.response_text, mr.input_tokens, mr.output_tokens,
       br.score_profile_id, br.price_profile_version, rm.provider_key, rm.model_id,
       qr.answer_text, qr.accepted_answers
     from benchmark_runs br join run_items ri on ri.benchmark_run_id = br.id
     join run_models rm on rm.id = ri.run_model_id
     join model_responses mr on mr.run_item_id = ri.id and not mr.ignored_after_cancel
     join question_revisions qr on qr.question_id = ri.question_id and qr.revision = ri.question_revision
     where br.id = $1 and not exists (select 1 from scores s where s.model_response_id = mr.id)`, [runId],
  );
  await withTransaction(async (client) => {
    for (const row of rows.rows) {
      const accepted = Array.isArray(row.accepted_answers) ? row.accepted_answers.map(String) : [];
      accepted.push(row.answer_text);
      const matched = exactMatch(row.response_text, accepted);
      await client.query(
        `insert into scores(model_response_id, score_profile_id, metric_key, value, label, rationale)
         values ($1,$2,'exact_match',$3,$4,$5),
                ($1,$2,'response_present',$6,$7,$8)`,
        [row.response_id, row.score_profile_id, matched, matched ? 'MATCH' : 'NO_MATCH',
          '정규화된 응답을 승인 답안 및 모범 답안과 완전 일치 비교',
          normalizeKoreanAnswer(row.response_text).length > 0 ? 1 : 0,
          normalizeKoreanAnswer(row.response_text).length > 0 ? 'PRESENT' : 'EMPTY', '응답 텍스트 존재 여부'],
      );
      const price = await client.query<{ input_per_million: string; output_per_million: string; currency: string; krw_exchange_rate: string | null }>(
        `select input_per_million, output_per_million, currency, krw_exchange_rate
         from price_profiles where version = $1 and provider_key = $2 and $3 like model_pattern
         order by valid_from desc limit 1`, [row.price_profile_version, row.provider_key, row.model_id],
      );
      if (price.rows[0] && row.input_tokens != null && row.output_tokens != null) {
        const native = tokenCost({ inputTokens: row.input_tokens, outputTokens: row.output_tokens, inputPerMillion: Number(price.rows[0].input_per_million), outputPerMillion: Number(price.rows[0].output_per_million) });
        await client.query('update model_responses set cost_native = $2, cost_currency = $3, cost_krw = $4 where id = $1',
          [row.response_id, native, price.rows[0].currency, price.rows[0].krw_exchange_rate ? native * Number(price.rows[0].krw_exchange_rate) : null]);
      }
    }
    const locked = await client.query<{ state: string }>('select state from benchmark_runs where id = $1 for update', [runId]);
    if (locked.rows[0]?.state === 'SCORING') {
      await client.query("update benchmark_runs set state = 'COMPLETED', completed_at = now(), updated_at = now() where id = $1", [runId]);
      await client.query(`insert into job_events(aggregate_type, aggregate_id, event_type, payload) values ('benchmark_run',$1,'RUN_COMPLETED',$2::jsonb)`, [runId, JSON.stringify({ scoredResponses: rows.rowCount ?? 0 })]);
    }
  });
  return { scoredResponses: rows.rowCount ?? 0 };
}
