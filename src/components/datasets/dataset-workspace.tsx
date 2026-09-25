'use client';

import { Archive, Download, FolderKanban, LockKeyhole, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  AuditQuestion,
  AuditQuestionListItem,
  DatasetAuditQuestionPage,
  DatasetAuditScope,
  DatasetAuditVersionMetadata,
  DatasetAuditVersion,
  QuestionSetAudit,
  QuestionSetAuditMetadata,
} from '@/server/datasets/audit';
import { QuestionAuditCard } from '@/components/datasets/question-audit-card';

export type WorkingDistribution = {
  capabilities: Record<string, number>;
  responseFormats: Record<string, number>;
  evidenceModes: Record<string, number>;
};

type Filters = {
  query: string;
  purpose: string;
  difficulty: string;
  questionType: string;
  evidenceMode: string;
};

const emptyPage: DatasetAuditQuestionPage = { items: [], page: 1, pageSize: 20, total: 0 };
const emptyFilters: Filters = { query: '', purpose: '', difficulty: '', questionType: '', evidenceMode: '' };

function auditUrl(scope: DatasetAuditScope, scopeId: string, page: number, filters: Filters) {
  const params = new URLSearchParams({ scope, page: String(page), pageSize: '20' });
  if (scope !== 'unassigned') params.set('scopeId', scopeId);
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  return `/api/datasets/audit?${params}`;
}

function questionKey(question: AuditQuestionListItem) {
  return `${question.id}:${question.revision}`;
}

