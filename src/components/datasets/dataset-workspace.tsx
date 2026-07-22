'use client';

import { AlertTriangle, Archive, Download, LockKeyhole, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AuditQuestion, DatasetAuditVersion } from '@/server/datasets/audit';
import { QuestionAuditCard } from '@/components/datasets/question-audit-card';

export type WorkingDistribution = {
  capabilities: Record<string, number>;
  responseFormats: Record<string, number>;
  evidenceModes: Record<string, number>;
};

function DistributionList({ values }: { values: Record<string, number> }) {
  const maximum = Math.max(1, ...Object.values(values));
  return <div className="target-bars">{Object.entries(values).map(([label, count]) => <div key={label}>
    <div><span>{label}</span><strong className="mono">{count}</strong></div>
    <div className="progress-track"><span style={{ width: `${(count / maximum) * 100}%` }} /></div>
  </div>)}</div>;
}

function options(items: AuditQuestion[], key: keyof Pick<AuditQuestion, 'purpose' | 'difficulty' | 'questionType' | 'evidenceMode'>) {
  return [...new Set(items.map((item) => item[key]))].sort((a, b) => a.localeCompare(b, 'ko'));
}

export function DatasetWorkspace({ approvedQuestionIds, workingDistribution, workingQuestions = [], versions }: {
  approvedQuestionIds: string[];
  workingDistribution: WorkingDistribution;
  workingQuestions?: AuditQuestion[];
  versions: DatasetAuditVersion[];
}) {
  const approvedCount = approvedQuestionIds.length;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'working' | 'version'>('working');
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [purpose, setPurpose] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [questionType, setQuestionType] = useState('');
  const [evidenceMode, setEvidenceMode] = useState('');
  const seoulDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;
  const scopedQuestions = scope === 'working' ? workingQuestions : selectedVersion?.questions ?? [];
  const filteredQuestions = useMemo(() => scopedQuestions.filter((question) => {
    const needle = query.trim().toLocaleLowerCase('ko-KR');
    const haystack = [question.publicId, question.questionText, question.answerText, question.subject, question.grade, question.chapter, question.unit, question.purpose, question.benchmarkDesign?.targetConcept].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR');
    return (!needle || haystack.includes(needle))
      && (!purpose || question.purpose === purpose)
      && (!difficulty || question.difficulty === difficulty)
      && (!questionType || question.questionType === questionType)
      && (!evidenceMode || question.evidenceMode === evidenceMode);
  }), [scopedQuestions, query, purpose, difficulty, questionType, evidenceMode]);

  function clearFilters() {
    setQuery(''); setPurpose(''); setDifficulty(''); setQuestionType(''); setEvidenceMode('');
  }

  async function freeze() {
    setBusy(true);
    const version = `official-${seoulDate.replaceAll('-', '')}-${Date.now().toString(36)}`;
    const response = await fetch('/api/datasets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version, title: `EduBench 실제 문항 데이터셋 ${seoulDate}`,
        description: `검수 승인된 실제 생성 문항 ${approvedCount}개로 확정한 불변 데이터셋`, questionIds: approvedQuestionIds,
      }),
    });
    const body = await response.json();
    setNotice(response.ok ? `데이터셋 ${version}을 확정했습니다. 내용 해시: ${body.contentHash}` : (body.message ?? body.code ?? '데이터셋을 확정하지 못했습니다.'));
    setBusy(false);
    if (response.ok) location.reload();
  }

  function exportWorking() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), questions: workingQuestions, distribution: workingDistribution }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `edubench-working-${seoulDate}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="workflow-page">
    <header className="page-heading"><div><span className="eyebrow">DATASET / RESEARCH AUDIT</span><h1>데이터셋 관리</h1><p>현재 승인 문항과 실행에 고정된 불변 revision을 분리하여 문항 설계, 근거, 선수관계 추론을 검증합니다.</p></div><div className="heading-actions"><button className="button" onClick={exportWorking}><Download size={15} /> JSON 내보내기</button><button className="button primary" disabled={approvedCount === 0 || busy} onClick={freeze}><LockKeyhole size={15} /> 새 버전 확정</button></div></header>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    <section className="dataset-readiness panel"><div><span className="eyebrow">WORKING SET</span><strong className="mono">{approvedCount}<small>개</small></strong><p>실제 승인 문항</p></div><div className="readiness-track"><span style={{ width: approvedCount ? '100%' : '0%' }} /></div><div className="dataset-warning"><AlertTriangle size={17} /><span>{approvedCount ? `현재 승인된 실제 문항 ${approvedCount}개를 데이터셋으로 확정할 수 있습니다.` : '질문 검수에서 실제 생성 문항을 하나 이상 승인하세요.'}</span></div></section>
    <div className="dataset-grid">
      <section className="panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>실제 질문 목적 분포</h2></div></div><DistributionList values={workingDistribution.capabilities} /></section>
      <section className="panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>실제 문항 형식·근거 모드</h2></div></div><DistributionList values={workingDistribution.responseFormats} /><div className="evidence-mode-grid">{Object.entries(workingDistribution.evidenceModes).map(([mode, count]) => <div key={mode}><strong className="mono">{count}</strong><span>{mode}</span></div>)}</div><div className="dataset-note"><Archive size={17} /><p>확정된 <strong>불변 버전</strong>은 문항 revision과 내용 해시를 보존합니다.</p></div></section>
    </div>

    <section className="panel version-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>불변 버전</h2></div><span className="count-label mono">{versions.length} VERSIONS</span></div>{versions.length === 0 ? <div className="table-empty"><Archive size={22} /><strong>확정된 데이터셋 버전이 없습니다.</strong><span>실제 생성 문항을 승인하면 현재 개수 그대로 버전을 만들 수 있습니다.</span></div> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>버전</th><th>제목</th><th className="numeric">문항</th><th>내용 해시</th><th>확정 일시</th></tr></thead><tbody>{versions.map((version) => <tr key={version.id}><td className="mono"><strong>{version.version}</strong></td><td>{version.title}</td><td className="numeric mono">{version.questionCount}</td><td className="mono">{version.contentHash.slice(0, 16)}…</td><td className="mono">{version.publishedAt.slice(0, 16).replace('T', ' ')}</td></tr>)}</tbody></table></div>}</section>

    <section className="panel dataset-audit-panel">
      <div className="panel-heading"><div><span className="section-index mono">04</span><h2>문항 연구 감사</h2></div><span className="count-label mono">{filteredQuestions.length} / {scopedQuestions.length}</span></div>
      <p className="audit-intro">문항의 실제 입력 계약, 교과서 근거, 선수관계 청사진과 생성 provenance를 함께 확인합니다. 실행 이후의 모델 요청·응답·판정 근거는 실행 상세 화면에서 이어서 추적할 수 있습니다.</p>
      <div className="audit-tabs" role="tablist" aria-label="데이터셋 문항 범위">
        <button type="button" role="tab" aria-selected={scope === 'working'} onClick={() => { setScope('working'); clearFilters(); }}>현재 작업 세트 ({workingQuestions.length})</button>
        <button type="button" role="tab" aria-selected={scope === 'version'} onClick={() => { setScope('version'); clearFilters(); }}>불변 버전 ({versions.length})</button>
      </div>
      {scope === 'version' && <div className="version-audit-selector">
        <label>감사할 불변 버전<select value={selectedVersion?.id ?? ''} onChange={(event) => { setSelectedVersionId(event.target.value); clearFilters(); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.version} · {version.title}</option>)}</select></label>
        {selectedVersion && <div className="version-manifest"><div><strong className="mono">{selectedVersion.version}</strong><span>{selectedVersion.title}</span><small>{selectedVersion.description || '설명 없음'}</small></div><div><span>상태 {selectedVersion.status}</span><span>문항 {selectedVersion.questionCount}</span><span>상위 버전 {selectedVersion.parentVersion ?? '없음'}</span></div><code>{selectedVersion.contentHash}</code></div>}
      </div>}
      <div className="audit-filter-grid">
        <label className="audit-search"><Search size={15}/><span className="sr-only">문항 검색</span><input aria-label="문항 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID, 질문, 답안, 개념, 단원 검색"/></label>
        <label><span className="sr-only">질문 목적 필터</span><select aria-label="질문 목적 필터" value={purpose} onChange={(event) => setPurpose(event.target.value)}><option value="">모든 질문 목적</option>{options(scopedQuestions, 'purpose').map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">난이도 필터</span><select aria-label="난이도 필터" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="">모든 난이도</option>{options(scopedQuestions, 'difficulty').map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">문항 형식 필터</span><select aria-label="문항 형식 필터" value={questionType} onChange={(event) => setQuestionType(event.target.value)}><option value="">모든 문항 형식</option>{options(scopedQuestions, 'questionType').map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">근거 모드 필터</span><select aria-label="근거 모드 필터" value={evidenceMode} onChange={(event) => setEvidenceMode(event.target.value)}><option value="">모든 근거 모드</option>{options(scopedQuestions, 'evidenceMode').map((value) => <option key={value}>{value}</option>)}</select></label>
        <button className="button subtle" type="button" onClick={clearFilters}>필터 초기화</button>
      </div>
      <div className="question-audit-list">{filteredQuestions.length ? filteredQuestions.map((question) => <QuestionAuditCard key={`${scope}-${question.id}-${question.revision}`} question={question} immutable={scope === 'version'}/>) : <div className="table-empty"><Search size={20}/><strong>조건에 맞는 문항이 없습니다.</strong><span>검색어나 필터를 변경하세요.</span></div>}</div>
    </section>
  </div>;
}
