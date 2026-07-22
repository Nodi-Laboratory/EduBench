'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Ban, ChevronRight, CircleStop, FileText, LoaderCircle, RotateCcw, Trash2, Upload, X } from 'lucide-react';

export type SourceListItem = {
  id: string;
  original_name: string;
  subject: string | null;
  grade: string | null;
  byte_size: string | number;
  status: string;
  failed_stage: string | null;
  created_at: string;
  current_job_id: string | null;
  current_job_state: string | null;
};

type ActivityEvent = { id: string; event_type: string; payload: Record<string, unknown>; created_at: string };
type Activity = {
  source: SourceListItem & { failure_code?: string | null; failure_message?: string | null; updated_at: string };
  job: { id: string; state: string; attempts: number; max_attempts: number; result?: unknown; last_error_code?: string | null; last_error_message?: string | null } | null;
  events: ActivityEvent[];
};

const stages = ['Document Parse', 'HTML 검수', '청크', '임베딩'];
const activeJobStates = new Set(['PENDING', 'RETRY_WAIT', 'LEASED']);
const eventLabels: Record<string, string> = {
  JOB_ENQUEUED: '작업 등록', JOB_CLAIMED: '워커 실행 시작', JOB_CANCELLED: '사용자 중단',
  JOB_SUCCEEDED: '작업 완료', JOB_RETRY_SCHEDULED: '재시도 예약', JOB_TERMINAL_FAILED: '작업 실패',
  PIPELINE_STARTED: '교과서 처리 시작', DOCUMENT_PARSE_STARTED: 'Upstage Document Parse 시작',
  DOCUMENT_PARSE_BATCH_STARTED: '페이지 파싱 배치 시작', DOCUMENT_PARSE_BATCH_COMPLETED: '페이지 파싱 배치 완료',
  DOCUMENT_PAGE_PARSE_STARTED: '페이지 이미지 파싱 시작', DOCUMENT_PAGE_PARSE_COMPLETED: '페이지 파싱 완료',
  DOCUMENT_PARSE_COMPLETED: 'Document Parse 완료', CHUNKING_STARTED: 'HTML 청킹 시작',
  CHUNKING_COMPLETED: 'HTML 청킹 완료', GEMINI_EMBEDDING_STARTED: 'Gemini 임베딩 시작',
  TABLE_OF_CONTENTS_EXTRACTED: '교과서 목차 추출 완료',
  EMBEDDING_BATCH_COMPLETED: '임베딩 배치 완료', GEMINI_EMBEDDING_COMPLETED: 'Gemini 임베딩 완료',
  EMBEDDING_BATCH_STARTED: '임베딩 배치 시작',
  PIPELINE_COMPLETED: '교과서 처리 완료', PIPELINE_FAILED: '교과서 처리 실패',
};

function stageState(source: SourceListItem, stage: string): string {
  const order = ['UPLOADED', 'PARSING', 'PARSED', 'HTML_REVIEWED', 'CHUNKING', 'CHUNKED', 'EMBEDDING', 'READY'];
  const stageThreshold: Record<string, number> = { 'Document Parse': 2, 'HTML 검수': 3, '청크': 5, '임베딩': 7 };
  if (source.status === 'CANCELLED') return '중단';
  if (source.status === 'FAILED' && source.failed_stage?.includes(stage.split(' ')[0].toUpperCase())) return '실패';
  const current = order.indexOf(source.status);
  if (current >= stageThreshold[stage]!) return '완료';
  if ((stage === 'Document Parse' && source.status === 'PARSING')
    || (stage === '청크' && source.status === 'CHUNKING')
    || (stage === '임베딩' && source.status === 'EMBEDDING')) return '처리 중';
  return '대기';
}

