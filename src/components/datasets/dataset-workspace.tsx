'use client';

import {
  Archive,
  Download,
  FolderKanban,
  LockKeyhole,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  AuditQuestion,
  DatasetAuditVersion,
  QuestionSetAudit,
} from '@/server/datasets/audit';
import { QuestionAuditCard } from '@/components/datasets/question-audit-card';

export type WorkingDistribution = {
  capabilities: Record<string, number>;
  responseFormats: Record<string, number>;
  evidenceModes: Record<string, number>;
};

function countBy(
  items: AuditQuestion[],
  key: 'purpose' | 'questionType' | 'evidenceMode',
) {
  return items.reduce<Record<string, number>>((result, item) => {
    result[item[key]] = (result[item[key]] ?? 0) + 1;
    return result;
  }, {});
}

function DistributionList({ values }: { values: Record<string, number> }) {
  const entries = Object.entries(values);
  const maximum = Math.max(1, ...entries.map(([, count]) => count));
  if (!entries.length) return <p className="empty-copy">표시할 문항이 없습니다.</p>;
  return (
    <div className="target-bars">
      {entries.map(([label, count]) => (
        <div key={label}>
          <div><span>{label}</span><strong className="mono">{count}</strong></div>
          <div className="progress-track">
            <span style={{ width: `${(count / maximum) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function filterOptions(
  items: AuditQuestion[],
  key: keyof Pick<
    AuditQuestion,
    'purpose' | 'difficulty' | 'questionType' | 'evidenceMode'
  >,
) {
  return [...new Set(items.map((item) => item[key]))].sort((a, b) =>
    a.localeCompare(b, 'ko'),
  );
}

export function DatasetWorkspace({
  approvedQuestionIds,
  workingDistribution,
  workingQuestions = [],
  questionSets = [],
  versions,
}: {
  approvedQuestionIds: string[];
  workingDistribution: WorkingDistribution;
  workingQuestions?: AuditQuestion[];
  questionSets?: QuestionSetAudit[];
  versions: DatasetAuditVersion[];
}) {
  void approvedQuestionIds;
  void workingDistribution;
  const [sets, setSets] = useState(questionSets);
  const [unassignedQuestions, setUnassignedQuestions] = useState(workingQuestions);
  const [selectedSetId, setSelectedSetId] = useState(questionSets[0]?.id ?? '');
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? '');
  const [scope, setScope] = useState<'set' | 'unassigned' | 'version'>(
    questionSets.length ? 'set' : 'unassigned',
  );
  const [newSetTitle, setNewSetTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [purpose, setPurpose] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [questionType, setQuestionType] = useState('');
  const [evidenceMode, setEvidenceMode] = useState('');

  const selectedSet =
    sets.find((set) => set.id === selectedSetId) ?? sets[0] ?? null;
  const selectedVersion =
    versions.find((version) => version.id === selectedVersionId) ??
    versions[0] ??
    null;
  const scopedQuestions = useMemo(() => {
    if (scope === 'set') return selectedSet?.questions ?? [];
    if (scope === 'version') return selectedVersion?.questions ?? [];
    return unassignedQuestions;
  }, [scope, selectedSet, selectedVersion, unassignedQuestions]);
  const filteredQuestions = useMemo(
    () =>
      scopedQuestions.filter((question) => {
        const needle = query.trim().toLocaleLowerCase('ko-KR');
        const haystack = [
          question.publicId,
          question.questionText,
          question.answerText,
          question.subject,
          question.grade,
          question.chapter,
          question.unit,
          question.purpose,
          question.benchmarkDesign?.targetConcept,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase('ko-KR');
        return (
          (!needle || haystack.includes(needle)) &&
          (!purpose || question.purpose === purpose) &&
          (!difficulty || question.difficulty === difficulty) &&
          (!questionType || question.questionType === questionType) &&
          (!evidenceMode || question.evidenceMode === evidenceMode)
        );
      }),
    [
      scopedQuestions,
      query,
      purpose,
      difficulty,
      questionType,
      evidenceMode,
    ],
  );
  const selectedDistribution = {
    capabilities: countBy(selectedSet?.questions ?? [], 'purpose'),
    responseFormats: countBy(selectedSet?.questions ?? [], 'questionType'),
    evidenceModes: countBy(selectedSet?.questions ?? [], 'evidenceMode'),
  };

  function clearFilters() {
    setQuery('');
    setPurpose('');
    setDifficulty('');
    setQuestionType('');
    setEvidenceMode('');
  }

  async function createSet() {
    const title = newSetTitle.trim();
    if (!title) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/question-sets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const body = await response.json();
      if (response.ok) {
        const item = body.item as QuestionSetAudit;
        setSets((current) => [item, ...current]);
        setSelectedSetId(item.id);
        setScope('set');
        setNewSetTitle('');
        setNotice(`질문 세트 “${item.title}”을 만들었습니다.`);
      } else {
        setNotice(body.message ?? '질문 세트를 만들지 못했습니다.');
      }
    } catch {
      setNotice('질문 세트를 만들지 못했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSet(set: QuestionSetAudit) {
    if (!confirm(`“${set.title}” 질문 세트를 삭제하시겠습니까? 발행된 데이터셋은 유지됩니다.`)) {
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`/api/question-sets/${set.id}`, {
        method: 'DELETE',
      });
      const body = await response.json();
      if (response.ok) {
        const remaining = sets.filter((item) => item.id !== set.id);
        const remainingMemberships = new Set(
          remaining.flatMap((item) =>
            item.questions.map((question) => question.id),
          ),
        );
        setUnassignedQuestions((current) => {
          const known = new Set(current.map((question) => question.id));
          return [
            ...current,
            ...set.questions
              .filter(
                (question) =>
                  !known.has(question.id) &&
                  !remainingMemberships.has(question.id),
              )
              .map((question) => ({ ...question, ordinal: null })),
          ];
        });
        setSets(remaining);
        setSelectedSetId(remaining[0]?.id ?? '');
        if (!remaining.length) setScope('unassigned');
        setNotice(`질문 세트 “${set.title}”을 삭제했습니다.`);
      } else {
        setNotice(body.message ?? '질문 세트를 삭제하지 못했습니다.');
      }
    } catch {
      setNotice('질문 세트를 삭제하지 못했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  async function removeQuestion(question: AuditQuestion) {
    if (!selectedSet) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(
        `/api/question-sets/${selectedSet.id}/questions/${question.id}`,
        { method: 'DELETE' },
      );
      const body = await response.json();
      if (response.ok) {
        const assignedElsewhere = sets.some(
          (set) =>
            set.id !== selectedSet.id &&
            set.questions.some((item) => item.id === question.id),
        );
        setSets((current) =>
          current.map((set) => {
            if (set.id !== selectedSet.id) return set;
            const questions = set.questions
              .filter((item) => item.id !== question.id)
              .map((item, index) => ({ ...item, ordinal: index + 1 }));
            return {
              ...set,
              questions,
              questionCount: questions.length,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
        if (!assignedElsewhere) {
          setUnassignedQuestions((current) =>
            current.some((item) => item.id === question.id)
              ? current
              : [...current, { ...question, ordinal: null }],
          );
        }
        setNotice(`${question.publicId} 문항을 세트에서 제거했습니다.`);
      } else {
        setNotice(body.message ?? '문항을 세트에서 제거하지 못했습니다.');
      }
    } catch {
      setNotice('문항을 세트에서 제거하지 못했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  async function publishSet() {
    if (!selectedSet?.questions.length) return;
    setBusy(true);
    setNotice('');
    const date = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    const version = `official-${date.replaceAll('-', '')}-${Date.now().toString(36)}`;
    try {
      const response = await fetch(
        `/api/question-sets/${selectedSet.id}/publish`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version,
            title: selectedSet.title,
            description: selectedSet.description ?? undefined,
          }),
        },
      );
      const body = await response.json();
      if (response.ok) {
        setNotice(
          `${selectedSet.title}을 ${version} 데이터셋으로 발행했습니다. 해시: ${body.contentHash}`,
        );
        window.location.reload();
      } else {
        setNotice(body.message ?? '데이터셋을 발행하지 못했습니다.');
      }
    } catch {
      setNotice('데이터셋을 발행하지 못했습니다. 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  function exportSet() {
    if (!selectedSet) return;
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), questionSet: selectedSet },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `edubench-question-set-${selectedSet.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="workflow-page dataset-workspace">
      <header className="page-heading">
        <div>
          <span className="eyebrow">DATASET / RESEARCH AUDIT</span>
          <h1>데이터셋 관리</h1>
          <p>
            승인 문항을 편집 가능한 질문 세트로 구성하고, 실행 시점에는
            revision이 고정된 불변 데이터셋으로 발행합니다.
          </p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={exportSet} disabled={!selectedSet}>
            <Download size={15} /> 선택 세트 JSON
          </button>
          <button
            className="button primary"
            disabled={!selectedSet?.questions.length || busy}
            onClick={publishSet}
          >
            <LockKeyhole size={15} /> 벤치마크 데이터셋 발행
          </button>
        </div>
      </header>

      {notice && <p className="inline-notice" role="status">{notice}</p>}

      <section className="panel question-set-manager">
        <div className="panel-heading">
          <div>
            <span className="section-index mono">01</span>
            <h2>편집 가능한 질문 세트</h2>
          </div>
          <span className="count-label mono">{sets.length} SETS</span>
        </div>
        <p className="audit-intro">
          검수 승인 시 문항이 선택한 세트에 들어갑니다. 여기서 세트나
          세트 내부 문항을 삭제해도 이미 발행한 데이터셋과 과거 실행은
          변경되지 않습니다.
        </p>
        <div className="question-set-create">
          <label>
            새 질문 세트 이름
            <input
              value={newSetTitle}
              onChange={(event) => setNewSetTitle(event.target.value)}
              placeholder="예: 중학교 과학 선수관계"
              maxLength={200}
            />
          </label>
          <button
            className="button primary"
            type="button"
            disabled={!newSetTitle.trim() || busy}
            onClick={createSet}
          >
            <Plus size={15} /> 질문 세트 생성
          </button>
        </div>
        {sets.length ? (
          <div className="question-set-layout">
            <div className="question-set-list" role="list" aria-label="질문 세트 목록">
              {sets.map((set) => (
                <div
                  key={set.id}
                  className={set.id === selectedSet?.id ? 'selected' : ''}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="question-set-select"
                    onClick={() => {
                      setSelectedSetId(set.id);
                      setScope('set');
                      clearFilters();
                    }}
                  >
                    <FolderKanban size={17} />
                    <span>
                      <strong>{set.title}</strong>
                      <small>{set.questionCount}문항 · {set.description || '설명 없음'}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`${set.title} 삭제`}
                    disabled={busy}
                    onClick={() => deleteSet(set)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            {selectedSet && (
              <div className="question-set-manifest">
                <div>
                  <span className="eyebrow">SELECTED SET</span>
                  <strong>{selectedSet.title}</strong>
                  <p>{selectedSet.description || '설명이 없습니다.'}</p>
                </div>
                <dl>
                  <div><dt>문항</dt><dd className="mono">{selectedSet.questionCount}</dd></div>
                  <div><dt>수정</dt><dd className="mono">{selectedSet.updatedAt.slice(0, 16).replace('T', ' ')}</dd></div>
                  <div><dt>세트 ID</dt><dd className="mono">{selectedSet.id}</dd></div>
                </dl>
              </div>
            )}
          </div>
        ) : (
          <div className="table-empty">
            <FolderKanban size={22} />
            <strong>아직 질문 세트가 없습니다.</strong>
            <span>위에서 세트를 만들거나 질문 검수 중 새 세트를 만드세요.</span>
          </div>
        )}
      </section>

      <div className="dataset-grid">
        <section className="panel">
          <div className="panel-heading">
            <div><span className="section-index mono">02</span><h2>질문 목적 분포</h2></div>
          </div>
          <DistributionList values={selectedDistribution.capabilities} />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div><span className="section-index mono">03</span><h2>형식·근거 모드</h2></div>
          </div>
          <DistributionList values={selectedDistribution.responseFormats} />
          <div className="evidence-mode-grid">
            {Object.entries(selectedDistribution.evidenceModes).map(([mode, count]) => (
              <div key={mode}><strong className="mono">{count}</strong><span>{mode}</span></div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel version-panel">
        <div className="panel-heading">
          <div><span className="section-index mono">04</span><h2>불변 버전</h2></div>
          <span className="count-label mono">{versions.length} VERSIONS</span>
        </div>
        {versions.length === 0 ? (
          <div className="table-empty">
            <Archive size={22} />
            <strong>발행된 데이터셋 버전이 없습니다.</strong>
            <span>질문이 포함된 세트를 벤치마크 데이터셋으로 발행하세요.</span>
          </div>
        ) : (
          <div className="data-table-wrap" role="region" aria-label="불변 데이터셋 목록" tabIndex={0}>
            <table className="data-table">
              <thead><tr><th>버전</th><th>제목</th><th className="numeric">문항</th><th>내용 해시</th><th>확정 일시</th></tr></thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td className="mono"><strong>{version.version}</strong></td>
                    <td>{version.title}</td>
                    <td className="numeric mono">{version.questionCount}</td>
                    <td className="mono">{version.contentHash.slice(0, 16)}…</td>
                    <td className="mono">{version.publishedAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel dataset-audit-panel">
        <div className="panel-heading">
          <div><span className="section-index mono">05</span><h2>문항 연구 감사</h2></div>
          <span className="count-label mono">{filteredQuestions.length} / {scopedQuestions.length}</span>
        </div>
        <p className="audit-intro">
          질문 세트의 편집 대상 revision과 발행 데이터셋에 고정된 revision을
          구분해 문항·근거·선수관계 설계를 추적합니다.
        </p>
        <div className="audit-tabs" role="tablist" aria-label="데이터셋 문항 범위">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'set'}
            disabled={!sets.length}
            onClick={() => { setScope('set'); clearFilters(); }}
          >
            현재 질문 세트 ({selectedSet?.questionCount ?? 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'unassigned'}
            onClick={() => { setScope('unassigned'); clearFilters(); }}
          >
            미분류 승인 문항 ({unassignedQuestions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'version'}
            disabled={!versions.length}
            onClick={() => { setScope('version'); clearFilters(); }}
          >
            불변 버전 ({versions.length})
          </button>
        </div>

        {scope === 'set' && sets.length > 0 && (
          <div className="version-audit-selector">
            <label>
              감사할 질문 세트
              <select
                value={selectedSet?.id ?? ''}
                onChange={(event) => {
                  setSelectedSetId(event.target.value);
                  clearFilters();
                }}
              >
                {sets.map((set) => (
                  <option key={set.id} value={set.id}>{set.title} · {set.questionCount}문항</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {scope === 'version' && versions.length > 0 && (
          <div className="version-audit-selector">
            <label>
              감사할 불변 버전
              <select
                value={selectedVersion?.id ?? ''}
                onChange={(event) => {
                  setSelectedVersionId(event.target.value);
                  clearFilters();
                }}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>{version.version} · {version.title}</option>
                ))}
              </select>
            </label>
            {selectedVersion && (
              <div className="version-manifest">
                <div>
                  <strong className="mono">{selectedVersion.version}</strong>
                  <span>{selectedVersion.title}</span>
                  <small>{selectedVersion.description || '설명 없음'}</small>
                </div>
                <div>
                  <span>상태 {selectedVersion.status}</span>
                  <span>문항 {selectedVersion.questionCount}</span>
                  <span>상위 버전 {selectedVersion.parentVersion ?? '없음'}</span>
                </div>
                <code>{selectedVersion.contentHash}</code>
              </div>
            )}
          </div>
        )}

        <div className="audit-filter-grid">
          <label className="audit-search">
            <Search size={15} />
            <span className="sr-only">문항 검색</span>
            <input
              aria-label="문항 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ID, 질문, 답안, 개념, 단원 검색"
            />
          </label>
          <label>
            <span className="sr-only">질문 목적 필터</span>
            <select aria-label="질문 목적 필터" value={purpose} onChange={(event) => setPurpose(event.target.value)}>
              <option value="">모든 질문 목적</option>
              {filterOptions(scopedQuestions, 'purpose').map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">난이도 필터</span>
            <select aria-label="난이도 필터" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option value="">모든 난이도</option>
              {filterOptions(scopedQuestions, 'difficulty').map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">문항 형식 필터</span>
            <select aria-label="문항 형식 필터" value={questionType} onChange={(event) => setQuestionType(event.target.value)}>
              <option value="">모든 문항 형식</option>
              {filterOptions(scopedQuestions, 'questionType').map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">근거 모드 필터</span>
            <select aria-label="근거 모드 필터" value={evidenceMode} onChange={(event) => setEvidenceMode(event.target.value)}>
              <option value="">모든 근거 모드</option>
              {filterOptions(scopedQuestions, 'evidenceMode').map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <button className="button subtle" type="button" onClick={clearFilters}>
            필터 초기화
          </button>
        </div>

        <div className="question-audit-list">
          {filteredQuestions.length ? (
            filteredQuestions.map((question) => (
              <div className="managed-question-row" key={`${scope}-${question.id}-${question.revision}`}>
                {scope === 'set' && (
                  <button
                    className="button danger compact"
                    type="button"
                    aria-label={`${question.publicId} 세트에서 제거`}
                    disabled={busy}
                    onClick={() => removeQuestion(question)}
                  >
                    <X size={14} /> 세트에서 제거
                  </button>
                )}
                <QuestionAuditCard
                  question={question}
                  immutable={scope === 'version'}
                />
              </div>
            ))
          ) : (
            <div className="table-empty">
              <Search size={20} />
              <strong>조건에 맞는 문항이 없습니다.</strong>
              <span>범위, 검색어나 필터를 변경하세요.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
