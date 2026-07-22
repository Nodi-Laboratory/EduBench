import { prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';
import { db } from '@/server/db/pool';

export async function getRunDetails(runId: string) {
  const [runResult, modelResult, itemResult] = await Promise.all([
    db.query(`select br.*,dv.version dataset_version,sp.version score_version,
      sp.title score_title,sp.metrics score_metrics,sp.rubric_prompt,sp.judge_provider,
      sp.judge_model,sp.content_hash score_content_hash
      from benchmark_runs br join dataset_versions dv on dv.id=br.dataset_version_id
      join score_profiles sp on sp.id=br.score_profile_id where br.id=$1`, [runId]),
    db.query(`select id,provider_key,display_name,blind_id,model_id,protocol,concurrency
      from run_models where benchmark_run_id=$1 order by blind_id`, [runId]),
    db.query(`select ri.id,ri.state,ri.attempts,ri.max_attempts,ri.error_code,ri.error_message,
      ri.request_snapshot,ri.started_at,ri.completed_at,br.system_prompt,q.public_id question_public_id,
      q.purpose,q.difficulty,q.evidence_mode,qr.question_text,qr.answer_options,
      rm.provider_key,rm.display_name,rm.model_id,rm.blind_id,
      coalesce((select jsonb_agg(jsonb_build_object('content',sc.content,'quote',qe.quote_text,'pageStart',sc.page_start) order by qe.ordinal)
        from question_evidence qe join source_chunks sc on sc.id=qe.source_chunk_id
        where qe.question_id=ri.question_id and qe.question_revision=ri.question_revision),'[]'::jsonb) question_evidence,
      mr.id response_id,mr.response_text,mr.raw_response,mr.provider_request_id,
      mr.finish_reason,mr.input_tokens,mr.output_tokens,mr.latency_ms,mr.retry_history,
      coalesce((select jsonb_agg(jsonb_build_object(
        'metricKey',s.metric_key,'value',s.value,'label',s.label,'rationale',s.rationale,
        'evidence',s.evidence,'judgeProvider',s.judge_provider,'judgeModel',s.judge_model,
        'judgeRequestId',s.judge_request_id) order by s.metric_key)
        from scores s where s.model_response_id=mr.id),'[]'::jsonb) scores
      from run_items ri join benchmark_runs br on br.id=ri.benchmark_run_id join run_models rm on rm.id=ri.run_model_id
      join questions q on q.id=ri.question_id
      join question_revisions qr on qr.question_id=ri.question_id and qr.revision=ri.question_revision
      left join lateral (select * from model_responses where run_item_id=ri.id
        order by attempt desc,created_at desc limit 1) mr on true
      where ri.benchmark_run_id=$1 order by q.public_id,rm.blind_id`, [runId]),
  ]);
  const row = runResult.rows[0];
  if (!row) return null;
  return {
    run: row,
    models: modelResult.rows,
    profile: {
      version: row.score_version, title: row.score_title,
      metrics: Array.isArray(row.score_metrics) ? row.score_metrics.map(String) : [],
      rubricPrompt: row.rubric_prompt ?? '', judgeProvider: row.judge_provider,
      judgeModel: row.judge_model, contentHash: row.score_content_hash,
      dynamicMetrics: [...prerequisiteScoreMetrics],
    },
    items: itemResult.rows.map((item) => {
      const evidenceRows = Array.isArray(item.question_evidence) ? item.question_evidence as Array<{ content?: string; quote?: string | null; pageStart?: number | null }> : [];
      const evidence = evidenceRows.map((entry, index) => `[근거 ${index + 1}${entry.pageStart ? ` · p.${entry.pageStart}` : ''}]\n${entry.quote ?? entry.content ?? ''}`);
      const options = Array.isArray(item.answer_options) && item.answer_options.length
        ? `\n\n선택지:\n${item.answer_options.map((option: unknown, index: number) => `${index + 1}. ${String(option)}`).join('\n')}` : '';
      const evidenceBlock = evidence.length
        ? `다음 근거만 사용하십시오.\n\n${evidence.join('\n\n')}`
        : item.evidence_mode === 'GROUNDED' ? '연결된 교과서 근거가 없습니다. 근거 부족을 명시하십시오.' : '외부 검색 없이 답하십시오.';
      const request = item.request_snapshot ?? {
        system: item.system_prompt,
        prompt: `${evidenceBlock}\n\n[질문]\n${item.question_text}${options}`,
        providerKey: item.provider_key, modelId: item.model_id, evidence,
        question: item.question_text, options: item.answer_options, reconstructed: true,
      };
      return ({
      id: item.id, state: item.state, attempts: item.attempts, maxAttempts: item.max_attempts,
      errorCode: item.error_code, errorMessage: item.error_message,
      questionPublicId: item.question_public_id, questionText: item.question_text,
      answerOptions: item.answer_options, purpose: item.purpose, difficulty: item.difficulty,
      evidenceMode: item.evidence_mode, providerKey: item.provider_key,
      displayName: item.display_name, modelId: item.model_id, blindId: item.blind_id,
      request,
      response: item.response_id ? {
        id: item.response_id, text: item.response_text, raw: item.raw_response,
        requestId: item.provider_request_id, finishReason: item.finish_reason,
        inputTokens: item.input_tokens, outputTokens: item.output_tokens,
        latencyMs: item.latency_ms, retryHistory: item.retry_history,
      } : null,
      scores: Array.isArray(item.scores) ? item.scores.map((score: Record<string, unknown>) => ({
        ...score, value: score.value == null ? null : Number(score.value),
      })) : [],
      startedAt: item.started_at, completedAt: item.completed_at,
    }); }),
  };
}
