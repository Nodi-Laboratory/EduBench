'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CircleDot,
  Database,
  HardDrive,
  RefreshCw,
  ServerCog,
} from 'lucide-react';
import {
  compareEventCursors,
  parseEventCursor,
} from '@/domain/event-cursor';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';
import { InspectorDock } from './inspector-dock';
import type {
  ActiveOperation,
  ControlRoomEvent,
  ControlRoomFailure,
  ControlRoomSnapshot,
  InspectorRecord,
  PipelineStage,
} from './types';

const SNAPSHOT_ENDPOINT = '/api/research/control-room';
const STREAM_ENDPOINT = '/api/research/control-room/events';

type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

async function fetchControlRoomSnapshot() {
  const response = await fetch(SNAPSHOT_ENDPOINT, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`관제실 snapshot 요청 실패 (${response.status})`);
  }
  return response.json() as Promise<ControlRoomSnapshot>;
}

function safeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return '기록 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatMean(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const percentage = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percentage.toFixed(1)}%`;
}

function connectionLabel(state: ConnectionState) {
  if (state === 'CONNECTED') return 'LIVE 연결됨';
  if (state === 'RECONNECTING') return '재연결 중';
  return '연결 중';
}

function stateTone(state: string) {
  const normalized = state.toUpperCase();
  if (
    normalized.includes('FAIL')
    || normalized.includes('DOWN')
    || normalized.includes('STALE')
  ) return 'danger';
  if (
    normalized.includes('WAIT')
    || normalized.includes('IDLE')
    || normalized.includes('PENDING')
  ) return 'warning';
  if (
    normalized.includes('HEALTH')
    || normalized.includes('READY')
    || normalized.includes('SUCCESS')
    || normalized.includes('COMPLETE')
  ) return 'success';
  return 'neutral';
}

function StateText({ value }: { value: string }) {
  return (
    <span className="control-room-state" data-tone={stateTone(value)}>
      <span aria-hidden="true" />
      {value}
    </span>
  );
}

function stageRecord(stage: PipelineStage, generatedAt: string): InspectorRecord {
  return {
    kind: 'stage',
    title: `${stage.label} 단계`,
    summary: `${stage.label} 단계에는 진행 ${stage.active}건, 실패 ${stage.failed}건, 준비 ${stage.ready}건이 집계되었습니다.`,
    stage: stage.key,
    state: stage.failed > 0 ? 'ATTENTION' : stage.active > 0 ? 'ACTIVE' : 'IDLE',
    occurredAt: generatedAt,
    payload: stage,
  };
}

function operationRecord(operation: ActiveOperation): InspectorRecord {
  return {
    kind: 'operation',
    title: operation.label,
    summary: operation.error?.message
      ? `${operation.stage} 단계에서 ${operation.error.message}`
      : `${operation.stage} 단계가 ${operation.state} 상태로 실행 중입니다.`,
    stage: operation.stage,
    state: operation.error?.code ?? operation.state,
    occurredAt: operation.updatedAt,
    payload: operation,
  };
}

function failureRecord(failure: ControlRoomFailure): InspectorRecord {
  return {
    kind: 'failure',
    title: failure.label,
    summary: failure.message,
    stage: failure.stage,
    state: failure.code,
    occurredAt: failure.updatedAt,
    payload: failure,
  };
}

function eventRecord(event: ControlRoomEvent): InspectorRecord {
  return {
    kind: 'event',
    title: event.eventType,
    summary: event.summary,
    stage: event.stage,
    state: event.state,
    occurredAt: event.createdAt,
    payload: event.payload,
  };
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="control-room-empty">{children}</p>;
}

