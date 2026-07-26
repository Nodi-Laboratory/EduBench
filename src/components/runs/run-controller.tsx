'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CirclePause, CirclePlay, RefreshCcw, RotateCcw, Square, StopCircle } from 'lucide-react';
import { JsonBlock } from '@/components/ui/json-block';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';
import { useCursorEventStream } from '@/hooks/use-cursor-event-stream';

type Run = { id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; dataset_version: string; score_version: string; price_profile_version: string; created_at: string; last_scoring_error?: { code?: string; message?: string; attempts?: number; retryAt?:string | null; retryDelayMs?:number | null } | null };
type Model = { id: string; provider_key?: string; display_name: string; blind_id: string; model_id: string; protocol: string; concurrency: number };
type Profile = { version: string; title: string; metrics: string[]; weights?: Record<string, number>; rubricPrompt: string; judgeProvider: string | null; judgeModel: string | null; contentHash: string; dynamicMetrics: string[]; snapshotProvenance?: string };
type ScoringEngine = {
  id:string | null;
  version:string | null;
  title:string | null;
  definition:unknown;
  contentHash:string | null;
  snapshotProvenance:string | null;
  verified:boolean;
};
type JudgeInvocation = {
  id:string;
  parentInvocationId:string | null;
  invocationKind:string;
  attempt:number;
  logicalKey:string;
  state:string;
  requestedMetricKeys:string[];
  resolvedMetricKeys:string[];
  missingMetricKeys:string[];
  requestSnapshot:unknown;
  requestHash:string;
  providerKey:string;
  modelId:string;
  providerRequestId:string | null;
  responseModelId:string | null;
  responseModelSnapshot:string | null;
  finishReason:string | null;
  inputTokens:number | null;
  outputTokens:number | null;
  latencyMs:number | null;
  rawResponse:unknown;
  responseText:string | null;
  parsedResponse:unknown;
  errorCode:string | null;
  errorMessage:string | null;
  errorStage:string | null;
  requestedAt:string;
  responseReceivedAt:string | null;
  parsedAt:string | null;
  persistedAt:string | null;
  failedAt:string | null;
  updatedAt:string;
};
type Score = { metricKey: string; value: number | null; label: string | null; rationale: string | null; evidence: unknown; judgeProvider?: string | null; judgeModel?: string | null; judgeRequestId?:string | null; judgeInvocationId?:string | null; provenance?:string | null };
type RunItem = { id: string; state: string; attempts: number; maxAttempts?: number; errorCode: string | null; errorMessage: string | null; questionPublicId: string; questionText: string; providerKey: string; displayName: string; modelId: string; blindId: string; request: Record<string, unknown> | null; response: { text: string; raw: unknown; requestId: string | null; finishReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number | null; retryHistory: unknown } | null; requiredMetricKeys?:string[]; scores: Score[]; judgeInvocations?:JudgeInvocation[] };
type EventRecord = { id: string; type: string; data: Record<string, unknown> };
type SnapshotEvent = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};
const connectionLabels = {
  idle: '연결 대기',
  connecting: '연결 중',
  live: '실시간 연결',
  reconnecting: '재연결 중',
} as const;

const metricLabels: Record<string, string> = {
  accuracy:'정확성', faithfulness:'교과서 충실성', completeness:'완결성', curriculum_alignment:'교육과정 정합성',
  student_fit:'학생 수준 적합성', misconception:'오개념 대응', hallucination:'환각 억제', exact_match:'완전 일치',
  response_present:'응답 존재', target_concept_correctness:'목표 개념 정확성', prerequisite_identification:'선수 개념 식별',
  prerequisite_relation_accuracy:'선수 관계 방향 정확성', prerequisite_application:'선수 개념 적용',
  reasoning_chain_completeness:'추론 사슬 완결성', textbook_grounding:'교과서 근거 충실성',
};

