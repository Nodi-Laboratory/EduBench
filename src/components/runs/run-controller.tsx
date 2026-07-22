'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CirclePause, CirclePlay, RefreshCcw, RotateCcw, Square, StopCircle } from 'lucide-react';

type Run = { id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; dataset_version: string; score_version: string; price_profile_version: string; created_at: string; last_scoring_error?: { code?: string; message?: string; attempts?: number } | null };
type Model = { id: string; provider_key?: string; display_name: string; blind_id: string; model_id: string; protocol: string; concurrency: number };
type Profile = { version: string; title: string; metrics: string[]; rubricPrompt: string; judgeProvider: string | null; judgeModel: string | null; contentHash: string; dynamicMetrics: string[] };
type Score = { metricKey: string; value: number | null; label: string | null; rationale: string | null; evidence: unknown; judgeProvider?: string | null; judgeModel?: string | null };
type RunItem = { id: string; state: string; attempts: number; maxAttempts?: number; errorCode: string | null; errorMessage: string | null; questionPublicId: string; questionText: string; providerKey: string; displayName: string; modelId: string; blindId: string; request: Record<string, unknown> | null; response: { text: string; raw: unknown; requestId: string | null; finishReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number | null; retryHistory: unknown } | null; scores: Score[] };
type EventRecord = { id: string; type: string; data: Record<string, unknown> };

