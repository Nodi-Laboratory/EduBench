import { z } from "zod";
import { exactMatch, judgeMetricBatches, normalizeJudgeEvidence, normalizeJudgeScoreValue, normalizeJudgeText, normalizeKoreanAnswer, requiredMetricsForQuestion, selectJudgeScore, tokenCost } from "@/domain/scoring";
import { prerequisiteMetricRubrics } from '@/domain/prerequisite-benchmark';
import { db } from "@/server/db/pool";
import { withTransaction } from "@/server/db/transaction";
import { createProviderRegistry } from "@/server/providers/registry";

const judgmentSchema = z.object({
  scores: z.array(
    z.object({
      metricKey: z.string(),
      value: z.preprocess(normalizeJudgeScoreValue, z.number().min(0).max(1)),
      label: z.preprocess((value) => normalizeJudgeText(value, 'SCORED'), z.string()),
      rationale: z.preprocess((value) => normalizeJudgeText(value, '채점 모델이 설명을 생략했습니다.'), z.string()),
      evidence: z.preprocess(
        normalizeJudgeEvidence,
        z.array(
          z.object({
            claim: z.string().optional(),
            quote: z.string().optional(),
            chunkId: z.string().optional(),
          }),
        )).default([]),
    }),
  ),
});
function extractObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("JUDGE_PARSE_FAILED: 채점 응답에 JSON 객체가 없습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

type ScoreRow = {
  response_id: string;
  response_text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  score_profile_id: string;
  price_profile_version: string;
  provider_key: string;
  model_id: string;
  question_text: string;
  answer_text: string;
  accepted_answers: unknown;
  scoring_criteria: unknown;
  quality_scores: unknown;
  evidence_mode: string;
  evidence: unknown;
  metrics: unknown;
  rubric_prompt: string | null;
  judge_provider: string | null;
  judge_model: string | null;
};

export async function scoreRun(
  runId: string,
): Promise<{ scoredResponses: number }> {
  const rows = await db.query<ScoreRow>(
    `select mr.id response_id,mr.response_text,mr.input_tokens,mr.output_tokens,
    br.score_profile_id,br.price_profile_version,rm.provider_key,rm.model_id,q.evidence_mode,
    qr.question_text,qr.answer_text,qr.accepted_answers,qr.scoring_criteria,qr.quality_scores,
    sp.metrics,sp.rubric_prompt,sp.judge_provider,sp.judge_model,
    coalesce((select jsonb_agg(jsonb_build_object('chunkId',qe.source_chunk_id,'quote',qe.quote_text) order by qe.ordinal) from question_evidence qe where qe.question_id=ri.question_id and qe.question_revision=ri.question_revision),'[]'::jsonb) evidence
    from benchmark_runs br join score_profiles sp on sp.id=br.score_profile_id join run_items ri on ri.benchmark_run_id=br.id
    join run_models rm on rm.id=ri.run_model_id join model_responses mr on mr.run_item_id=ri.id and not mr.ignored_after_cancel
    join questions q on q.id=ri.question_id join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision where br.id=$1`,
    [runId],
  );
  const expectedScorePairs = rows.rows.reduce((total, row) => {
    const profileMetrics = Array.isArray(row.metrics) ? row.metrics.map(String) : [];
    return total + requiredMetricsForQuestion(profileMetrics, row.quality_scores).length;
  }, 0);
  const registry = createProviderRegistry();
  let scoredResponses = 0;
  for (const row of rows.rows) {
    const profileMetrics = Array.isArray(row.metrics)
      ? row.metrics.map(String)
      : [];
    const required = requiredMetricsForQuestion(profileMetrics, row.quality_scores);
    const existing = await db.query<{ metric_key: string }>(
      "select metric_key from scores where model_response_id=$1 and score_profile_id=$2",
      [row.response_id, row.score_profile_id],
    );
    const missing = new Set(
      required.filter(
        (metric) =>
          !existing.rows.some((stored) => stored.metric_key === metric),
      ),
    );
    const accepted = Array.isArray(row.accepted_answers)
      ? row.accepted_answers.map(String)
      : [];
    accepted.push(row.answer_text);
    await withTransaction(async (client) => {
      if (missing.has("exact_match")) {
        const value = exactMatch(row.response_text, accepted);
        await client.query(
          `insert into scores(model_response_id,score_profile_id,metric_key,value,label,rationale) values($1,$2,'exact_match',$3,$4,'정규화된 응답을 승인 답안 및 모범 답안과 완전 일치 비교') on conflict do nothing`,
          [
            row.response_id,
            row.score_profile_id,
            value,
            value ? "MATCH" : "NO_MATCH",
          ],
        );
      }
      if (missing.has("response_present")) {
        const value =
          normalizeKoreanAnswer(row.response_text).length > 0 ? 1 : 0;
        await client.query(
          `insert into scores(model_response_id,score_profile_id,metric_key,value,label,rationale) values($1,$2,'response_present',$3,$4,'응답 텍스트 존재 여부') on conflict do nothing`,
          [
            row.response_id,
            row.score_profile_id,
            value,
            value ? "PRESENT" : "EMPTY",
          ],
        );
      }
    });
    const judgeMetrics = required.filter(
      (metric) =>
        missing.has(metric) &&
        !["exact_match", "response_present"].includes(metric),
    );
    if (judgeMetrics.length) {
      if (!row.judge_provider)
        throw new Error(
          `SCORING_JUDGE_NOT_CONFIGURED: ${judgeMetrics.join(",")} 지표에는 judge_provider가 필요합니다.`,
        );
      const judge = registry.get(row.judge_provider);
      if (!judge)
        throw new Error(
          `SCORING_JUDGE_NOT_CONFIGURED: ${row.judge_provider} 환경변수가 필요합니다.`,
        );
      const requestJudgment = async (metrics: string[]) => {
        const response = await judge.generate({
          system:
            "EDUBENCH_JUDGE_JSON. 지정된 metricKey만 빠짐없이 채점한다. 모델 이름을 보지 말고 제공된 루브릭과 교과서 근거만으로 절대평가한다.",
          prompt: JSON.stringify({
            requiredMetrics: metrics,
            instruction: `scores 배열에 다음 metricKey를 각각 정확히 한 번씩 반환한다: ${metrics.join(', ')}. 다른 지표는 반환하지 않는다.`,
            rubricPrompt: row.rubric_prompt,
            question: row.question_text,
            referenceAnswer: row.answer_text,
            acceptedAnswers: accepted,
            scoringCriteria: row.scoring_criteria,
            benchmarkDesign: row.quality_scores && typeof row.quality_scores === 'object'
              ? (row.quality_scores as Record<string, unknown>).benchmarkDesign ?? null : null,
            prerequisiteMetricRubrics,
            evidenceMode: row.evidence_mode,
            textbookEvidence: row.evidence,
            candidateResponse: row.response_text,
            outputSchema: {
              scores: metrics.map((metricKey) => ({ metricKey, value: "0..1", label: "short", rationale: "Korean explanation", evidence: [] })),
            },
          }),
          maxOutputTokens: Number(process.env.JUDGE_MAX_OUTPUT_TOKENS ?? 8192),
          temperature: 0,
        });
        const judgment = judgmentSchema.parse(extractObject(response.text));
        return { response, scores: judgment.scores };
      };
      const persistScore = async (metric: string, score: z.infer<typeof judgmentSchema>['scores'][number], requestId: string | null | undefined) => {
        await withTransaction(async (client) => {
          await client.query(
            `insert into scores(model_response_id,score_profile_id,metric_key,value,label,rationale,evidence,judge_provider,judge_model,judge_request_id) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) on conflict do nothing`,
            [
              row.response_id,
              row.score_profile_id,
              metric,
              score.value,
              score.label,
              score.rationale,
              JSON.stringify(score.evidence),
              row.judge_provider,
              judge.modelId,
              requestId,
            ],
          );
        });
      };
      for (const metrics of judgeMetricBatches(judgeMetrics)) {
        const batch = await requestJudgment(metrics);
        const unresolved: string[] = [];
        for (const metric of metrics) {
          const score = batch.scores.find((candidate) => candidate.metricKey === metric);
          if (score) await persistScore(metric, score, batch.response.requestId);
          else unresolved.push(metric);
        }
        for (const metric of unresolved) {
          const fallback = await requestJudgment([metric]);
          const score = selectJudgeScore(metric, fallback.scores);
          if (!score) throw new Error(`JUDGE_METRIC_MISSING: ${metric} 지표가 채점 응답에 없습니다.`);
          await persistScore(metric, score, fallback.response.requestId);
        }
      }
    }
    const price = await db.query<{
      input_per_million: string;
      output_per_million: string;
      currency: string;
      krw_exchange_rate: string | null;
    }>(
      `select input_per_million,output_per_million,currency,krw_exchange_rate from price_profiles where version=$1 and provider_key=$2 and $3 like model_pattern order by valid_from desc limit 1`,
      [row.price_profile_version, row.provider_key, row.model_id],
    );
    if (
      price.rows[0] &&
      row.input_tokens != null &&
      row.output_tokens != null
    ) {
      const native = tokenCost({
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        inputPerMillion: Number(price.rows[0].input_per_million),
        outputPerMillion: Number(price.rows[0].output_per_million),
      });
      await db.query(
        "update model_responses set cost_native=$2,cost_currency=$3,cost_krw=$4 where id=$1",
        [
          row.response_id,
          native,
          price.rows[0].currency,
          price.rows[0].krw_exchange_rate
            ? native * Number(price.rows[0].krw_exchange_rate)
            : null,
        ],
      );
    }
    scoredResponses += 1;
  }
  await withTransaction(async (client) => {
    const locked = await client.query<{
      state: string;
      responses: string;
      score_pairs: string;
    }>(
      `select br.state,
       (select count(*) from model_responses mr join run_items ri on ri.id=mr.run_item_id where ri.benchmark_run_id=br.id and not mr.ignored_after_cancel)::text responses,
       (select count(distinct s.model_response_id::text||':'||s.metric_key) from scores s join model_responses mr on mr.id=s.model_response_id join run_items ri on ri.id=mr.run_item_id where ri.benchmark_run_id=br.id)::text score_pairs
       from benchmark_runs br where br.id=$1 for update of br`,
      [runId],
    );
    const run = locked.rows[0];
    if (run?.state === "SCORING") {
      if (Number(run.score_pairs) !== expectedScorePairs)
        throw new Error(
          "SCORING_INCOMPLETE: 모든 응답의 필수 지표가 저장되지 않았습니다.",
        );
      await client.query(
        "update benchmark_runs set state='COMPLETED',completed_at=now(),last_scoring_error=null,updated_at=now() where id=$1",
        [runId],
      );
      await client.query(
        `insert into job_events(aggregate_type,aggregate_id,event_type,payload) values('benchmark_run',$1,'RUN_COMPLETED',$2::jsonb)`,
        [
          runId,
          JSON.stringify({
            state: "COMPLETED",
            scoredResponses,
            requiredScorePairs: expectedScorePairs,
          }),
        ],
      );
    }
  });
  return { scoredResponses };
}

export async function recordScoringFailure(runId: string, error: unknown): Promise<{ attempts: number; state: string }> {
  const message = (error instanceof Error ? error.message : '알 수 없는 채점 오류').slice(0, 1000);
  const code = message.split(':', 1)[0] || 'SCORING_FAILED';
  return withTransaction(async (client) => {
    const locked = await client.query<{ state: string; last_scoring_error: { attempts?: number } | null }>(
      'select state,last_scoring_error from benchmark_runs where id=$1 for update', [runId],
    );
    const previous = Number(locked.rows[0]?.last_scoring_error?.attempts ?? 0);
    const attempts = previous + 1;
    const state = attempts >= 3 ? 'FAILED' : 'SCORING';
    await client.query(
      `update benchmark_runs set state=$2,last_scoring_error=$3::jsonb,updated_at=now() where id=$1`,
      [runId, state, JSON.stringify({ code, message, attempts, at: new Date().toISOString() })],
    );
    await client.query(
      `insert into job_events(aggregate_type,aggregate_id,event_type,payload)
       values('benchmark_run',$1,'RUN_SCORING_FAILED',$2::jsonb)`,
      [runId, JSON.stringify({ code, message, attempts, state })],
    );
    return { attempts, state };
  });
}
