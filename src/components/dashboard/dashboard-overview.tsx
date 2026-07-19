import Link from 'next/link';
import { AlertCircle, ArrowRight, BookOpenCheck, Play, RefreshCw } from 'lucide-react';

const providers = [
  { name: 'EXAONE', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
  { name: 'Gemini', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
  { name: 'Claude', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
  { name: 'OpenAI', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
  { name: 'Upstage', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
  { name: 'KT Mi:dm', model: '환경변수에서 모델 ID 로드', done: 0, total: 500, latency: '—', tokens: '—', cost: '—' },
] as const;

const capabilities = [
  ['핵심 개념 이해', 150],
  ['개념 적용·문제풀이', 120],
  ['여러 단원 연결 추론', 80],
  ['학생 수준별 설명', 80],
  ['오개념·주장 교정', 70],
] as const;

export function DashboardOverview() {
  return (
    <div className="dashboard-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow-row">
            <span className="eyebrow">OPERATIONS / OVERVIEW</span>
            <span className="sample-badge">초기 작업공간</span>
          </div>
          <h1>벤치마크 운영 현황</h1>
          <p>교과서 준비부터 6개 모델 실행과 결과 산출까지 한 화면에서 추적합니다.</p>
        </div>
        <Link className="button primary" href="/runs/new">
          <Play size={16} aria-hidden="true" /> 새 벤치마크 실행
        </Link>
      </header>

      <section className="metric-grid" aria-label="운영 핵심 지표">
        <article className="metric-card metric-feature">
          <div className="metric-label"><span>최근 실행</span><b>RUN</b></div>
          <div className="metric-value mono">0 <small>/ 3,000</small></div>
          <div className="metric-footer"><span className="status-dot idle" /> 아직 생성된 실행이 없습니다</div>
        </article>
        <article className="metric-card">
          <div className="metric-label"><span>승인된 문항</span><b>DATASET</b></div>
          <div className="metric-value mono">0 <small>/ 500</small></div>
          <div className="metric-footer">목표 프로필 대비 <strong>0%</strong></div>
        </article>
        <article className="metric-card">
          <div className="metric-label"><span>준비된 교과서</span><b>SOURCES</b></div>
          <div className="metric-value mono">0 <small>개</small></div>
          <div className="metric-footer">Parse·청크·임베딩 완료 기준</div>
        </article>
        <article className="metric-card danger-edge">
          <div className="metric-label"><span>조치 필요</span><b>ATTENTION</b></div>
          <div className="metric-value mono">0 <small>건</small></div>
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
              <strong className="mono">0.0%</strong>
              <span>전체 3,000호출</span>
            </div>
            <div className="progress-track"><span style={{ width: '0%' }} /></div>
            <span className="status-chip muted"><span className="status-dot idle" /> 실행 전</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table provider-table">
              <thead>
                <tr><th>제공사</th><th>진행</th><th className="numeric">성공 / 실패</th><th className="numeric">평균 지연</th><th className="numeric">토큰</th><th className="numeric">예상 비용</th></tr>
              </thead>
              <tbody>
                {providers.map((provider, index) => (
                  <tr key={provider.name}>
                    <td><span className={`model-key model-${index + 1}`} /><div><strong>{provider.name}</strong><small>{provider.model}</small></div></td>
                    <td><div className="cell-progress"><span className="mono">{provider.done} / {provider.total}</span><div><i style={{ width: '0%' }} /></div></div></td>
                    <td className="numeric mono">0 / 0</td><td className="numeric mono">{provider.latency}</td><td className="numeric mono">{provider.tokens}</td><td className="numeric mono">{provider.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="dashboard-rail">
          <section className="panel composition-panel">
            <div className="panel-heading compact"><div><span className="section-index mono">02</span><h2>500문항 목표 구성</h2></div></div>
            <div className="mode-strip">
              <span>근거 제공 400</span>
              <span>폐쇄형 75</span>
              <span>근거 부족 판단 25</span>
            </div>
            <div className="capability-list">
              {capabilities.map(([label, count]) => (
                <div key={label}>
                  <div><span>{label}</span><strong className="mono">{count}</strong></div>
                  <div className="progress-track thin"><span style={{ width: `${(count / 150) * 100}%` }} /></div>
                </div>
              ))}
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
        <div className="empty-table">
          <span className="mono">NO RUN RECORDS</span>
          <strong>아직 벤치마크 실행이 없습니다.</strong>
          <p>문항 데이터셋 버전을 확정한 뒤 새 실행을 생성하세요.</p>
        </div>
      </section>
    </div>
  );
}