const metricLabels: Record<string, string> = {
  accuracy:'정확성', faithfulness:'교과서 충실성', completeness:'완결성', curriculum_alignment:'교육과정 정합성',
  student_fit:'학생 수준 적합성', misconception:'오개념 대응', hallucination:'환각 억제', exact_match:'완전 일치',
  response_present:'응답 존재', target_concept_correctness:'목표 개념 정확성', prerequisite_identification:'선수 개념 식별',
  prerequisite_relation_accuracy:'선수 관계 방향 정확성', prerequisite_application:'선수 개념 적용',
  reasoning_chain_completeness:'추론 사슬 완결성', textbook_grounding:'교과서 근거 충실성',
};

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="run-payload">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function RunController({ initialRun, models, profile, initialItems }: {
  initialRun: Run; models: Model[]; profile: Profile; initialItems: RunItem[];
}) {
  const [run, setRun] = useState(initialRun);
  const [items, setItems] = useState(initialItems);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modelFilter, setModelFilter] = useState('ALL');
  const [stateFilter, setStateFilter] = useState('ALL');

  async function refreshDetails() {
    const response = await fetch(`/api/runs/${run.id}/details`);
    if (!response.ok) return;
    const body = await response.json();
    setRun(body.run); setItems(body.items);
  }

  useEffect(() => {
    const source = new EventSource(`/api/runs/${run.id}/events`);
    const types = ['RUN_CREATED','RUN_QUEUED','RUN_STARTED','RUN_PAUSE_REQUESTED','RUN_PAUSED','RUN_STOP_REQUESTED','RUN_ITEM_INTERRUPTED','RUN_STOPPED','RUN_RESUMED','RUN_ITEMS_CLAIMED','RUN_ITEM_COMPLETED','RUN_ITEM_FAILED','RUN_ITEMS_RETRIED','RUN_SCORING_STARTED','RUN_SCORING_FAILED','RUN_SCORING_RETRIED','RUN_COMPLETED','RUN_CANCELLED','RUN_FAILED'];
    for (const type of types) source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>; const data = JSON.parse(message.data);
      setEvents((current) => [...current.slice(-99), { id: message.lastEventId, type, data }]);
      setRun((current) => ({ ...current, state: typeof data.state === 'string' ? data.state : current.state, completed_items: typeof data.completedItems === 'number' ? data.completedItems : current.completed_items, failed_items: typeof data.failedItems === 'number' ? data.failedItems : current.failed_items, total_items: typeof data.totalItems === 'number' ? data.totalItems : current.total_items }));
      void refreshDetails();
    });
    return () => source.close();
  }, [run.id]);

  async function command(value: string) {
    setBusy(true); setNotice('');
    const response = await fetch(`/api/runs/${run.id}/commands`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ command:value }) });
    const body = await response.json();
    if (!response.ok) setNotice(body.message ?? body.code ?? '명령을 처리하지 못했습니다.');
    else {
      if (body.state) setRun((current) => ({ ...current, state:body.state }));
      if (typeof body.retried === 'number') setNotice(`실패 항목 ${body.retried}개를 재실행 대기 상태로 돌렸습니다.`);
      await refreshDetails();
    }
    setBusy(false);
    return response.ok;
  }

  const filteredItems = useMemo(() => items.filter((item) =>
    (modelFilter === 'ALL' || item.providerKey === modelFilter) && (stateFilter === 'ALL' || item.state === stateFilter),
  ), [items, modelFilter, stateFilter]);
  const states = [...new Set(items.map((item) => item.state))];
  const percent = run.total_items ? Math.round(((run.completed_items + run.failed_items) / run.total_items) * 100) : 0;

  return <div className="workflow-page">
    <header className="page-heading"><div><Link className="text-link" href="/runs"><ArrowLeft size={13}/> 실행 목록</Link><span className="eyebrow mono">{run.public_id}</span><h1>{run.title}</h1><p>{run.dataset_version} · {run.score_version} · {run.price_profile_version}</p></div><div className="heading-actions">
      {run.state === 'DRAFT' && <button className="button primary" disabled={busy} onClick={async () => { if (await command('QUEUE')) await command('START'); }}><CirclePlay size={15}/> 실행 시작</button>}
      {run.state === 'RUNNING' && <><button className="button" disabled={busy} onClick={() => command('PAUSE')}><CirclePause size={15}/> 일시정지</button><button className="button" disabled={busy} onClick={() => command('STOP')}><StopCircle size={15}/> 작업 중지</button></>}
      {['PAUSED','STOPPED'].includes(run.state) && <button className="button primary" disabled={busy} onClick={() => command('RESUME')}><CirclePlay size={15}/> 남은 작업 재개</button>}
      {run.failed_items > 0 && <button className="button" disabled={busy} onClick={() => command('RETRY_FAILED')}><RotateCcw size={15}/> 실패 항목 재시도</button>}
      {run.state === 'FAILED' && run.last_scoring_error && <button className="button primary" disabled={busy} onClick={() => command('RETRY_SCORING')}><RotateCcw size={15}/> 채점 재개</button>}
      {['QUEUED','RUNNING','PAUSING','PAUSED','STOPPING','STOPPED'].includes(run.state) && <button className="button danger" disabled={busy} onClick={() => command('CANCEL')}><Square size={14}/> 영구 취소</button>}
    </div></header>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {run.last_scoring_error && <div className="result-warning"><strong>{run.last_scoring_error.code ?? 'SCORING_FAILED'}</strong> {run.last_scoring_error.message} · 시도 {run.last_scoring_error.attempts ?? 1}회</div>}
    <section className="run-control-strip panel"><div><span>STATE</span><strong className="mono">{run.state}</strong></div><div><span>PROGRESS</span><strong className="mono">{run.completed_items + run.failed_items} / {run.total_items}</strong><div className="progress-track"><i style={{width:`${percent}%`}}/></div></div><div><span>SUCCEEDED / FAILED</span><strong className="mono">{run.completed_items} / {run.failed_items}</strong></div><div><span>LIVE EVENT</span><strong><RefreshCcw size={13}/> SSE 연결</strong></div></section>

    <section className="panel run-profile-panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>평가 프로필</h2></div><span className="count-label mono">{profile.version}</span></div><details open><summary><strong>{profile.title}</strong> · {profile.judgeProvider ?? '결정론적'} / {profile.judgeModel ?? '—'}</summary><div className="profile-detail"><p>{profile.rubricPrompt}</p><div className="metric-chip-list">{profile.metrics.map((metric) => <span key={metric}>{metricLabels[metric] ?? metric}<small className="mono">{metric}</small></span>)}</div>{profile.dynamicMetrics.length > 0 && <><h3>선수관계 문항 추가 지표</h3><div className="metric-chip-list">{profile.dynamicMetrics.map((metric) => <span key={metric}>{metricLabels[metric] ?? metric}<small className="mono">{metric}</small></span>)}</div></>}<small className="mono">내용 해시 {profile.contentHash}</small></div></details></section>

    <section className="panel run-items-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>질문별 실행·채점 기록</h2></div><span className="count-label mono">{filteredItems.length} / {items.length} ITEMS</span></div><div className="run-item-filters"><label>모델<select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="ALL">전체</option>{models.map((model) => <option key={model.id} value={model.provider_key ?? model.blind_id}>{model.display_name}</option>)}</select></label><label>상태<select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="ALL">전체</option>{states.map((state) => <option key={state}>{state}</option>)}</select></label></div><div className="run-item-list">{filteredItems.map((item) => <details key={item.id} className={`run-item run-item-${item.state}`}><summary><span className="mono">{item.questionPublicId}</span><strong>{item.blindId} · {item.displayName}</strong><span className={`state-label state-${item.state}`}>{item.state}</span><small>시도 {item.attempts}/{item.maxAttempts ?? '—'}</small></summary><div className="run-item-body"><section><h3>질문</h3><p className="run-question">{item.questionText}</p></section><section><h3>실제 전송 프롬프트</h3>{item.request ? <><h4>System</h4><JsonBlock value={item.request.system}/><h4>User</h4><JsonBlock value={item.request.prompt}/><details><summary>전체 요청 스냅샷</summary><JsonBlock value={item.request}/></details></> : <p>외부 요청 전에 실패했거나 아직 실행되지 않았습니다.</p>}</section><section><h3>모델 응답</h3>{item.response ? <><JsonBlock value={item.response.text}/><p className="run-meta mono">request {item.response.requestId ?? '—'} · {item.response.latencyMs ?? '—'} ms · token {item.response.inputTokens ?? '—'} / {item.response.outputTokens ?? '—'}</p><details><summary>원본 응답·재시도 기록</summary><JsonBlock value={{ raw:item.response.raw, retryHistory:item.response.retryHistory }}/></details></> : <p>저장된 응답이 없습니다.</p>}</section>{(item.errorCode || item.errorMessage) && <section className="run-error"><h3>실패 원인</h3><strong className="mono">{item.errorCode ?? 'EXECUTION_FAILED'}</strong><p>{item.errorMessage}</p></section>}<section><h3>점수와 판정 근거</h3>{item.scores.length ? <div className="run-score-list">{item.scores.map((score) => <details key={score.metricKey}><summary><strong>{metricLabels[score.metricKey] ?? score.metricKey}</strong><span className="mono">{score.value == null ? '—' : `${(score.value * 100).toFixed(1)}%`}</span><small>{score.label}</small></summary><p>{score.rationale}</p><JsonBlock value={score.evidence}/><small>{score.judgeProvider ? `${score.judgeProvider} · ${score.judgeModel}` : '결정론적 채점'}</small></details>)}</div> : <p>아직 저장된 점수가 없습니다.</p>}</section></div></details>)}</div></section>

    <section className="panel event-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>실시간 감사 이벤트</h2></div></div><div className="event-log">{events.length === 0 ? <p>SSE 이벤트를 기다리는 중입니다.</p> : events.slice().reverse().map((event) => <details key={`${event.id}-${event.type}`}><summary><span className="mono">#{event.id}</span><strong>{event.type}</strong><small>{String(event.data.createdAt ?? '')}</small></summary><JsonBlock value={event.data}/></details>)}</div></section>
  </div>;
}