export function DatasetWorkspace({
  questionSets = [],
  versions = [],
  unassignedQuestionCount = 0,
  approvedQuestionIds,
  workingDistribution,
  workingQuestions,
}: {
  questionSets?: Array<QuestionSetAuditMetadata | QuestionSetAudit>;
  versions?: Array<DatasetAuditVersionMetadata | DatasetAuditVersion>;
  unassignedQuestionCount?: number;
  /** @deprecated Kept temporarily for older callers; audit pages no longer hydrate IDs. */
  approvedQuestionIds?: string[];
  /** @deprecated The audit dashboard now derives counts from its paged scope. */
  workingDistribution?: WorkingDistribution;
  /** @deprecated Full audit questions must be fetched through the audit endpoint. */
  workingQuestions?: AuditQuestion[];
}) {
  void approvedQuestionIds;
  void workingDistribution;
  void workingQuestions;
  const [sets, setSets] = useState(questionSets);
  const [unassignedCount, setUnassignedCount] = useState(unassignedQuestionCount);
  const [selectedSetId, setSelectedSetId] = useState(questionSets[0]?.id ?? '');
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? '');
  const [scope, setScope] = useState<DatasetAuditScope>(questionSets.length ? 'set' : 'unassigned');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [auditPage, setAuditPage] = useState<DatasetAuditQuestionPage>(emptyPage);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditQuestion | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [newSetTitle, setNewSetTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const scopeId = scope === 'set' ? selectedSetId : scope === 'version' ? selectedVersionId : '';
  const selectedSet = sets.find((item) => item.id === selectedSetId) ?? null;
  const selectedVersion = versions.find((item) => item.id === selectedVersionId) ?? null;

  function evictDetail() {
    detailSequence.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setExpandedKey(null);
    setDetail(null);
    setDetailError('');
    setDetailLoading(false);
  }

  useEffect(() => () => {
    detailSequence.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
  }, []);

  useEffect(() => {
    detailSequence.current += 1;
    detailAbort.current?.abort();
    detailAbort.current = null;
    const sequence = ++requestSequence.current;
    void Promise.resolve().then(() => {
      if (requestSequence.current !== sequence) return null;
      setLoading(true);
      setLoadError('');
      setExpandedKey(null);
      setDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return fetch(auditUrl(scope, scopeId, page, filters), { cache: 'no-store' });
    })
      .then(async (response) => {
        if (!response) return null;
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? '문항 목록을 불러오지 못했습니다.');
        if (!Array.isArray(body.items) || typeof body.total !== 'number') {
          throw new Error('문항 목록 응답이 올바르지 않습니다.');
        }
        return body as DatasetAuditQuestionPage;
      })
      .then((body) => {
        if (body && requestSequence.current === sequence) setAuditPage(body);
      })
      .catch((error: unknown) => {
        if (requestSequence.current === sequence) setLoadError(error instanceof Error ? error.message : '문항 목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (requestSequence.current === sequence) setLoading(false);
      });
  }, [scope, scopeId, page, filters, refreshKey]);

  function resetAudit(nextScope = scope) {
    evictDetail();
    setScope(nextScope);
    setPage(1);
    setFilters(emptyFilters);
  }

  function updateFilter(key: keyof Filters, value: string) {
    evictDetail();
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function refreshUnassignedCount() {
    try {
      const response = await fetch('/api/datasets/audit?scope=unassigned&pageSize=1', { cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json() as { total?: unknown };
      if (typeof body.total === 'number') setUnassignedCount(body.total);
    } catch {
      // Keep the last known metadata count; the active list has its own error state.
    }
  }

  async function createSet() {
    const title = newSetTitle.trim();
    if (!title) return;
    setBusy(true); setNotice('');
    try {
      const response = await fetch('/api/question-sets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? '질문 세트를 만들지 못했습니다.');
      const item = body.item as QuestionSetAuditMetadata;
      setSets((current) => [item, ...current]);
      setSelectedSetId(item.id);
      setNewSetTitle('');
      resetAudit('set');
      setNotice(`질문 세트 “${item.title}”을 만들었습니다.`);
    } catch {
      setNotice('질문 세트를 만들지 못했습니다. 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  async function deleteSet(set: QuestionSetAuditMetadata) {
    if (!confirm(`“${set.title}” 질문 세트를 삭제하시겠습니까? 발행된 데이터셋은 유지됩니다.`)) return;
    setBusy(true); setNotice('');
    try {
      const response = await fetch(`/api/question-sets/${set.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? '질문 세트를 삭제하지 못했습니다.');
      const remaining = sets.filter((item) => item.id !== set.id);
      const nextSelectedSetId = selectedSetId === set.id
        ? remaining[0]?.id ?? ''
        : selectedSetId;
      const nextScope = scope === 'set' && !nextSelectedSetId ? 'unassigned' : scope;
      setSets(remaining);
      setSelectedSetId(nextSelectedSetId);
      resetAudit(nextScope);
      setRefreshKey((value) => value + 1);
      void refreshUnassignedCount();
      setNotice(`질문 세트 “${set.title}”을 삭제했습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '질문 세트를 삭제하지 못했습니다. 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  async function removeQuestion(question: AuditQuestionListItem) {
    if (!selectedSet) return;
    setBusy(true); setNotice('');
    try {
      const response = await fetch(`/api/question-sets/${selectedSet.id}/questions/${question.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? '문항을 세트에서 제거하지 못했습니다.');
      setSets((current) => current.map((item) => item.id === selectedSet.id ? { ...item, questionCount: Math.max(0, item.questionCount - 1), updatedAt: new Date().toISOString() } : item));
      setPage(1);
      setRefreshKey((value) => value + 1);
      evictDetail();
      void refreshUnassignedCount();
      setNotice(`${question.publicId} 문항을 세트에서 제거했습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '문항을 세트에서 제거하지 못했습니다. 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  async function publishSet() {
    if (!selectedSet || !selectedSet.questionCount) return;
    setBusy(true); setNotice('');
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const version = `official-${date.replaceAll('-', '')}-${Date.now().toString(36)}`;
    try {
      const response = await fetch(`/api/question-sets/${selectedSet.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, title: selectedSet.title, description: selectedSet.description ?? undefined }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? '데이터셋을 발행하지 못했습니다.');
      setNotice(`${selectedSet.title}을 ${version} 데이터셋으로 발행했습니다. 해시: ${body.contentHash}`);
      window.location.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '데이터셋을 발행하지 못했습니다. 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  function toggleDetail(question: AuditQuestionListItem, open: boolean) {
    const key = questionKey(question);
    if (!open) {
      if (expandedKey === key) evictDetail();
      return;
    }
    evictDetail();
    setExpandedKey(key); setDetail(null); setDetailError(''); setDetailLoading(true);
    const params = new URLSearchParams({ scope, questionId: question.id, revision: String(question.revision) });
    if (scope !== 'unassigned') params.set('scopeId', scopeId);
    const sequence = ++detailSequence.current;
    const abort = new AbortController();
    detailAbort.current = abort;
    void fetch(`/api/datasets/audit?${params}`, {
      cache: 'no-store',
      signal:abort.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? '감사 상세를 불러오지 못했습니다.');
        return body.item as AuditQuestion;
      })
      .then((item) => {
        if (
          !abort.signal.aborted
          && detailAbort.current === abort
          && detailSequence.current === sequence
          && item.id === question.id
          && item.revision === question.revision
        ) setDetail(item);
      })
      .catch((error: unknown) => {
        if (
          !abort.signal.aborted
          && detailAbort.current === abort
          && detailSequence.current === sequence
        ) {
          setDetailError(error instanceof Error ? error.message : '감사 상세를 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (detailAbort.current === abort) detailAbort.current = null;
        if (detailSequence.current === sequence) setDetailLoading(false);
      });
  }

  const totalPages = Math.max(1, Math.ceil(auditPage.total / auditPage.pageSize));
  const scopeCount = scope === 'set' ? selectedSet?.questionCount ?? 0 : scope === 'version' ? selectedVersion?.questionCount ?? 0 : unassignedCount;

  return <div className="workflow-page dataset-workspace">
    <header className="page-heading"><div><span className="eyebrow">DATASET / RESEARCH AUDIT</span><h1>데이터셋 관리</h1><p>승인 문항을 편집 가능한 질문 세트로 구성하고, 실행 시점에는 revision이 고정된 불변 데이터셋으로 발행합니다.</p></div><div className="heading-actions">{selectedSet ? <a className="button" href={`/api/question-sets/${selectedSet.id}/export`} download><Download size={15} /> 선택 세트 JSON</a> : <button className="button" type="button" disabled><Download size={15} /> 선택 세트 JSON</button>}<button className="button primary" disabled={!selectedSet?.questionCount || busy} onClick={publishSet}><LockKeyhole size={15} /> 벤치마크 데이터셋 발행</button></div></header>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    <section className="panel question-set-manager"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>편집 가능한 질문 세트</h2></div><span className="count-label mono">{sets.length} SETS</span></div>
      <div className="question-set-create"><label>새 질문 세트 이름<input value={newSetTitle} onChange={(event) => setNewSetTitle(event.target.value)} placeholder="예: 중학교 과학 선수관계" maxLength={200}/></label><button className="button primary" type="button" disabled={!newSetTitle.trim() || busy} onClick={createSet}><Plus size={15} /> 질문 세트 생성</button></div>
      {sets.length ? <div className="question-set-list" role="list" aria-label="질문 세트 목록">{sets.map((set) => <div key={set.id} className={set.id === selectedSetId ? 'selected' : ''} role="listitem"><button type="button" className="question-set-select" onClick={() => { setSelectedSetId(set.id); resetAudit('set'); }}><FolderKanban size={17}/><span><strong>{set.title}</strong><small>{set.questionCount}문항 · {set.description || '설명 없음'}</small></span></button><button type="button" className="icon-button danger" aria-label={`${set.title} 삭제`} disabled={busy} onClick={() => deleteSet(set)}><Trash2 size={15}/></button></div>)}</div> : <div className="table-empty"><FolderKanban size={22}/><strong>아직 질문 세트가 없습니다.</strong></div>}
    </section>
    <section className="panel version-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>불변 버전</h2></div><span className="count-label mono">{versions.length} VERSIONS</span></div>{versions.length === 0 ? <div className="table-empty"><Archive size={22}/><strong>발행된 데이터셋 버전이 없습니다.</strong></div> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>버전</th><th>제목</th><th className="numeric">문항</th><th>내용 해시</th></tr></thead><tbody>{versions.map((version) => <tr key={version.id}><td className="mono"><strong>{version.version}</strong></td><td>{version.title}</td><td className="numeric mono">{version.questionCount}</td><td className="mono">{version.contentHash.slice(0, 16)}…</td></tr>)}</tbody></table></div>}</section>
    <section className="panel dataset-audit-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>문항 연구 감사</h2></div><span className="count-label mono">{auditPage.total} / {scopeCount}</span></div>
      <p className="audit-intro">현재 범위의 문항 요약만 페이지 단위로 불러옵니다. 카드 열기에서만 질문·근거·provenance 전체를 조회합니다.</p>
      <div className="audit-tabs" role="tablist" aria-label="데이터셋 문항 범위"><button type="button" role="tab" aria-selected={scope === 'set'} disabled={!sets.length} onClick={() => resetAudit('set')}>현재 질문 세트 ({selectedSet?.questionCount ?? 0})</button><button type="button" role="tab" aria-selected={scope === 'unassigned'} onClick={() => resetAudit('unassigned')}>미분류 승인 문항 ({unassignedCount})</button><button type="button" role="tab" aria-selected={scope === 'version'} disabled={!versions.length} onClick={() => resetAudit('version')}>불변 버전 ({versions.length})</button></div>
      {scope === 'set' && <label className="version-audit-selector">감사할 질문 세트<select value={selectedSetId} onChange={(event) => { setSelectedSetId(event.target.value); setPage(1); setExpandedKey(null); setDetail(null); }}>{sets.map((set) => <option key={set.id} value={set.id}>{set.title} · {set.questionCount}문항</option>)}</select></label>}
      {scope === 'version' && <label className="version-audit-selector">감사할 불변 버전<select value={selectedVersionId} onChange={(event) => { setSelectedVersionId(event.target.value); setPage(1); setExpandedKey(null); setDetail(null); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.version} · {version.title}</option>)}</select></label>}
      <div className="audit-filter-grid"><label className="audit-search"><Search size={15}/><span className="sr-only">문항 검색</span><input aria-label="문항 검색" value={filters.query} onChange={(event) => updateFilter('query', event.target.value)} placeholder="ID 또는 질문 검색"/></label>{(['purpose', 'difficulty', 'questionType', 'evidenceMode'] as const).map((key) => <label key={key}><span className="sr-only">{key} 필터</span><input aria-label={`${key} 필터`} value={filters[key]} onChange={(event) => updateFilter(key, event.target.value)} placeholder={`${key} 필터`}/></label>)}<button className="button subtle" type="button" onClick={() => { setFilters(emptyFilters); setPage(1); }}>필터 초기화</button></div>
      {loading ? <div className="table-empty"><strong>문항 목록을 불러오는 중입니다.</strong></div> : loadError ? <div className="table-empty" role="alert"><strong>{loadError}</strong><button className="button" type="button" onClick={() => setRefreshKey((value) => value + 1)}>다시 시도</button></div> : auditPage.items.length ? <div className="question-audit-list">{auditPage.items.map((question) => { const key = questionKey(question); return <div className="managed-question-row" key={`${scope}-${key}`}>{scope === 'set' && <button className="button danger compact" type="button" aria-label={`${question.publicId} 세트에서 제거`} disabled={busy} onClick={() => removeQuestion(question)}><X size={14}/> 세트에서 제거</button>}<QuestionAuditCard question={question} detail={expandedKey === key ? detail : null} immutable={scope === 'version'} expanded={expandedKey === key} loading={expandedKey === key && detailLoading} error={expandedKey === key ? detailError : ''} onToggle={(open) => toggleDetail(question, open)}/></div>; })}</div> : <div className="table-empty"><Search size={20}/><strong>조건에 맞는 문항이 없습니다.</strong></div>}
      <div className="heading-actions"><button className="button" type="button" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>이전</button><span className="mono">{page} / {totalPages} · {auditPage.total}문항</span><button className="button" type="button" disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}>다음</button></div>
    </section>
  </div>;
}
