'use client';

import { useState, type FormEvent } from 'react';
import { FileText, RotateCcw, Upload } from 'lucide-react';

export type SourceListItem = {
  id: string;
  original_name: string;
  subject: string | null;
  grade: string | null;
  byte_size: string | number;
  status: string;
  failed_stage: string | null;
  created_at: string;
};

const stages = ['Document Parse', 'HTML 검수', '청크', '임베딩'];

function stageState(source: SourceListItem, stage: string): string {
  const order = ['UPLOADED', 'PARSING', 'PARSED', 'HTML_REVIEWED', 'CHUNKING', 'CHUNKED', 'EMBEDDING', 'READY'];
  const stageThreshold: Record<string, number> = { 'Document Parse': 2, 'HTML 검수': 3, '청크': 5, '임베딩': 7 };
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
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const response = await fetch('/api/sources', { method: 'POST', body: new FormData(event.currentTarget) });
    const body = await response.json();
    if (!response.ok) {
      setNotice(body.message ?? '파일을 등록하지 못했습니다.');
    } else {
      setNotice(body.existing ? '동일한 파일이 이미 등록되어 있습니다.' : 'PDF를 저장했고 문서 분석 작업을 생성했습니다.');
      const list = await fetch('/api/sources').then((result) => result.json());
      setSources(list.items);
      event.currentTarget.reset();
    }
    setSubmitting(false);
  }

  return (
    <div className="workflow-page">
      <header className="page-heading">
        <div><span className="eyebrow">SOURCES / TEXTBOOKS</span><h1>교과서 자료 관리</h1><p>PDF 원본부터 HTML·청크·임베딩까지 단계별 산출물을 추적합니다.</p></div>
      </header>
      <section className="upload-panel panel">
        <form onSubmit={submit}>
          <div className="upload-copy"><span className="upload-icon"><Upload size={20} /></span><div><strong>교과서 PDF 등록</strong><p>최대 100MB. 동일 파일은 SHA-256으로 중복 처리됩니다.</p></div></div>
          <label className="file-control">교과서 PDF<input aria-label="교과서 PDF" name="file" type="file" accept="application/pdf" required /></label>
          <label>과목<input name="subject" placeholder="예: 과학" /></label>
          <label>학년<input name="grade" placeholder="예: 중학교 2학년" /></label>
          <button className="button primary" disabled={submitting}>{submitting ? '저장 중…' : '업로드 및 분석 예약'}</button>
        </form>
        {notice && <p className="inline-notice" role="status">{notice}</p>}
      </section>
      <section className="panel workflow-table-panel">
        <div className="panel-heading"><div><span className="section-index mono">01</span><h2>등록 자료</h2></div><span className="count-label mono">{sources.length} FILES</span></div>
        <div className="data-table-wrap"><table className="data-table source-table"><thead><tr><th>파일</th><th>과목·학년</th>{stages.map((stage) => <th key={stage}>{stage}</th>)}<th>등록 일시</th><th aria-label="작업" /></tr></thead><tbody>
          {sources.map((source) => <tr key={source.id}>
            <td><div className="file-cell"><FileText size={17} /><div><strong>{source.original_name}</strong><small className="mono">{source.id.slice(0, 8)}</small></div></div></td>
            <td>{source.subject ?? '미지정'} · {source.grade ?? '미지정'}</td>
            {stages.map((stage) => { const state = stageState(source, stage); return <td key={stage}><span className={`state-label state-${state.replace(' ', '-')}`}>{state}</span></td>; })}
            <td className="mono">{source.created_at.slice(0, 16).replace('T', ' ')}</td>
            <td>{source.status === 'FAILED' && <button className="icon-button" aria-label="실패 단계 재실행"><RotateCcw size={15} /></button>}</td>
          </tr>)}
          {sources.length === 0 && <tr><td colSpan={9}><div className="table-empty"><FileText size={22} /><strong>등록된 교과서가 없습니다.</strong><span>위에서 PDF를 등록하면 처리 상태가 여기에 표시됩니다.</span></div></td></tr>}
        </tbody></table></div>
      </section>
    </div>
  );
}

