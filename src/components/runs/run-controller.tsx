'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CirclePause, CirclePlay, RefreshCcw, RotateCcw, Square } from 'lucide-react';

type Run = { id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; dataset_version: string; score_version: string; price_profile_version: string; created_at: string };
type Model = { id: string; display_name: string; blind_id: string; model_id: string; protocol: string; concurrency: number };
type EventRecord = { id: string; type: string; data: Record<string, unknown> };

export function RunController({ initialRun, models }: { initialRun: Run; models: Model[] }) {
  const [run, setRun] = useState(initialRun); const [events, setEvents] = useState<EventRecord[]>([]); const [busy, setBusy] = useState(false);
  useEffect(() => {
    const source = new EventSource(`/api/runs/${run.id}/events`);
    const types = ['RUN_CREATED','RUN_QUEUED','RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_ITEMS_CLAIMED','RUN_ITEM_COMPLETED','RUN_ITEM_FAILED','RUN_ITEMS_RETRIED','RUN_SCORING_STARTED','RUN_COMPLETED','RUN_CANCELLED','RUN_FAILED'];
    for (const type of types) source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>; const data = JSON.parse(message.data);
      setEvents((current) => [...current.slice(-49), { id: message.lastEventId, type, data }]);
      setRun((current) => ({
        ...current,
        state: typeof data.state === 'string' ? data.state : current.state,
        completed_items: typeof data.completedItems === 'number' ? data.completedItems : current.completed_items,
        failed_items: typeof data.failedItems === 'number' ? data.failedItems : current.failed_items,
        total_items: typeof data.totalItems === 'number' ? data.totalItems : current.total_items,
      }));
    });
    return () => source.close();
  }, [run.id]);

  async function command(value: string) {
    setBusy(true);
    const response = await fetch(`/api/runs/${run.id}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: value }) });
    const body = await response.json();
    if (response.ok && body.state) setRun((current) => ({ ...current, state: body.state }));
    setBusy(false);
  }

  const percent = run.total_items ? Math.round((run.completed_items / run.total_items) * 100) : 0;
  return <div className="workflow-page"><header className="page-heading"><div><Link className="text-link" href="/runs"><ArrowLeft size={13} /> 실행 목록</Link><span className="eyebrow mono">{run.public_id}</span><h1>{run.title}</h1><p>{run.dataset_version} · {run.score_version} · {run.price_profile_version}</p></div><div className="heading-actions">{run.state === 'DRAFT' && <button className="button primary" disabled={busy} onClick={async () => { await command('QUEUE'); await command('START'); }}><CirclePlay size={15} /> 실행 시작</button>}{run.state === 'RUNNING' && <button className="button" disabled={busy} onClick={() => command('PAUSE')}><CirclePause size={15} /> 일시정지</button>}{run.state === 'PAUSED' && <button className="button primary" disabled={busy} onClick={() => command('RESUME')}><CirclePlay size={15} /> 재개</button>}{run.failed_items > 0 && <button className="button" disabled={busy} onClick={() => command('RETRY_FAILED')}><RotateCcw size={15} /> 실패 재시도</button>}{['QUEUED','RUNNING','PAUSED'].includes(run.state) && <button className="button danger" disabled={busy} onClick={() => command('CANCEL')}><Square size={14} /> 취소</button>}</div></header>
    <section className="run-control-strip panel"><div><span>STATE</span><strong className="mono">{run.state}</strong></div><div><span>PROGRESS</span><strong className="mono">{run.completed_items} / {run.total_items}</strong><div className="progress-track"><i style={{ width: `${percent}%` }} /></div></div><div><span>FAILED</span><strong className="mono">{run.failed_items}</strong></div><div><span>LIVE EVENT</span><strong><RefreshCcw size={13} /> SSE 연결</strong></div></section>
    <div className="run-detail-grid"><section className="panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>질문 × 모델 실행 행렬</h2></div><span className="count-label mono">{models.length} MODELS · {run.total_items} ITEMS</span></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>블라인드 ID</th><th>모델</th><th>프로토콜</th><th className="numeric">동시성</th><th className="numeric">할당 항목</th></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td className="mono"><strong>{model.blind_id}</strong></td><td><strong>{model.display_name}</strong><br/><small className="mono">{model.model_id}</small></td><td>{model.protocol}</td><td className="numeric mono">{model.concurrency}</td><td className="numeric mono">{run.total_items / models.length}</td></tr>)}</tbody></table></div></section><section className="panel event-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>실시간 감사 이벤트</h2></div></div><div className="event-log">{events.length === 0 ? <p>SSE 이벤트를 기다리는 중입니다.</p> : events.slice().reverse().map((event) => <div key={`${event.id}-${event.type}`}><span className="mono">#{event.id}</span><strong>{event.type}</strong><small>{String(event.data.createdAt ?? '')}</small></div>)}</div></section></div>
  </div>;
}