export function ResearchControlRoom() {
  const [snapshot, setSnapshot] = useState<ControlRoomSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>('CONNECTING');
  const [streamCursor, setStreamCursor] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [inspected, setInspected] = useState<InspectorRecord | null>(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const acceptedCursorRef = useRef('0');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acceptSnapshot = useCallback((next: ControlRoomSnapshot) => {
    const cursor = parseEventCursor(next.eventCursor);
    if (
      cursor
      && compareEventCursors(cursor, acceptedCursorRef.current) > 0
    ) {
      acceptedCursorRef.current = cursor;
    }
    setSnapshot(next);
    if (cursor) setStreamCursor((current) => current ?? cursor);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setRefreshing(true);
    try {
      const next = await fetchControlRoomSnapshot();
      if (
        !mountedRef.current
        || requestSequence !== requestSequenceRef.current
      ) return;
      acceptSnapshot(next);
      setLoadError(null);
    } catch (error) {
      if (
        !mountedRef.current
        || requestSequence !== requestSequenceRef.current
      ) return;
      setLoadError(error instanceof Error ? error.message : '관제실 데이터를 불러오지 못했습니다.');
      throw error;
    } finally {
      if (
        mountedRef.current
        && requestSequence === requestSequenceRef.current
      ) setRefreshing(false);
    }
  }, [acceptSnapshot]);

  const scheduleRefresh = useCoalescedRefresh(refreshSnapshot, {
    delayMs: 800,
    retryDelayMs: 1_600,
    retryLimit: 1,
  });

  useEffect(() => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    void fetchControlRoomSnapshot()
      .then((next) => {
        if (
          !mountedRef.current
          || requestSequence !== requestSequenceRef.current
        ) return;
        acceptSnapshot(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (
          !mountedRef.current
          || requestSequence !== requestSequenceRef.current
        ) return;
        setLoadError(error instanceof Error ? error.message : '관제실 데이터를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (
          mountedRef.current
          && requestSequence === requestSequenceRef.current
        ) setRefreshing(false);
      });
  }, [acceptSnapshot]);

  useEffect(() => {
    if (streamCursor === null) return;
    const source = new EventSource(
      `${STREAM_ENDPOINT}?after=${encodeURIComponent(streamCursor)}`,
    );
    const handleOpen = () => setConnection('CONNECTED');
    const handleError = () => setConnection('RECONNECTING');
    const handleEvent = (message: Event) => {
      const event = message as MessageEvent<string>;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed)) return;
      const cursor = parseEventCursor(
        typeof parsed.id === 'string' ? parsed.id : null,
      );
      if (
        !cursor
        || compareEventCursors(cursor, acceptedCursorRef.current) <= 0
      ) return;
      acceptedCursorRef.current = cursor;
      setLastEventAt(Date.now());
      scheduleRefresh();
    };
    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleError);
    source.addEventListener('control-room', handleEvent);
    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      source.removeEventListener('control-room', handleEvent);
      source.close();
    };
  }, [scheduleRefresh, streamCursor]);

  useEffect(() => {
    if (lastEventAt === null) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lastEventAt]);

  const freshness = useMemo(() => {
    if (lastEventAt === null) return '이벤트 대기 중';
    const elapsedSeconds = Math.max(0, Math.floor((clock - lastEventAt) / 1_000));
    if (elapsedSeconds < 10) return '마지막 이벤트 · 방금 전';
    if (elapsedSeconds < 60) return `마지막 이벤트 · ${elapsedSeconds}초 전`;
    return `마지막 이벤트 · ${Math.floor(elapsedSeconds / 60)}분 전`;
  }, [clock, lastEventAt]);

  const stages = safeArray(snapshot?.pipelineStages);
  const operations = safeArray(snapshot?.activeOperations);
  const activeOperationCount = operations.filter(
    (operation) => operation.state !== 'STALE',
  ).length;
  const failures = safeArray(snapshot?.failures);
  const events = safeArray(snapshot?.recentEvents);
  const profiles = safeArray(snapshot?.profiles);
  const scoreboard = safeArray(snapshot?.scoreboard).filter(
    (row) => row.metric !== 'exact_match',
  );
  const databaseSignal = snapshot?.system?.database ?? null;
  const workerSignal = snapshot?.system?.worker ?? null;
  const queueSignal = snapshot?.system?.queue ?? null;

  return (
    <section
      className={`research-control-room${inspected ? ' has-inspector' : ''}`}
      aria-labelledby="research-control-room-title"
    >
      <header className="control-room-page-header">
        <div>
          <span className="control-room-eyebrow">LIVE RESEARCH INSTRUMENTATION</span>
          <h1 id="research-control-room-title">Research Control Room</h1>
          <p>실제 데이터베이스·작업자·파이프라인·평가 결과를 한 화면에서 추적합니다.</p>
        </div>
        <div className="control-room-live-cluster" aria-label="실시간 연결 상태">
          <div>
            <StateText value={connectionLabel(connection)} />
            <span>{freshness}</span>
          </div>
          <button
            type="button"
            className="control-room-refresh-button"
            disabled={refreshing}
            onClick={() => void refreshSnapshot().catch(() => undefined)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {refreshing ? '갱신 중' : '지금 갱신'}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="control-room-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>Snapshot을 갱신하지 못했습니다.</strong>
            <span>{loadError}</span>
          </div>
          <button type="button" onClick={() => void refreshSnapshot().catch(() => undefined)}>다시 시도</button>
        </div>
      )}

      {!snapshot && !loadError && (
        <div className="control-room-loading" role="status">
          <Activity size={17} aria-hidden="true" />
          실제 운영 데이터를 불러오는 중입니다.
        </div>
      )}

      <div className="control-room-workspace">
        <div className="control-room-primary">
          <section className="control-room-system-grid" aria-labelledby="system-signals-title">
            <h2 id="system-signals-title" className="control-room-visually-hidden">시스템 신호</h2>
            <article>
              <header>
                <Database size={16} aria-hidden="true" />
                <span>DATABASE</span>
                {databaseSignal
                  ? <StateText value={databaseSignal.state} />
                  : <StateText value="NO DATA" />}
              </header>
              <strong>{databaseSignal?.latencyMs == null ? '—' : `${databaseSignal.latencyMs} ms`}</strong>
              <p>snapshot 쿼리 왕복 지연</p>
            </article>
            <article>
              <header>
                <ServerCog size={16} aria-hidden="true" />
                <span>WORKER</span>
                {workerSignal
                  ? <StateText value={workerSignal.state} />
                  : <StateText value="NO DATA" />}
              </header>
              <strong>{workerSignal?.activeLeases ?? '—'} active</strong>
              <p>stale lease {workerSignal?.staleLeases ?? '—'}</p>
            </article>
            <article>
              <header>
                <HardDrive size={16} aria-hidden="true" />
                <span>QUEUE</span>
                <StateText value={(queueSignal?.retryWait ?? 0) > 0 ? 'ATTENTION' : 'READY'} />
              </header>
              <strong>대기 {queueSignal?.pending ?? '—'}</strong>
              <p>재시도 {queueSignal?.retryWait ?? '—'} · lease {queueSignal?.leased ?? '—'}</p>
            </article>
            <article>
              <header>
                <CircleDot size={16} aria-hidden="true" />
                <span>SNAPSHOT</span>
                <StateText value={snapshot ? 'CURRENT' : 'NO DATA'} />
              </header>
              <strong className="control-room-compact-value">
                {formatTimestamp(snapshot?.generatedAt)}
              </strong>
              <p>cursor {snapshot?.eventCursor ?? '—'}</p>
            </article>
          </section>

          <section className="control-room-panel control-room-pipeline" aria-labelledby="pipeline-title">
            <header className="control-room-section-header">
              <div>
                <span className="control-room-section-index">01</span>
                <div>
                  <h2 id="pipeline-title">Pipeline Stage Map</h2>
                  <p>교과서 유입부터 모델 채점까지 현재 집계를 연결해 표시합니다.</p>
                </div>
              </div>
              <span>{stages.length} stages</span>
            </header>
            {stages.length === 0
              ? <EmptyState>파이프라인 집계가 없습니다.</EmptyState>
              : (
                <ol className="control-room-stage-map">
                  {stages.map((stage, index) => (
                    <li key={stage.key}>
                      <button
                        type="button"
                        aria-label={`${stage.label} 단계: 진행 ${stage.active}, 실패 ${stage.failed}, 준비 ${stage.ready}`}
                        onClick={() => setInspected(stageRecord(
                          stage,
                          snapshot?.generatedAt ?? '',
                        ))}
                      >
                        <span className="control-room-stage-number">{String(index + 1).padStart(2, '0')}</span>
                        <strong>{stage.label}</strong>
                        <span className="control-room-stage-counts">
                          <b>진행 {stage.active}</b>
                          <b data-tone={stage.failed > 0 ? 'danger' : 'neutral'}>실패 {stage.failed}</b>
                          <b>준비 {stage.ready}</b>
                        </span>
                      </button>
                      {index < stages.length - 1 && <ArrowRight size={14} aria-hidden="true" />}
                    </li>
                  ))}
                </ol>
              )}
          </section>

          <div className="control-room-two-column">
            <section className="control-room-panel" aria-labelledby="operations-title">
              <header className="control-room-section-header">
                <div>
                  <span className="control-room-section-index">02</span>
                  <div>
                    <h2 id="operations-title">Active Operations</h2>
                    <p>현재 lease 또는 진행 상태인 실제 작업입니다.</p>
                  </div>
                </div>
                <span>{activeOperationCount} active</span>
              </header>
              {operations.length === 0
                ? <EmptyState>활성 작업이 없습니다.</EmptyState>
                : (
                  <div className="control-room-row-list">
                    {operations.map((operation) => (
                      <button
                        type="button"
                        key={`${operation.aggregateType}-${operation.aggregateId}`}
                        onClick={() => setInspected(operationRecord(operation))}
                        aria-label={`${operation.label}: ${operation.stage} ${operation.state}`}
                      >
                        <span className="control-room-row-leading">
                          <strong>{operation.label}</strong>
                          <small>{operation.aggregateType} · {operation.aggregateId}</small>
                        </span>
                        <span className="control-room-row-state">
                          <StateText value={operation.state} />
                          <small>{operation.stage} · {formatTimestamp(operation.updatedAt)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
            </section>

            <section className="control-room-panel control-room-failures" aria-labelledby="failures-title">
              <header className="control-room-section-header">
                <div>
                  <span className="control-room-section-index">03</span>
                  <div>
                    <h2 id="failures-title">Failure Inbox</h2>
                    <p>연구자가 원인과 원본 값을 확인해야 할 실패입니다.</p>
                  </div>
                </div>
                <span>
                  표시 {failures.length} / 전체 {snapshot?.failureTotal ?? failures.length}
                </span>
              </header>
              {failures.length === 0
                ? <EmptyState>실패 기록이 없습니다.</EmptyState>
                : (
                  <div className="control-room-row-list">
                    {failures.map((failure) => (
                      <button
                        type="button"
                        key={`${failure.aggregateType}-${failure.aggregateId}-${failure.code}`}
                        onClick={() => setInspected(failureRecord(failure))}
                        aria-label={`${failure.label}: ${failure.code}`}
                      >
                        <AlertTriangle size={15} aria-hidden="true" />
                        <span className="control-room-row-leading">
                          <strong>{failure.label}</strong>
                          <small>{failure.message}</small>
                        </span>
                        <span className="control-room-row-state">
                          <StateText value={failure.code} />
                          <small>{failure.stage} · {formatTimestamp(failure.updatedAt)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
            </section>
          </div>

          <section className="control-room-panel" aria-labelledby="scoreboard-title">
            <header className="control-room-section-header">
              <div>
                <span className="control-room-section-index">04</span>
                <div>
                  <h2 id="scoreboard-title">Live Scoreboard</h2>
                  <p>저장된 채점 평균과 scored/eligible coverage를 함께 표시합니다.</p>
                </div>
              </div>
              <span>
                표시 {scoreboard.length} / 전체 {snapshot?.scoreboardTotal ?? scoreboard.length}
              </span>
            </header>
            {scoreboard.length === 0
              ? <EmptyState>집계 가능한 점수가 없습니다.</EmptyState>
              : (
                <div className="control-room-table-wrap">
                  <table className="control-room-table">
                    <thead>
                      <tr>
                        <th scope="col">실험</th>
                        <th scope="col">모델</th>
                        <th scope="col">평가 지표</th>
                        <th scope="col">평균</th>
                        <th scope="col">Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scoreboard.map((row) => (
                        <tr key={`${row.runId}-${row.model}-${row.metric}`}>
                          <th scope="row">
                            <strong>{row.runLabel}</strong>
                            <small>{row.runId}</small>
                          </th>
                          <td>{row.model}</td>
                          <td>{row.metric}</td>
                          <td><strong>{formatMean(row.mean)}</strong></td>
                          <td>
                            <strong>{row.scored} / {row.eligible}</strong>
                            <small>
                              {row.eligible > 0
                                ? `${((row.scored / row.eligible) * 100).toFixed(1)}%`
                                : '계산 불가'}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          <div className="control-room-two-column control-room-lower-grid">
            <section className="control-room-panel" aria-labelledby="events-title">
              <header className="control-room-section-header">
                <div>
                  <span className="control-room-section-index">05</span>
                  <div>
                    <h2 id="events-title">Recent Events</h2>
                    <p>최근 저장된 감사 이벤트입니다.</p>
                  </div>
                </div>
                <span>{events.length} events</span>
              </header>
              {events.length === 0
                ? <EmptyState>최근 이벤트가 없습니다.</EmptyState>
                : (
                  <div className="control-room-row-list control-room-event-list">
                    {events.map((event) => (
                      <button
                        type="button"
                        key={event.id}
                        onClick={() => setInspected(eventRecord(event))}
                        aria-label={`${event.summary}: ${event.eventType}`}
                      >
                        <Activity size={15} aria-hidden="true" />
                        <span className="control-room-row-leading">
                          <strong>{event.summary}</strong>
                          <small>{event.eventType} · {event.aggregateType}</small>
                        </span>
                        <span className="control-room-row-state">
                          <StateText value={event.state} />
                          <small>{formatTimestamp(event.createdAt)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
            </section>

            <section className="control-room-panel" aria-labelledby="profiles-title">
              <header className="control-room-section-header">
                <div>
                  <span className="control-room-section-index">06</span>
                  <div>
                    <h2 id="profiles-title">Active Profiles</h2>
                    <p>현재 처리와 평가에 적용되는 불변 설정입니다.</p>
                  </div>
                </div>
                <span>{profiles.length} active</span>
              </header>
              {profiles.length === 0
                ? <EmptyState>활성 프로필이 없습니다.</EmptyState>
                : (
                  <dl className="control-room-profile-list">
                    {profiles.map((profile) => (
                      <div key={`${profile.kind}-${profile.id}`}>
                        <dt>
                          <strong>{profile.title}</strong>
                          <span>{profile.kind} · {profile.version}</span>
                        </dt>
                        <dd>
                          <code>{profile.hash}</code>
                          <span>{formatTimestamp(profile.activatedAt)}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
            </section>
          </div>
        </div>

        {inspected && (
          <InspectorDock
            record={inspected}
            onClose={() => setInspected(null)}
          />
        )}
      </div>
    </section>
  );
}
