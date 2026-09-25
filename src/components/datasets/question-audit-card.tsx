import { AlertTriangle, BookOpen, BrainCircuit, Database, GitBranch, ListChecks } from 'lucide-react';
import type { AuditQuestion, AuditQuestionListItem } from '@/server/datasets/audit';

function Value({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="audit-value"><small>{label}</small><strong>{children ?? '—'}</strong></div>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="audit-json">{JSON.stringify(value, null, 2)}</pre>;
}

function AuditDetail({ question, immutable }: { question: AuditQuestion; immutable: boolean }) {
  const design = question.benchmarkDesign;
  return <div className="question-audit-body">
    {question.revisionDrift && <p className="audit-warning"><AlertTriangle size={16}/><span>이 버전은 <strong>고정 revision {question.revision}</strong>을 사용하며 현재 revision {question.currentRevision}와 다릅니다. 실행 재현에는 고정 revision이 사용됩니다.</span></p>}
    <div className="audit-value-grid">
      <Value label="데이터 상태">{immutable ? '불변 데이터셋 문항' : question.status}</Value>
      <Value label={immutable ? '고정 revision' : '현재 revision'}>{question.revision}</Value>
      <Value label="과목 · 학년">{question.subject} · {question.grade}</Value>
      <Value label="단원">{[question.chapter, question.unit].filter(Boolean).join(' › ') || '—'}</Value>
      <Value label="질문 목적">{question.purpose}</Value>
      <Value label="난이도 · 형식">{question.difficulty} · {question.questionType}</Value>
    </div>
    <section className="audit-section">
      <h3><ListChecks size={16}/> 문항·정답·채점 계약</h3>
      <div className="audit-prose"><small>질문 원문</small><p>{question.questionText}</p></div>
      {question.answerOptions.length > 0 && <div className="audit-prose"><small>선택지</small><ol>{question.answerOptions.map((option, index) => <li key={index}>{String(option)}</li>)}</ol></div>}
      <div className="audit-prose"><small>모범 답안</small><p>{question.answerText}</p></div>
      <div className="audit-prose"><small>허용 답안</small>{question.acceptedAnswers.length ? <ul>{question.acceptedAnswers.map((answer) => <li key={answer}>{answer}</li>)}</ul> : <p>별도 허용 답안 없음</p>}</div>
      <div className="audit-prose"><small>원자 단위 채점 기준</small>{question.scoringCriteria.length ? <div className="audit-criteria">{question.scoringCriteria.map((criterion, index) => <div key={`${String(criterion.key)}-${index}`}><strong>{String(criterion.label ?? criterion.key ?? `기준 ${index + 1}`)}</strong><span>{criterion.description ? String(criterion.description) : '설명 없음'}</span><b className="mono">최대 {String(criterion.maxScore ?? '—')}</b></div>)}</div> : <p>저장된 기준 없음</p>}</div>
    </section>
    <section className="audit-section">
      <h3><BrainCircuit size={16}/> 선수관계 청사진</h3>
      {design ? <>
        <div className="audit-value-grid"><Value label="벤치마크 유형">{design.benchmarkType}</Value><Value label="과제 유형">{design.taskType}</Value><Value label="목표 개념">{design.targetConcept}</Value></div>
        <div className="audit-prose"><small>선수 개념</small><ul>{design.prerequisiteConcepts.map((concept, index) => <li key={`${concept.concept}-${index}`}><strong>{concept.concept}</strong> — {concept.role}<code>{concept.evidenceChunkIds.join(', ')}</code></li>)}</ul></div>
        <div className="audit-prose"><small>방향성 있는 선수 관계</small><div className="relation-list">{design.prerequisiteRelations.map((relation, index) => <div key={index}><GitBranch size={15}/><strong>{relation.fromConcept} → {relation.toConcept}</strong><span>{relation.relationType} · {relation.explanation}</span></div>)}</div></div>
        <div className="audit-prose"><small>필수 추론 단계</small><ol>{design.requiredReasoningSteps.map((step, index) => <li key={index}>{step}</li>)}</ol></div>
        <div className="audit-prose"><small>대표 실패 신호</small><ul>{design.failureSignals.map((signal, index) => <li key={index}>{signal}</li>)}</ul></div>
      </> : <p className="empty-copy">이 revision에는 선수관계 청사진이 저장되어 있지 않습니다.</p>}
    </section>
    <section className="audit-section">
      <h3><BookOpen size={16}/> 교과서 근거</h3>
      {question.evidence.length ? <div className="evidence-audit-list">{question.evidence.map((evidence) => <details key={`${evidence.chunkId}-${evidence.ordinal}`}>
        <summary><strong>{evidence.sourceName}</strong><span>p.{evidence.pageStart ?? '—'}{evidence.pageEnd && evidence.pageEnd !== evidence.pageStart ? `–${evidence.pageEnd}` : ''}</span><small>{evidence.role}</small></summary>
        <div><p><strong>인용:</strong> {evidence.quote || '별도 인용문 없음'}</p><p><strong>청크 원문:</strong> {evidence.content}</p><p className="mono">chunk {evidence.chunkId} · source revision {evidence.sourceRevision} · parser {evidence.parseModel ?? '—'} · request {evidence.parseRequestId ?? '—'}</p></div>
      </details>)}</div> : <p className="empty-copy">연결된 교과서 근거가 없습니다.</p>}
    </section>
    <section className="audit-section">
      <h3><Database size={16}/> 생성 provenance</h3>
      <div className="audit-value-grid">
        <Value label="생성 배치">{question.generation.batchId ?? '—'}</Value><Value label="제공자">{question.generation.provider ?? '—'}</Value>
        <Value label="생성 모델">{question.generation.model ?? '—'}</Value><Value label="프롬프트 버전">{question.generation.promptVersion ?? '—'}</Value>
        <Value label="임베딩 모델">{question.generation.embeddingModel ?? '—'}</Value><Value label="생성 시각">{question.createdAt.slice(0, 19).replace('T', ' ')}</Value>
      </div>
      <div className="audit-prose"><small>설계 요약</small><p>{question.designSummary || '저장된 설계 요약 없음'}</p></div>
      <div className="audit-prose"><small>근거 요약</small><p>{question.evidenceSummary || '저장된 근거 요약 없음'}</p></div>
      <details><summary>품질·파이프라인 원본 JSON</summary><JsonBlock value={question.qualityScores}/></details>
    </section>
  </div>;
}

export function QuestionAuditCard({
  question,
  detail,
  immutable = false,
  expanded,
  loading = false,
  error,
  onToggle,
}: {
  question: AuditQuestionListItem;
  detail: AuditQuestion | null;
  immutable?: boolean;
  expanded: boolean;
  loading?: boolean;
  error?: string;
  onToggle: (open: boolean) => void;
}) {
  return <details className="question-audit-card" open={expanded} onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary>
      <span className="mono">{question.ordinal ? `${String(question.ordinal).padStart(3, '0')} · ` : ''}{question.publicId}</span>
      <strong>{question.questionSummary}</strong>
      <span className="question-audit-badges"><small>{question.difficulty}</small><small>{question.questionType}</small><small>{question.evidenceMode}</small></span>
    </summary>
    {loading && <p className="empty-copy">감사 상세를 불러오는 중입니다.</p>}
    {error && <p className="audit-warning" role="alert">{error}</p>}
    {detail && <AuditDetail question={detail} immutable={immutable} />}
  </details>;
}
