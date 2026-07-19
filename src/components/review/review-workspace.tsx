'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Check, Clock3, Edit3, Trash2 } from 'lucide-react';

export type ReviewQuestion = { id: string; public_id: string; status: string; subject: string; grade: string; purpose: string; difficulty: string; question_text: string; answer_text: string; scoring_criteria: Array<{ key: string; label?: string; maxScore: number }>; evidence_summary: string | null };

export function ReviewWorkspace({ questions }: { questions: ReviewQuestion[] }) {
  const [selectedId, setSelectedId] = useState(questions[0]?.id ?? null);
  const selected = useMemo(() => questions.find((question) => question.id === selectedId) ?? null, [questions, selectedId]);
  return <div className="workflow-page review-page">
    <header className="page-heading"><div><span className="eyebrow">QUESTIONS / REVIEW</span><h1>질문 검수</h1><p>문항 표현, 원자 채점 기준, 교과서 근거를 함께 확인하고 승인합니다.</p></div><span className="review-count mono">{questions.length} WAITING</span></header>
    <div className="review-grid">
      <section className="panel review-queue"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>검수 대기열</h2></div></div>{questions.length === 0 ? <div className="small-empty">검수할 문항이 없습니다.</div> : questions.map((question) => <button className={question.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(question.id)} key={question.id}><span className="mono">{question.public_id}</span><strong>{question.question_text}</strong><small>{question.subject} · {question.grade} · {question.difficulty}</small></button>)}</section>
      <section className="panel review-editor"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>문항·모범 답안</h2></div></div>{selected ? <div className="editor-content"><div className="question-meta"><span>{selected.subject}</span><span>{selected.grade}</span><span>{selected.purpose}</span></div><label>질문<textarea defaultValue={selected.question_text} /></label><label>모범 답안<textarea defaultValue={selected.answer_text} /></label><h3>원자 채점 기준</h3><div className="rubric-list">{selected.scoring_criteria.map((criterion) => <div key={criterion.key}><span>{criterion.label ?? criterion.key}</span><strong className="mono">{criterion.maxScore}점</strong></div>)}</div></div> : <div className="editor-content empty-editor"><h3>문항을 선택하세요</h3><p>왼쪽에서 검수할 문항을 선택하면 질문과 모범 답안이 표시됩니다.</p><h3>원자 채점 기준</h3><p>선택한 문항의 채점 항목이 표시됩니다.</p></div>}<div className="review-actions"><button className="button"><Clock3 size={14} /> 보류</button><button className="button danger"><Trash2 size={14} /> 삭제</button><button className="button"><Edit3 size={14} /> 수정 후 승인</button><button className="button primary"><Check size={14} /> 승인</button></div></section>
      <aside className="panel evidence-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>교과서 근거</h2></div></div><div className="evidence-content"><BookOpen size={20} /><strong>{selected ? '연결된 근거 요약' : '근거 대기'}</strong><p>{selected?.evidence_summary ?? '선택한 문항의 페이지·HTML·청크와 변경 이력이 여기에 표시됩니다.'}</p><div className="evidence-tabs"><span>페이지</span><span>HTML</span><span>청크</span><span>감사 기록</span></div></div></aside>
    </div>
  </div>;
}
