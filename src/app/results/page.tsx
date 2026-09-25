import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BarChart3 } from 'lucide-react';
import {
  benchmarkRetrievalModeMetadata,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '결과 분석' };
export const dynamic = 'force-dynamic';

export default async function ResultsPage() {
  const runs = await db.query<{ id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; retrieval_modes:StoredBenchmarkRetrievalMode[]; completed_at: string | null }>(
    `select br.id, br.public_id, br.title, br.state, br.total_items,
       count(distinct mr.id)::int completed_items, br.failed_items,
       br.retrieval_modes,
       br.completed_at::text
     from benchmark_runs br left join run_items ri on ri.benchmark_run_id = br.id
     left join eligible_model_responses mr on mr.run_item_id = ri.id
     where br.state in ('COMPLETED','SCORING','FAILED','CANCELLED')
     group by br.id order by br.created_at desc`,
  );
  return <div className="workflow-page"><header className="page-heading"><div><span className="eyebrow">RESULTS / EVIDENCE</span><h1>결과 분석</h1><p>실제 저장된 응답과 채점값만 집계하며, 실행 명세과 원문 근거를 함께 내보냅니다.</p></div></header><section className="panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>분석 가능한 실행</h2></div><span className="count-label mono">{runs.rowCount} RUNS</span></div>{!runs.rowCount ? <div className="table-empty"><BarChart3 size={22}/><strong>분석할 실행 결과가 없습니다.</strong><span>벤치마크 실행이 완료되면 여기에 실제 결과가 표시됩니다.</span></div> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>실행 ID</th><th>제목</th><th>검색 조건</th><th>상태</th><th className="numeric">완료</th><th className="numeric">실패</th><th>완료 시각</th><th /></tr></thead><tbody>{runs.rows.map((run) => <tr key={run.id}><td className="mono">{run.public_id}</td><td><strong>{run.title}</strong></td><td>{run.retrieval_modes.map((mode) => mode === 'LEGACY_EVIDENCE' ? '기존 근거' : benchmarkRetrievalModeMetadata[mode].shortLabel).join(' · ')}</td><td><span className={`state-label state-${run.state}`}>{run.state}</span></td><td className="numeric mono">{run.completed_items}/{run.total_items}</td><td className="numeric mono">{run.failed_items}</td><td className="mono">{run.completed_at?.slice(0,16).replace('T',' ') ?? '—'}</td><td><Link className="icon-button" href={`/results/${run.id}`}><ArrowRight size={14}/></Link></td></tr>)}</tbody></table></div>}</section></div>;
}
