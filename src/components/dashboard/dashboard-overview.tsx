import Link from 'next/link';
import { AlertCircle, ArrowRight, BookOpenCheck, Play, RefreshCw } from 'lucide-react';

type LatestRun = { id: string; public_id: string; title: string; state: string; total_items: number; eligible_response_count: number; execution_completed_items: number; failed_items: number };
type ModelRow = { display_name: string; model_id: string; total: string; done: string; failed: string; latency: string | null; tokens: string | null; cost: string | null };
type RecentRun = { id: string; public_id: string; title: string; state: string; eligible_response_count: number; execution_completed_items: number; total_items: number };
const neutralModels: ModelRow[] = ['EXAONE','Gemini','Upstage'].map((display_name) => ({ display_name, model_id: '환경변수에서 모델 ID 로드', total: '0', done: '0', failed: '0', latency: null, tokens: null, cost: null }));

export function DashboardOverview({ approved = 0, readySources = 0, attention = 0, latest = null, models = neutralModels, recent = [] }: { approved?: number; readySources?: number; attention?: number; latest?: LatestRun | null; models?: ModelRow[]; recent?: RecentRun[] } = {}) {
  const percent = latest?.total_items ? (latest.eligible_response_count / latest.total_items) * 100 : 0;
  return (
    <div className="dashboard-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow-row">
            <span className="eyebrow">OPERATIONS / OVERVIEW</span>
          </div>
          <h1>벤치마크 운영 현황</h1>
          <p>교과서 준비부터 실제 모델 실행과 결과 산출까지 한 화면에서 추적합니다.</p>
        </div>
        <Link className="button primary" href="/runs">
          <Play size={16} aria-hidden="true" /> 새 벤치마크 실행
        </Link>
      </header>

      <section className="metric-grid" aria-label="운영 핵심 지표">
        <article className="metric-card metric-feature">
          <div className="metric-label"><span>평가 가능 응답</span><b>RUN</b></div>
          <div className="metric-value mono">{latest?.eligible_response_count ?? 0} <small>/ {latest?.total_items ?? 0}</small></div>
          <div className="metric-footer"><span className={`status-dot ${latest?.state === 'RUNNING' ? '' : 'idle'}`} /> {latest ? `${latest.public_id} · ${latest.state} · 실행 성공 ${latest.execution_completed_items}` : '아직 생성된 실행이 없습니다'}</div>
        </article>
        <article className="metric-card">
          <div className="metric-label"><span>실제 승인 문항</span><b>DATASET</b></div>
          <div className="metric-value mono">{approved} <small>개</small></div>
          <div className="metric-footer">데이터셋 버전에 포함 가능한 실제 문항</div>
        </article>
        <article className="metric-card">
          <div className="metric-label"><span>준비된 교과서</span><b>SOURCES</b></div>
          <div className="metric-value mono">{readySources} <small>개</small></div>
          <div className="metric-footer">Parse·청크·임베딩 완료 기준</div>
        </article>
        <article className="metric-card danger-edge">
          <div className="metric-label"><span>조치 필요</span><b>ATTENTION</b></div>
          <div className="metric-value mono">{attention} <small>건</small></div>
          <div className="metric-footer">실패 또는 검수 대기 항목</div>
        </article>
      </section>

      <div className="dashboard-layout">
        <section className="panel run-panel">
          <div className="panel-heading">
            <div>
              <span className="section-index mono">01</span>
              <h2>모델 실행 매트릭스</h2>
            </div>
            <Link href="/runs" className="text-link">실행 컨트롤러 <ArrowRight size={14} /></Link>
          </div>
          <div className="run-summary">
            <div>
              <strong className="mono">{percent.toFixed(1)}%</strong>
              <span>전체 {latest?.total_items ?? 0}호출 중 평가 응답 {latest?.eligible_response_count ?? 0}</span>
            </div>
            <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
            <span className="status-chip muted"><span className={`status-dot ${latest?.state === 'RUNNING' ? '' : 'idle'}`} /> {latest?.state ?? '실행 전'}</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table provider-table">
              <thead>
                <tr><th>제공사</th><th>진행</th><th className="numeric">성공 / 실패</th><th className="numeric">평균 지연</th><th className="numeric">토큰</th><th className="numeric">예상 비용</th></tr>
              </thead>
              <tbody>
                {models.map((provider, index) => (
                  <tr key={`${provider.display_name}-${index}`}>
                    <td><span className={`model-key model-${index + 1}`} /><div><strong>{provider.display_name}</strong><small>{provider.model_id}</small></div></td>
                    <td><div className="cell-progress"><span className="mono">{provider.done} / {provider.total}</span><div><i style={{ width: `${Number(provider.total) ? Number(provider.done)/Number(provider.total)*100 : 0}%` }} /></div></div></td>
                    <td className="numeric mono">{provider.done} / {provider.failed}</td><td className="numeric mono">{provider.latency ? `${Math.round(Number(provider.latency))} ms` : '—'}</td><td className="numeric mono">{provider.tokens ?? '—'}</td><td className="numeric mono">{provider.cost ? `₩${Number(provider.cost).toLocaleString('ko-KR')}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="dashboard-rail">
          <section className="panel composition-panel">
            <div className="panel-heading compact"><div><span className="section-index mono">02</span><h2>실제 데이터 흐름</h2></div></div>
            <div className="capability-list">
              <div><div><span>교과서 등록·파싱</span><strong className="mono">{readySources}</strong></div></div>
              <div><div><span>질문 검수·승인</span><strong className="mono">{approved}</strong></div></div>
              <div><div><span>실행 가능한 데이터셋</span><strong className="mono">{approved > 0 ? 'READY' : 'WAIT'}</strong></div></div>
            </div>
          </section>

          <section className="panel action-panel">
            <div className="panel-heading compact"><div><span className="section-index mono">03</span><h2>다음 작업</h2></div></div>
            <Link href="/sources" className="action-row">
              <BookOpenCheck size={18} /><div><strong>교과서 자료 등록</strong><span>PDF를 Parse·청크·임베딩합니다.</span></div><ArrowRight size={15} />
            </Link>
            <Link href="/review" className="action-row">
              <AlertCircle size={18} /><div><strong>질문 검수</strong><span>생성 문항의 근거와 편향을 확인합니다.</span></div><ArrowRight size={15} />
            </Link>
          </section>
        </aside>
      </div>

      <section className="panel recent-panel">
        <div className="panel-heading">
          <div><span className="section-index mono">04</span><h2>최근 실행</h2></div>
          <button className="icon-text-button" type="button"><RefreshCw size={14} /> 새로고침</button>
        </div>
        {recent.length === 0 ? <div className="empty-table">
          <span className="mono">NO RUN RECORDS</span>
          <strong>아직 벤치마크 실행이 없습니다.</strong>
          <p>문항 데이터셋 버전을 확정한 뒤 새 실행을 생성하세요.</p>
        </div> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>실행 ID</th><th>제목</th><th>상태</th><th className="numeric">평가 응답 / 전체</th></tr></thead><tbody>{recent.map((run) => <tr key={run.id}><td><Link className="text-link mono" href={`/runs/${run.id}`}>{run.public_id}</Link></td><td>{run.title}</td><td><span className={`state-label state-${run.state}`}>{run.state}</span></td><td className="numeric mono">{run.eligible_response_count}/{run.total_items}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
