"use client";

import { useMemo, useState } from "react";
import { BookOpen, Check, Clock3, Edit3, FolderPlus, Layers3, Trash2 } from "lucide-react";

type BenchmarkDesign = {
  taskType: string;
  targetConcept: string;
  prerequisiteConcepts: Array<{ concept: string; role: string }>;
  prerequisiteRelations: Array<{
    fromConcept: string;
    toConcept: string;
    explanation: string;
  }>;
  requiredReasoningSteps: string[];
  failureSignals: string[];
};
export type ReviewQuestion = {
  id: string;
  public_id: string;
  status: string;
  subject: string;
  grade: string;
  purpose: string;
  difficulty: string;
  question_text: string;
  answer_text: string;
  scoring_criteria: Array<{ key: string; label?: string; maxScore: number }>;
  evidence_summary: string | null;
  quality_scores: { benchmarkDesign?: BenchmarkDesign };
};

export type ReviewQuestionSet = {
  id: string;
  title: string;
  description: string | null;
  questionCount: number;
};

export function ReviewWorkspace({
  questions,
  questionSets = [],
}: {
  questions: ReviewQuestion[];
  questionSets?: ReviewQuestionSet[];
}) {
  const [items, setItems] = useState(questions);
  const [sets, setSets] = useState(questionSets);
  const [selectedId, setSelectedId] = useState<string | null>(
    questions[0]?.id ?? null,
  );
  const selected = useMemo(
    () => items.find((question) => question.id === selectedId) ?? null,
    [items, selectedId],
  );
  const [questionText, setQuestionText] = useState(
    selected?.question_text ?? "",
  );
  const [answerText, setAnswerText] = useState(selected?.answer_text ?? "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [targetMode, setTargetMode] = useState<"existing" | "new">(
    questionSets.length ? "existing" : "new",
  );
  const [selectedSetId, setSelectedSetId] = useState(
    questionSets[0]?.id ?? "",
  );
  const [newSetTitle, setNewSetTitle] = useState("");
  function selectQuestion(question: ReviewQuestion | null) {
    setSelectedId(question?.id ?? null);
    setQuestionText(question?.question_text ?? "");
    setAnswerText(question?.answer_text ?? "");
  }
  async function review(
    action: "APPROVE" | "EDIT_AND_APPROVE" | "HOLD" | "REOPEN" | "DELETE",
  ) {
    if (!selected) return;
    const approves = action === "APPROVE" || action === "EDIT_AND_APPROVE";
    if (
      approves &&
      ((targetMode === "existing" && !selectedSetId) ||
        (targetMode === "new" && !newSetTitle.trim()))
    ) {
      setNotice("승인할 기존 질문 세트를 선택하거나 새 세트 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/questions/${selected.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          questionText,
          answerText,
          scoringCriteria: selected.scoring_criteria,
          note:
            action === "EDIT_AND_APPROVE"
              ? "검수 화면 수정 후 승인"
              : undefined,
          targetSet: approves
            ? targetMode === "existing"
              ? { kind: "existing", id: selectedSetId }
              : { kind: "new", title: newSetTitle.trim() }
            : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        setNotice(body.message ?? "검수 작업을 저장하지 못했습니다.");
      else if (action === "HOLD" || action === "REOPEN")
        setItems((current) =>
          current.map((item) =>
            item.id === selected.id
              ? { ...item, status: action === "HOLD" ? "HELD" : "IN_REVIEW" }
              : item,
          ),
        );
      else {
        if (body.questionSet) {
          setSets((current) => {
            const existing = current.find(
              (set) => set.id === body.questionSet.id,
            );
            if (existing) {
              return current.map((set) =>
                set.id === body.questionSet.id
                  ? { ...set, questionCount: body.questionSet.questionCount }
                  : set,
              );
            }
            return [...current, body.questionSet];
          });
          setSelectedSetId(body.questionSet.id);
          setTargetMode("existing");
          setNewSetTitle("");
        }
        const remaining = items.filter((item) => item.id !== selected.id);
        setItems(remaining);
        selectQuestion(remaining[0] ?? null);
      }
      if (response.ok)
        setNotice(
          action === "DELETE"
            ? "문항을 삭제했습니다."
            : action === "HOLD"
              ? "문항을 보류했습니다."
              : action === "REOPEN"
                ? "문항을 검수 대기 상태로 되돌렸습니다."
                : "문항을 승인했습니다.",
        );
    } catch {
      setNotice("검수 작업을 저장하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-page review-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">QUESTIONS / REVIEW</span>
          <h1>질문 검수</h1>
          <p>
            문항 표현, 원자 채점 기준, 교과서 근거를 함께 확인하고 승인합니다.
          </p>
        </div>
        <span className="review-count mono">{items.length} WAITING</span>
      </header>
      {notice && (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      )}
      <div className="review-grid">
        <section className="panel review-queue">
          <div className="panel-heading">
            <div>
              <span className="section-index mono">01</span>
              <h2>검수 대기열</h2>
            </div>
          </div>
          {items.length === 0 ? (
            <div className="small-empty">검수할 문항이 없습니다.</div>
          ) : (
            items.map((question) => (
              <button
                className={question.id === selectedId ? "selected" : ""}
                onClick={() => selectQuestion(question)}
                key={question.id}
              >
                <span className="mono">{question.public_id}</span>
                <strong>{question.question_text}</strong>
                <small>
                  {question.subject} · {question.grade} · {question.difficulty}{" "}
                  · {question.status}
                </small>
              </button>
            ))
          )}
        </section>
        <section className="panel review-editor">
          <div className="panel-heading">
            <div>
              <span className="section-index mono">02</span>
              <h2>문항·모범 답안</h2>
            </div>
          </div>
          {selected ? (
            <div className="editor-content">
              <div className="question-meta">
                <span>{selected.subject}</span>
                <span>{selected.grade}</span>
                <span>{selected.purpose}</span>
              </div>
              <label>
                질문
                <textarea
                  value={questionText}
                  onChange={(event) => setQuestionText(event.target.value)}
                />
              </label>
              <label>
                모범 답안
                <textarea
                  value={answerText}
                  onChange={(event) => setAnswerText(event.target.value)}
                />
              </label>
              <h3>원자 채점 기준</h3>
              <div className="rubric-list">
                {selected.scoring_criteria.map((criterion) => (
                  <div key={criterion.key}>
                    <span>{criterion.label ?? criterion.key}</span>
                    <strong className="mono">{criterion.maxScore}점</strong>
                  </div>
                ))}
              </div>
              <section className="review-set-target" aria-label="승인 대상 질문 세트">
                <div className="review-set-target-heading">
                  <div>
                    <Layers3 size={16} />
                    <strong>승인 대상 질문 세트</strong>
                  </div>
                  <small>승인한 revision이 선택한 세트에 고정됩니다.</small>
                </div>
                <div className="segmented-control" role="group" aria-label="질문 세트 지정 방식">
                  <button
                    type="button"
                    aria-pressed={targetMode === "existing"}
                    disabled={!sets.length}
                    onClick={() => setTargetMode("existing")}
                  >
                    기존 세트에 승인
                  </button>
                  <button
                    type="button"
                    aria-pressed={targetMode === "new"}
                    onClick={() => setTargetMode("new")}
                  >
                    새 세트에 승인
                  </button>
                </div>
                {targetMode === "existing" ? (
                  <label>
                    승인할 질문 세트
                    <select
                      value={selectedSetId}
                      onChange={(event) => setSelectedSetId(event.target.value)}
                    >
                      {sets.map((set) => (
                        <option key={set.id} value={set.id}>
                          {set.title} · {set.questionCount}문항
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    새 질문 세트 이름
                    <span className="input-with-icon">
                      <FolderPlus size={15} />
                      <input
                        value={newSetTitle}
                        onChange={(event) => setNewSetTitle(event.target.value)}
                        placeholder="예: 중학교 과학 선수관계"
                        maxLength={200}
                      />
                    </span>
                  </label>
                )}
              </section>
            </div>
          ) : (
            <div className="editor-content empty-editor">
              <h3>문항을 선택하세요</h3>
              <p>
                왼쪽에서 검수할 문항을 선택하면 질문과 모범 답안이 표시됩니다.
              </p>
              <h3>원자 채점 기준</h3>
              <p>선택한 문항의 채점 항목이 표시됩니다.</p>
            </div>
          )}
          <div className="review-actions">
            {selected?.status === "HELD" ? (
              <button
                className="button"
                disabled={busy}
                onClick={() => review("REOPEN")}
              >
                <Clock3 size={14} /> 검수 재개
              </button>
            ) : (
              <button
                className="button"
                disabled={!selected || busy}
                onClick={() => review("HOLD")}
              >
                <Clock3 size={14} /> 보류
              </button>
            )}
            <button
              className="button danger"
              disabled={!selected || busy}
              onClick={() => review("DELETE")}
            >
              <Trash2 size={14} /> 삭제
            </button>
            <button
              className="button"
              disabled={
                !selected ||
                selected.status === "HELD" ||
                busy ||
                (targetMode === "existing" ? !selectedSetId : !newSetTitle.trim())
              }
              onClick={() => review("EDIT_AND_APPROVE")}
            >
              <Edit3 size={14} /> 수정 후 승인
            </button>
            <button
              className="button primary"
              disabled={
                !selected ||
                selected.status === "HELD" ||
                busy ||
                (targetMode === "existing" ? !selectedSetId : !newSetTitle.trim())
              }
              onClick={() => review("APPROVE")}
            >
              <Check size={14} /> 승인
            </button>
          </div>
        </section>
        <aside className="panel evidence-panel">
          <div className="panel-heading">
            <div>
              <span className="section-index mono">03</span>
                <h2>교과서 근거</h2>
            </div>
          </div>
          <div className="evidence-content">
            <BookOpen size={20} />
            <strong>
              {selected ? "선수관계 벤치마크 청사진" : "근거 대기"}
            </strong>
            {selected?.quality_scores?.benchmarkDesign ? (
              <div className="benchmark-design">
                <p>
                  <b>측정 과제</b>{" "}
                  {selected.quality_scores.benchmarkDesign.taskType}
                </p>
                <p>
                  <b>목표 개념</b>{" "}
                  {selected.quality_scores.benchmarkDesign.targetConcept}
                </p>
                <h4>선수 개념</h4>
                {selected.quality_scores.benchmarkDesign.prerequisiteConcepts.map(
                  (concept) => (
                    <p key={concept.concept}>
                      <b>{concept.concept}</b> — {concept.role}
                    </p>
                  ),
                )}
                <h4>관계</h4>
                {selected.quality_scores.benchmarkDesign.prerequisiteRelations.map(
                  (relation, index) => (
                    <p
                      key={`${relation.fromConcept}-${relation.toConcept}-${index}`}
                    >
                      <b>
                        {relation.fromConcept} → {relation.toConcept}
                      </b>
                      <br />
                      {relation.explanation}
                    </p>
                  ),
                )}
                <h4>필수 추론 단계</h4>
                <ol>
                  {selected.quality_scores.benchmarkDesign.requiredReasoningSteps.map(
                    (step) => (
                      <li key={step}>{step}</li>
                    ),
                  )}
                </ol>
                <h4>대표 실패 신호</h4>
                <ul>
                  {selected.quality_scores.benchmarkDesign.failureSignals.map(
                    (signal) => (
                      <li key={signal}>{signal}</li>
                    ),
                  )}
                </ul>
              </div>
            ) : (
              <p>이전 방식으로 생성되어 선수관계 청사진이 없습니다.</p>
            )}
            <h4>교과서 근거 요약</h4>
            <p>
              {selected?.evidence_summary ?? "선택한 문항의 근거가 표시됩니다."}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
