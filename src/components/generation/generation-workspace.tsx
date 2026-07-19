'use client';

import { useState, type FormEvent } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';
import { GENERATION_STAGES } from '@/app/api/generation/route';

type GenerationSource = { id: string; original_name: string; subject: string | null; grade: string | null };
type GenerationBatch = { id: string; state: string; requested_count: number; created_at: string };

export function GenerationWorkspace({ sources, batches }: { sources: GenerationSource[]; batches: GenerationBatch[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/generation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: form.get('subject'), grade: form.get('grade'),
        sourceFileIds: form.getAll('sourceFileIds'), units: [form.get('unit')].filter(Boolean),
        purpose: form.get('purpose'), questionType: form.get('questionType'), difficulty: form.get('difficulty'),
        direction: form.get('direction'), chunkCount: Number(form.get('chunkCount')),
        requestedCount: Number(form.get('requestedCount')), crossUnit: form.get('crossUnit') === 'on',
      }),
    });
    const body = await response.json();
    setNotice(response.ok ? `생성 배치 ${body.id.slice(0, 8)}를 예약했습니다.` : (body.message ?? '생성 배치를 만들지 못했습니다.'));
  }
  return <div className="workflow-page">
    <header className="page-heading"><div><span className="eyebrow">QUESTIONS / GENERATE</span><h1>질문 생성</h1><p>선택한 교과서 범위 안에서 검색·검증을 거쳐 벤치마크 문항을 생성합니다.</p></div></header>
    <div className="generation-grid">
      <section className="panel form-panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>생성 조건</h2></div></div><form className="dense-form" onSubmit={submit}>
        <div className="form-row"><label>과목<input name="subject" defaultValue="과학" required /></label><label>학년<input name="grade" defaultValue="중학교 2학년" required /></label></div>
        <label>교과서 파일<select aria-label="교과서 파일" name="sourceFileIds" multiple required size={Math.max(3, Math.min(5, sources.length || 3))}>{sources.map((source) => <option value={source.id} key={source.id}>{source.original_name}</option>)}</select><small>Ctrl 또는 Cmd를 눌러 여러 파일을 선택합니다.</small></label>
        <label>단원<input name="unit" placeholder="예: 물질의 구성" /></label>
        <div className="form-row"><label>질문 목적<select name="purpose"><option>핵심 개념 이해</option><option>개념 적용·문제풀이</option><option>여러 단원 연결 추론</option><option>학생 수준별 설명</option><option>오개념·잘못된 주장 교정</option></select></label><label>문항 형식<select name="questionType"><option>구조화 서술형</option><option>객관식</option><option>단답형</option><option>학생 설명형</option></select></label></div>
        <div className="form-row"><label>난이도<select name="difficulty" defaultValue="중"><option>하</option><option>중</option><option>상</option></select></label><label>검색 청크 수<input type="number" name="chunkCount" min="3" max="30" defaultValue="8" /></label></div>
        <label>질문 방향성<textarea name="direction" defaultValue="교과서 근거로 핵심 개념 사이의 관계를 설명하도록 구성" required /></label>
        <div className="form-row"><label>생성 수량<input type="number" name="requestedCount" min="1" max="100" defaultValue="10" /></label><label className="check-control"><input type="checkbox" name="crossUnit" /> 복수 단원 연결 허용</label></div>
        <button className="button primary" type="submit" disabled={sources.length === 0}><Sparkles size={15} /> 문항 생성 시작</button>
        {sources.length === 0 && <p className="form-warning">준비 완료된 교과서가 필요합니다.</p>}{notice && <p className="inline-notice" role="status">{notice}</p>}
      </form></section>
      <div className="generation-side">
        <section className="panel pipeline-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>9단계 생성 파이프라인</h2></div></div><ol>{GENERATION_STAGES.map((stage, index) => <li key={stage}><span className="pipeline-index mono">{String(index + 1).padStart(2, '0')}</span><span>{stage}</span>{index === 0 ? <Search size={14} /> : <Check size={14} />}</li>)}</ol></section>
        <section className="panel batch-panel"><div className="panel-heading compact"><div><span className="section-index mono">03</span><h2>최근 생성 배치</h2></div></div>{batches.length === 0 ? <div className="small-empty">생성 배치가 없습니다.</div> : batches.map((batch) => <div className="batch-row" key={batch.id}><span className="mono">{batch.id.slice(0, 8)}</span><strong>{batch.requested_count}문항</strong><span className="state-label">{batch.state}</span></div>)}</section>
      </div>
    </div>
  </div>;
}