export function RunController({
  initialRun,
  models,
  profile,
  scoringEngine,
  initialItems,
  initialEvents = [],
  initialEventCursor,
}: {
  initialRun: Run;
  models: Model[];
  profile: Profile;
  scoringEngine?:ScoringEngine;
  initialItems: RunItem[];
  initialEvents?: SnapshotEvent[];
  initialEventCursor?: string;
}) {
  const [run, setRun] = useState(initialRun);
  const [items, setItems] = useState(initialItems);
  const [engine, setEngine] = useState<ScoringEngine>(() => scoringEngine ?? {
    id:null,
    version:null,
    title:null,
    definition:null,
    contentHash:null,
    snapshotProvenance:null,
    verified:false,
  });
  const [events, setEvents] = useState<EventRecord[]>(() =>
    initialEvents.map((event) => ({
      id: event.id,
      type: event.event_type,
      data: { ...event.payload, createdAt: event.created_at },
    })));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modelFilter, setModelFilter] = useState('ALL');
  const [stateFilter, setStateFilter] = useState('ALL');
  const profileWeights = profile.weights ?? {};

  const refreshDetails = useCallback(async () => {
    const response = await fetch(`/api/runs/${run.id}/details?history=0`);
    if (!response.ok) return false;
    const body = await response.json();
    setRun(body.run); setItems(body.items);
    if (body.scoringEngine) setEngine(body.scoringEngine);
    return true;
  }, [run.id]);
  const coalescedRefresh = useCoalescedRefresh(async () => {
    if (!await refreshDetails()) {
      throw new Error('RUN_DETAILS_REFRESH_FAILED');
    }
  }, {
    retryLimit: 2,
    retryDelayMs: 300,
  });
  const stream = useCursorEventStream({
    aggregate: 'benchmark_run',
    id: run.id,
    initialCursor: initialEventCursor,
    enabled: initialEventCursor != null,
    onEvent(event) {
      const data: Record<string, unknown> = { ...event.payload, createdAt: event.createdAt };
      setEvents((current) => [
        ...current.filter((entry) => entry.id !== event.id).slice(-199),
        { id: event.id, type: event.eventType, data },
      ]);
      setRun((current) => ({
        ...current,
        state: typeof data.state === 'string' ? data.state : current.state,
        completed_items: typeof data.completedItems === 'number'
          ? data.completedItems
          : current.completed_items,
        failed_items: typeof data.failedItems === 'number'
          ? data.failedItems
          : current.failed_items,
        total_items: typeof data.totalItems === 'number'
          ? data.totalItems
          : current.total_items,
      }));
      coalescedRefresh();
    },
  });

  async function command(value: string) {
    setBusy(true); setNotice('');
    const response = await fetch(`/api/runs/${run.id}/commands`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ command:value }) });
    const body = await response.json();
    if (!response.ok) setNotice(body.message ?? body.code ?? '명령을 처리하지 못했습니다.');
    else {
      if (body.state) setRun((current) => ({ ...current, state:body.state }));
      if (typeof body.retried === 'number') setNotice(`실패 항목 ${body.retried}개를 재실행 대기 상태로 돌렸습니다.`);
      await refreshDetails();
    }
    setBusy(false);
    return response.ok;
  }

  const filteredItems = useMemo(() => items.filter((item) =>
    (modelFilter === 'ALL' || item.providerKey === modelFilter) && (stateFilter === 'ALL' || item.state === stateFilter),
  ), [items, modelFilter, stateFilter]);
  const states = [...new Set(items.map((item) => item.state))];
  const executedItems = run.completed_items + run.failed_items;
  const executionPercent = run.total_items ? Math.round((executedItems / run.total_items) * 100) : 0;
  const scoreEligibleItems = items.filter((item) => item.response != null);
  const requiredScorePairs = scoreEligibleItems.reduce(
    (total, item) => total + (item.requiredMetricKeys?.length ?? 0),
    0,
  );
  const scoredPairs = scoreEligibleItems.reduce((total, item) => {
    const stored = new Set(item.scores.map((score) => score.metricKey));
    return total + (item.requiredMetricKeys ?? [])
      .filter((metric) => stored.has(metric)).length;
  }, 0);
  const scoringPercent = requiredScorePairs
    ? Math.round((scoredPairs / requiredScorePairs) * 100)
    : 0;
  const scoringCoverage = requiredScorePairs
    ? `${scoredPairs} / ${requiredScorePairs} 지표`
    : '기록 없음';
  const legacyPartial = items.length < executedItems;

  return <div className="workflow-page">
    <header className="page-heading"><div><Link className="text-link" href="/runs"><ArrowLeft size={13}/> 실행 목록</Link><span className="eyebrow mono">{run.public_id}</span><h1>{run.title}</h1><p>{run.dataset_version} · {run.score_version} · {run.price_profile_version}</p></div><div className="heading-actions">
      {run.state === 'DRAFT' && <button className="button primary" disabled={busy} onClick={async () => { if (await command('QUEUE')) await command('START'); }}><CirclePlay size={15}/> 실행 시작</button>}
      {['RUNNING','SCORING'].includes(run.state) && <><button className="button" disabled={busy} onClick={() => command('PAUSE')}><CirclePause size={15}/> {run.state === 'SCORING' ? '채점 일시정지' : '일시정지'}</button><button className="button" disabled={busy} onClick={() => command('STOP')}><StopCircle size={15}/> {run.state === 'SCORING' ? '채점 중지' : '작업 중지'}</button></>}
      {['PAUSED','STOPPED'].includes(run.state) && <button className="button primary" disabled={busy} onClick={() => command('RESUME')}><CirclePlay size={15}/> 남은 작업 재개</button>}
      {run.failed_items > 0 && <button className="button" disabled={busy} onClick={() => command('RETRY_FAILED')}><RotateCcw size={15}/> 실패 항목 재시도</button>}
      {run.state === 'FAILED' && run.last_scoring_error && <button className="button primary" disabled={busy} onClick={() => command('RETRY_SCORING')}><RotateCcw size={15}/> 채점 재개</button>}
      {['QUEUED','RUNNING','SCORING','PAUSING','PAUSED','STOPPING','STOPPED'].includes(run.state) && <button className="button danger" disabled={busy} onClick={() => command('CANCEL')}><Square size={14}/> 영구 취소</button>}
    </div></header>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {run.last_scoring_error && <div className="result-warning"><strong>{run.last_scoring_error.code ?? 'SCORING_FAILED'}</strong> {run.last_scoring_error.message} · 시도 {run.last_scoring_error.attempts ?? 1}회{run.last_scoring_error.retryAt ? ` · 다음 자동 재시도 ${new Date(run.last_scoring_error.retryAt).toLocaleString('ko-KR')}` : ''}</div>}
    <section className="run-control-strip panel" role="region" aria-label="실행 및 채점 진행률">
      <div><span>STATE</span><strong className="mono">{run.state}</strong></div>
      <div><span>실행 진행</span><strong className="mono">{executedItems} / {run.total_items}</strong><div className="progress-track"><i style={{width:`${executionPercent}%`}}/></div><small>완료와 실패를 합친 모델 실행 처리량</small></div>
      <div><span>채점 범위</span><strong className="mono">{scoringCoverage}</strong><div className="progress-track"><i style={{width:`${scoringPercent}%`}}/></div><small>평가 가능한 저장 응답의 필수 지표별 실제 저장률{legacyPartial ? ' · legacy partial' : ''}</small></div>
      <div><span>SUCCEEDED / FAILED</span><strong className="mono">{run.completed_items} / {run.failed_items}</strong></div>
      <div><span>LIVE EVENT</span><strong><RefreshCcw size={13}/> {connectionLabels[stream.status]}</strong></div>
    </section>

    <section className="panel run-profile-panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>평가 프로필</h2></div><span className="count-label mono">불변 스냅샷 · {profile.version}</span></div>{profile.snapshotProvenance === 'LEGACY_BACKFILL_UNVERIFIED' && <p className="result-warning">이 실행은 생성 시점 스냅샷 출처가 검증되지 않았습니다. 공식 근거로 사용하지 말고 새 프로필과 새 실행을 생성하십시오.</p>}<details open><summary><strong>{profile.title}</strong> · exact Judge {profile.judgeProvider ?? '결정론적'} / {profile.judgeModel ?? '—'}</summary><div className="profile-detail"><p>{profile.rubricPrompt}</p><div className="metric-chip-list">{profile.metrics.map((metric) => { const weight=Object.prototype.hasOwnProperty.call(profileWeights, metric) ? profileWeights[metric] : metric === 'response_present' ? 0 : 1; return <span key={metric}>{metricLabels[metric] ?? metric}<small className="mono">{metric} · weight {weight}</small></span>; })}</div>{profile.dynamicMetrics.length > 0 && <><h3>선수관계 문항 추가 지표</h3><div className="metric-chip-list">{profile.dynamicMetrics.map((metric) => { const weight=Object.prototype.hasOwnProperty.call(profileWeights, metric) ? profileWeights[metric] : 1; return <span key={metric}>{metricLabels[metric] ?? metric}<small className="mono">{metric} · weight {weight}</small></span>; })}</div></>}<small className="mono">스냅샷 provenance {profile.snapshotProvenance ?? '—'} · 내용 해시 {profile.contentHash}</small></div></details></section>

    <section className="panel run-profile-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>채점 엔진</h2></div><span className="count-label mono">{engine.verified ? '검증된 불변 스냅샷' : '검증 불가'}</span></div>{!engine.verified && <p className="result-warning"><strong>채점 엔진 출처를 검증할 수 없습니다.</strong> 기존 실행의 엔진 정의를 추정하거나 복원하지 않습니다. 공식 근거가 필요하면 현재 엔진으로 새 실행을 생성하십시오.</p>}{engine.definition ? <details open><summary><strong>{engine.title ?? engine.version ?? '저장된 채점 엔진'}</strong> · {engine.version ?? '버전 기록 없음'}</summary><div className="profile-detail"><small className="mono">스냅샷 provenance {engine.snapshotProvenance ?? '기록 없음'} · 내용 해시 {engine.contentHash ?? '기록 없음'} · ID {engine.id ?? '기록 없음'}</small><details><summary>엔진 정의 전체 보기</summary><JsonBlock className="run-payload" value={engine.definition}/></details></div></details> : <p>저장된 채점 엔진 정의가 없습니다.</p>}</section>

    <section className="panel run-items-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>질문별 실행·채점 기록</h2></div><span className="count-label mono">{filteredItems.length} / {items.length} ITEMS</span></div><div className="run-item-filters"><label>모델<select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="ALL">전체</option>{models.map((model) => <option key={model.id} value={model.provider_key ?? model.blind_id}>{model.display_name}</option>)}</select></label><label>상태<select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="ALL">전체</option>{states.map((state) => <option key={state}>{state}</option>)}</select></label></div><div className="run-item-list">{filteredItems.map((item) => <details key={item.id} className={`run-item run-item-${item.state}`}><summary><span className="mono">{item.questionPublicId}</span><strong>{item.blindId} · {item.displayName}</strong><span className={`state-label state-${item.state}`}>{item.state}</span><small>시도 {item.attempts}/{item.maxAttempts ?? '—'}</small></summary><div className="run-item-body"><section><h3>질문</h3><p className="run-question">{item.questionText}</p></section><section><h3>실제 전송 프롬프트</h3>{item.request ? <><h4>System</h4><JsonBlock className="run-payload" value={item.request.system}/><h4>User</h4><JsonBlock className="run-payload" value={item.request.prompt}/><details><summary>전체 요청 스냅샷</summary><JsonBlock className="run-payload" value={item.request}/></details></> : <p>외부 요청 전에 실패했거나 아직 실행되지 않았습니다.</p>}</section><section><h3>모델 응답</h3>{item.response ? <><JsonBlock className="run-payload" value={item.response.text}/><p className="run-meta mono">request {item.response.requestId ?? '—'} · {item.response.latencyMs ?? '—'} ms · token {item.response.inputTokens ?? '—'} / {item.response.outputTokens ?? '—'}</p><details><summary>원본 응답·재시도 기록</summary><JsonBlock className="run-payload" value={{ raw:item.response.raw, retryHistory:item.response.retryHistory }}/></details></> : <p>저장된 응답이 없습니다.</p>}</section>{(item.errorCode || item.errorMessage) && <section className="run-error"><h3>실패 원인</h3><strong className="mono">{item.errorCode ?? 'EXECUTION_FAILED'}</strong><p>{item.errorMessage}</p></section>}<section><h3>Judge 채점 호출 감사</h3>{item.judgeInvocations?.length ? <details><summary>Judge 호출 {item.judgeInvocations.length}건</summary><div className="run-score-list">{item.judgeInvocations.map((invocation) => <details key={invocation.id}><summary><strong>{invocation.invocationKind} · {invocation.state}</strong><span className="mono">시도 {invocation.attempt}</span><small>{invocation.logicalKey}</small></summary><p className="run-meta mono">호출 {invocation.id} · parent {invocation.parentInvocationId ?? '—'} · {invocation.providerKey}/{invocation.modelId}</p><p className="run-meta mono">요청 {invocation.requestedAt} · 응답 {invocation.responseReceivedAt ?? '—'} · 파싱 {invocation.parsedAt ?? '—'} · 저장 {invocation.persistedAt ?? '—'}</p><details><summary>요청 스냅샷·해시</summary><JsonBlock className="run-payload" value={{ requestHash:invocation.requestHash, requestedMetricKeys:invocation.requestedMetricKeys, requestSnapshot:invocation.requestSnapshot }}/></details><details><summary>원본 Judge 응답</summary><JsonBlock className="run-payload" value={{ providerRequestId:invocation.providerRequestId, responseModelId:invocation.responseModelId, responseModelSnapshot:invocation.responseModelSnapshot, finishReason:invocation.finishReason, inputTokens:invocation.inputTokens, outputTokens:invocation.outputTokens, latencyMs:invocation.latencyMs, responseText:invocation.responseText, rawResponse:invocation.rawResponse }}/></details><details><summary>파싱 결과</summary><JsonBlock className="run-payload" value={{ resolvedMetricKeys:invocation.resolvedMetricKeys, missingMetricKeys:invocation.missingMetricKeys, parsedResponse:invocation.parsedResponse }}/></details>{(invocation.errorCode || invocation.errorMessage) && <div className="run-error"><strong className="mono">{invocation.errorCode ?? 'JUDGE_FAILED'}</strong><p>{invocation.errorMessage}</p><small className="mono">단계 {invocation.errorStage ?? '기록 없음'} · 실패 {invocation.failedAt ?? '기록 없음'}</small></div>}</details>)}</div></details> : <p>이 응답에 기록된 Judge 호출이 없습니다. 레거시 호출은 추정하여 생성하지 않습니다.</p>}</section><section><h3>점수와 판정 근거</h3>{item.scores.length ? <div className="run-score-list">{item.scores.map((score) => <details key={score.metricKey}><summary><strong>{metricLabels[score.metricKey] ?? score.metricKey}</strong><span className="mono">{score.value == null ? '—' : `${(score.value * 100).toFixed(1)}%`}</span><small>{score.label}</small></summary><p>{score.rationale}</p><JsonBlock className="run-payload" value={score.evidence}/><small>{score.judgeProvider ? `${score.judgeProvider} · ${score.judgeModel}` : '결정론적 채점'} · provenance {score.provenance ?? '기록 없음'} · invocation {score.judgeInvocationId ?? '—'}</small></details>)}</div> : <p>아직 저장된 점수가 없습니다.</p>}</section></div></details>)}</div></section>

    <section className="panel event-panel"><div className="panel-heading"><div><span className="section-index mono">04</span><h2>실시간 감사 이벤트</h2></div></div><div className="event-log">{events.length === 0 ? <p>SSE 이벤트를 기다리는 중입니다.</p> : events.slice().reverse().map((event) => <details key={`${event.id}-${event.type}`}><summary><span className="mono">#{event.id}</span><strong>{event.type}</strong><small>{String(event.data.createdAt ?? '')}</small></summary><JsonBlock className="run-payload" value={event.data}/></details>)}</div></section>
  </div>;
}
