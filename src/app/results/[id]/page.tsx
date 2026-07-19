import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, FileJson } from 'lucide-react';
import { db } from '@/server/db/pool';

export const dynamic = 'force-dynamic';

export default async function ResultDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run, models, capabilities] = await Promise.all([
    db.query<{ public_id: string; title: string; state: string; dataset_version: string; score_version: string; total_items: number; completed_items: number; failed_items: number; parameters: { sample_data?: boolean } }>(
      `select br.public_id, br.title, br.state, br.total_items, br.completed_items, br.failed_items, br.parameters,
       dv.version as dataset_version, sp.version as score_version from benchmark_runs br
       join dataset_versions dv on dv.id = br.dataset_version_id join score_profiles sp on sp.id = br.score_profile_id where br.id = $1`, [id]),
    db.query<{ blind_id: string; display_name: string; model_id: string; responses: string; exact_match: string | null; latency: string | null; input_tokens: string | null; output_tokens: string | null; cost_krw: string | null }>(
      `select rm.blind_id, rm.display_name, rm.model_id, count(mr.id)::text as responses,
       avg(s.value) filter (where s.metric_key = 'exact_match')::text as exact_match,
       avg(mr.latency_ms)::text as latency, sum(mr.input_tokens)::text as input_tokens,
       sum(mr.output_tokens)::text as output_tokens, sum(mr.cost_krw)::text as cost_krw
       from run_models rm left join run_items ri on ri.run_model_id = rm.id left join model_responses mr on mr.run_item_id = ri.id
       left join scores s on s.model_response_id = mr.id where rm.benchmark_run_id = $1 group by rm.id order by rm.blind_id`, [id]),
    db.query<{ blind_id: string; purpose: string; score: string; n: string }>(
      `select rm.blind_id, q.purpose, avg(s.value)::text as score, count(s.id)::text as n
       from run_items ri join run_models rm on rm.id = ri.run_model_id join questions q on q.id = ri.question_id
       join model_responses mr on mr.run_item_id = ri.id join scores s on s.model_response_id = mr.id and s.metric_key = 'exact_match'
       where ri.benchmark_run_id = $1 group by rm.blind_id, q.purpose order by q.purpose, rm.blind_id`, [id]),
  ]);
  if (!run.rows[0]) notFound(); const summary = run.rows[0];
  return <div className="workflow-page"><header className="page-heading"><div><Link className="text-link" href="/results"><ArrowLeft size={13}/> 결과 목록</Link><span className="eyebrow mono">{summary.public_id}</span><h1>{summary.title}</h1><p>{summary.dataset_version} · {summary.score_version} · 실제 저장 응답 {summary.completed_items}건</p></div><div className="heading-actions"><a className="button" href={`/api/results/${id}/export?format=json`}><FileJson size={14}/> JSON</a><a className="button primary" href={`/api/results/${id}/export?format=csv`}><Download size={14}/> CSV 근거표</a></div></header>{summary.parameters?.sample_data && <p className="result-warning">샘플 실행은 기능 검증 전용이며 공식 소개 자료의 근거로 사용할 수 없습니다.</p>}<section className="metric-grid"><div className="metric-card metric-feature"><div className="metric-label">응답 완료</div><div className="metric-value mono">{summary.completed_items}<small> / {summary.total_items}</small></div></div><div className="metric-card"><div className="metric-label">실패 항목</div><div className="metric-value mono">{summary.failed_items}</div></div><div className="metric-card"><div className="metric-label">비교 모델</div><div className="metric-value mono">{models.rowCount}</div></div><div className="metric-card"><div className="metric-label">실행 상태</div><div className="metric-value mono">{summary.state}</div></div></section><section className="panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>모델별 실제 집계</h2></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>블라인드</th><th>모델</th><th className="numeric">응답</th><th className="numeric">완전 일치</th><th className="numeric">평균 지연</th><th className="numeric">입력 토큰</th><th className="numeric">출력 토큰</th><th className="numeric">비용(KRW)</th></tr></thead><tbody>{models.rows.map((model) => <tr key={model.blind_id}><td className="mono"><strong>{model.blind_id}</strong></td><td>{model.display_name}<br/><small className="mono">{model.model_id}</small></td><td className="numeric mono">{model.responses}</td><td className="numeric mono">{model.exact_match == null ? '—' : `${(Number(model.exact_match)*100).toFixed(1)}%`}</td><td className="numeric mono">{model.latency == null ? '—' : `${Math.round(Number(model.latency))} ms`}</td><td className="numeric mono">{model.input_tokens ?? '—'}</td><td className="numeric mono">{model.output_tokens ?? '—'}</td><td className="numeric mono">{model.cost_krw == null ? '—' : Number(model.cost_krw).toLocaleString('ko-KR')}</td></tr>)}</tbody></table></div></section><section className="panel recent-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>역량별 완전 일치</h2></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>역량</th><th>블라인드 모델</th><th className="numeric">표본</th><th className="numeric">점수</th></tr></thead><tbody>{capabilities.rows.map((row) => <tr key={`${row.purpose}-${row.blind_id}`}><td>{row.purpose}</td><td className="mono">{row.blind_id}</td><td className="numeric mono">{row.n}</td><td className="numeric mono">{(Number(row.score)*100).toFixed(1)}%</td></tr>)}</tbody></table></div></section></div>;
}