export function SourcesWorkspace({ initialSources }: { initialSources: SourceListItem[] }) {
  const [sources, setSources] = useState(initialSources);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const refreshSources = useCallback(async () => {
    const response = await fetch('/api/sources', { cache: 'no-store' });
    if (response.ok) setSources((await response.json()).items);
  }, []);
  const refreshActivity = useCallback(async (sourceId: string) => {
    const response = await fetch(`/api/sources/${sourceId}/activity`, { cache: 'no-store' });
    if (response.ok) setActivity(await response.json());
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refreshSources, 1_500);
    return () => window.clearInterval(timer);
  }, [refreshSources]);
  useEffect(() => {
    if (!selectedId) { setActivity(null); return; }
    void refreshActivity(selectedId);
    const timer = window.setInterval(() => void refreshActivity(selectedId), 1_000);
    return () => window.clearInterval(timer);
  }, [selectedId, refreshActivity]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const form = event.currentTarget;
    const response = await fetch('/api/sources', { method: 'POST', body: new FormData(form) });
    const body = await response.json();
    if (!response.ok) setNotice(body.message ?? '파일을 등록하지 못했습니다.');
    else {
      setNotice(body.existing ? '동일한 파일의 처리 기록을 열었습니다.' : 'PDF를 저장했고 문서 분석을 시작합니다.');
      setSelectedId(body.id);
      await refreshSources();
      form.reset();
    }
    setSubmitting(false);
  }
  async function retry(sourceId: string) {
    const response = await fetch(`/api/sources/${sourceId}/retry`, { method: 'POST' });
    const body = await response.json();
    setNotice(response.ok ? '문서 처리 작업을 다시 예약했습니다.' : (body.message ?? '재실행하지 못했습니다.'));
    await Promise.all([refreshSources(), refreshActivity(sourceId)]);
  }
  async function cancel() {
    if (!selectedId) return;
    setCancelling(true);
    const response = await fetch(`/api/sources/${selectedId}/cancel`, { method: 'POST' });
    const body = await response.json();
    setNotice(response.ok ? '교과서 처리를 중단했습니다.' : (body.message ?? '작업을 중단하지 못했습니다.'));
    await Promise.all([refreshSources(), refreshActivity(selectedId)]);
    setCancelling(false);
  }
  async function remove(source: SourceListItem) {
    if (!window.confirm(`"${source.original_name}" 등록 자료를 삭제할까요?\n처리 기록과 원본은 복구를 위해 보존됩니다.`)) return;
    const response = await fetch(`/api/sources/${source.id}`, { method: 'DELETE' });
    const body = await response.json();
    setNotice(response.ok ? '등록 자료를 목록에서 삭제했습니다.' : (body.message ?? '등록 자료를 삭제하지 못했습니다.'));
    if (response.ok) {
      setSources((current) => current.filter((item) => item.id !== source.id));
      if (selectedId === source.id) setSelectedId(null);
    }
  }

  const selected = sources.find((source) => source.id === selectedId);
  const canCancel = Boolean(activity?.job && activeJobStates.has(activity.job.state));

  return (
    <div className="workflow-page">
      <header className="page-heading"><div><span className="eyebrow">SOURCES / TEXTBOOKS</span><h1>교과서 자료 관리</h1><p>PDF 원본부터 HTML·청크·임베딩까지 처리 과정을 실시간으로 추적합니다.</p></div></header>
      <section className="upload-panel panel">
        <form onSubmit={submit}>
          <div className="upload-copy"><span className="upload-icon"><Upload size={20} /></span><div><strong>교과서 PDF 등록</strong><p>최대 100MB. 업로드 직후 처리 로그가 열립니다.</p></div></div>
          <label className="file-control">교과서 PDF<input aria-label="교과서 PDF" name="file" type="file" accept="application/pdf" required /></label>
          <label>과목<input name="subject" placeholder="예: 과학" /></label><label>학년<input name="grade" placeholder="예: 중학교 2학년" /></label>
          <button className="button primary" disabled={submitting}>{submitting ? '저장 중…' : '업로드 및 분석 시작'}</button>
        </form>
        {notice && <p className="inline-notice" role="status">{notice}</p>}
      </section>
      <div className={`sources-layout ${selectedId ? 'has-activity' : ''}`}>
        <section className="panel workflow-table-panel">
          <div className="panel-heading"><div><span className="section-index mono">01</span><h2>등록 자료</h2></div><span className="count-label mono">{sources.length} FILES</span></div>
          <div className="data-table-wrap"><table className="data-table source-table"><thead><tr><th>파일</th><th>과목·학년</th>{stages.map((stage) => <th key={stage}>{stage}</th>)}<th>등록 일시</th><th aria-label="작업" /></tr></thead><tbody>
            {sources.map((source) => <tr key={source.id} className={selectedId === source.id ? 'selected-source' : ''} onClick={() => setSelectedId(source.id)}>
              <td><div className="file-cell"><FileText size={17} /><div><strong>{source.original_name}</strong><small className="mono">{source.id.slice(0, 8)}</small></div></div></td>
              <td>{source.subject ?? '미지정'} · {source.grade ?? '미지정'}</td>
              {stages.map((stage) => { const state = stageState(source, stage); return <td key={stage}><span className={`state-label state-${state.replace(' ', '-')}`}>{state}</span></td>; })}
              <td className="mono">{source.created_at.slice(0, 16).replace('T', ' ')}</td>
              <td><div className="source-row-actions">{['FAILED', 'CANCELLED'].includes(source.status) && <button className="icon-button" aria-label="문서 처리 재실행" onClick={(event) => { event.stopPropagation(); void retry(source.id); }}><RotateCcw size={15} /></button>}<button className="icon-button delete-source-button" aria-label={`${source.original_name} 삭제`} onClick={(event) => { event.stopPropagation(); void remove(source); }}><Trash2 size={15} /></button></div></td>
            </tr>)}
            {sources.length === 0 && <tr><td colSpan={9}><div className="table-empty"><FileText size={22} /><strong>등록된 교과서가 없습니다.</strong><span>위에서 PDF를 등록하면 처리 상태가 여기에 표시됩니다.</span></div></td></tr>}
          </tbody></table></div>
        </section>
        {selectedId && <aside className="panel source-activity" aria-label="교과서 처리 기록">
          <div className="source-activity-header"><div><span className="eyebrow">LIVE PROCESS LOG</span><h2>{selected?.original_name ?? activity?.source.original_name ?? '처리 기록'}</h2></div><button className="icon-button" aria-label="기록 닫기" onClick={() => setSelectedId(null)}><X size={15} /></button></div>
          <div className="source-job-summary">
            <span className={`status-dot ${canCancel ? '' : 'idle'}`} />
            <div><strong>{activity?.job?.state ?? '기록 불러오는 중'}</strong><small>{activity ? `${activity.events.length}개 로그 · 시도 ${activity.job?.attempts ?? 0}/${activity.job?.max_attempts ?? 0}` : '잠시 기다려 주세요'}</small></div>
            {canCancel && <button className="button danger" onClick={cancel} disabled={cancelling}><CircleStop size={14} /> {cancelling ? '중단 중…' : '작업 중단'}</button>}
          </div>
          <div className="source-event-log" aria-live="polite">
            {!activity && <div className="activity-loading"><LoaderCircle className="lab-spinner" size={18} /> 기록을 불러오는 중입니다.</div>}
            {activity?.events.map((event, index) => <details key={event.id} className={`source-event event-${event.event_type}`}>
              <summary><ChevronRight size={14} /><span className="event-sequence mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{eventLabels[event.event_type] ?? event.event_type}</strong><time>{new Date(event.created_at).toLocaleTimeString('ko-KR')}</time></div></summary>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </details>)}
            {activity && activity.events.length === 0 && <div className="activity-loading"><Ban size={18} /> 아직 기록된 로그가 없습니다.</div>}
          </div>
        </aside>}
      </div>
    </div>
  );
}
