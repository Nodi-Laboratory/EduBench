"use client";

import { useMemo, useState } from "react";
import { BookOpen, Check, Clock3, Edit3, Trash2 } from "lucide-react";

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

export function ReviewWorkspace({
  questions,
}: {
  questions: ReviewQuestion[];
}) {
  const [items, setItems] = useState(questions);
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
  function selectQuestion(question: ReviewQuestion | null) {
    setSelectedId(question?.id ?? null);
    setQuestionText(question?.question_text ?? "");
    setAnswerText(question?.answer_text ?? "");
  }
  async function review(
    action: "APPROVE" | "EDIT_AND_APPROVE" | "HOLD" | "DELETE",
  ) {
    if (!selected) return;
    setBusy(true);
    setNotice("");
    const response = await fetch(`/api/questions/${selected.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        questionText,
        answerText,
        scoringCriteria: selected.scoring_criteria,
        note:
          action === "EDIT_AND_APPROVE" ? "검수 화면 수정 후 승인" : undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok)
      setNotice(body.message ?? "검수 작업을 저장하지 못했습니다.");
    else if (action === "HOLD")
      setItems((current) =>
        current.map((item) =>
          item.id === selected.id ? { ...item, status: "HELD" } : item,
        ),
      );
    else {
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
            : "문항을 승인했습니다.",
      );
    setBusy(false);
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
            <button
              className="button"
              disabled={!selected || busy}
              onClick={() => review("HOLD")}
            >
              <Clock3 size={14} /> 보류
            </button>
            <button
              className="button danger"
              disabled={!selected || busy}
              onClick={() => review("DELETE")}
            >
              <Trash2 size={14} /> 삭제
            </button>
            <button
              className="button"
              disabled={!selected || busy}
              onClick={() => review("EDIT_AND_APPROVE")}
            >
              <Edit3 size={14} /> 수정 후 승인
            </button>
            <button
              className="button primary"
              disabled={!selected || busy}
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
