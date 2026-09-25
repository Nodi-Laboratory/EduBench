'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { BookOpen, ChevronDown, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { JsonBlock } from '@/components/ui/json-block';
import { buildQuestionGenerationInstructions } from '@/domain/question-prompt';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';
import { useCursorEventStream } from '@/hooks/use-cursor-event-stream';

type TocEntry = {
  id: string;
  source_file_id: string;
  title: string;
  level: number;
  printed_page: number | null;
  mapping_status: 'MAPPED' | 'UNMAPPED';
  mapped_chunk_count: number;
  mapping_confidence: number | null;
};
type GenerationSource = { id: string; original_name: string; subject: string | null; grade: string | null; tocEntries: TocEntry[] };
type GenerationBatch = {
  id: string; state: string; requested_count: number; created_at: string; updated_at?: string;
  conditions?: { executionMode?: string }; progress?: { completedQuestions?: number; failedQuestions?: number; error?: string };
};
type ActivityEvent = { id: string; event_type: string; payload: Record<string, unknown>; created_at: string };
type GeneratedQuestion = { public_id: string; status: string; question_text: string; answer_text: string; design_summary: string | null; evidence_summary: string | null };
type GenerationProviderInvocation = {
  id: string;
  itemAttempt: number;
  stage: 'DIRECTION' | 'QUESTION' | 'QUESTION_REPAIR';
  state: string;
  provider: string;
  modelId: string;
  requestSnapshot: Record<string, unknown>;
  responseSnapshot: Record<string, unknown> | null;
  rawResponse: unknown;
  requestId: string | null;
  modelSnapshot: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
};
type GenerationRetrievalAudit = {
  id: string;
  attempt: number;
  queryText: string;
  candidateScope: Record<string, unknown>;
  selectedChunks: unknown[];
  createdAt: string;
};
type GenerationProviderInvocationSummary = {
  total: number;
  requested: number;
  completed: number;
  failed: number;
  abandoned: number;
};
type GenerationItem = {
  id: string;
  ordinal: number;
  state: string;
  attempts: number;
  retryable: boolean;
  direction: Record<string, unknown> | null;
  error: { code: string | null; message: string | null; retryable: boolean } | null;
  latestRetrieval: {
    id: string;
    attempt: number;
    queryText: string;
    selectedChunkCount: number;
    createdAt: string;
  } | null;
  providerInvocationSummary: GenerationProviderInvocationSummary;
  questionId: string | null;
  questionPublicId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};
type GenerationItemAuditPage = {
  batchId: string;
  itemId: string;
  latestRetrieval: GenerationRetrievalAudit | null;
  providerInvocations: GenerationProviderInvocation[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    nextOffset: number | null;
  };
};
type GenerationItemAuditState = {
  batchId: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  latestRetrieval: GenerationRetrievalAudit | null;
  providerInvocations: GenerationProviderInvocation[];
  pagination: GenerationItemAuditPage['pagination'] | null;
};
type Activity = {
  batch: GenerationBatch;
  job: { state: string; attempts: number; max_attempts: number; last_error_code: string | null; last_error_message: string | null } | null;
  events: ActivityEvent[];
  questions: GeneratedQuestion[];
  items: GenerationItem[];
  canResume: boolean;
  eventCursor: string;
};

function isUsableTocEntry(entry: TocEntry) {
  return entry.mapping_status === 'MAPPED' && entry.mapped_chunk_count > 0;
}

const ITEM_AUDIT_PAGE_SIZE = 20;

function LazyDisclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  onOpenChange,
  unmountClosed = true,
}: {
  summary:ReactNode;
  children:ReactNode;
  defaultOpen?:boolean;
  className?:string;
  onOpenChange?:(open:boolean) => void;
  unmountClosed?:boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <details
    className={className}
    open={open}
    onToggle={(event) => {
      const nextOpen = event.currentTarget.open;
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    }}
  >
    <summary>{summary}</summary>
    {open || !unmountClosed ? children : null}
  </details>;
}

const eventLabels: Record<string, string> = {
  JOB_ENQUEUED: '작업 대기열 등록', JOB_CLAIMED: '작업 실행 시작', JOB_LEASED: '작업 실행 시작', JOB_RETRY_SCHEDULED: '작업 재시도 예약', JOB_RELEASED_ON_SHUTDOWN: '워커 종료 · 안전 재개 대기', JOB_FAILED: '작업 최종 실패', JOB_TERMINAL_FAILED: '작업 최종 실패',
  GENERATION_STARTED: '생성 배치 시작', RETRIEVAL_STARTED: '교과서 근거 검색 시작', RETRIEVAL_COMPLETED: '교과서 근거 검색 완료',
  QUESTION_DIRECTION_STARTED: '단일 문항 방향성 설계 시작', QUESTION_DIRECTION_COMPLETED: '단일 문항 방향성 설계 완료',
  QUESTION_RETRIEVAL_STARTED: '단일 문항 전용 벡터 검색 시작', QUESTION_RETRIEVAL_COMPLETED: '단일 문항 전용 벡터 검색 완료',
  QUESTION_GENERATION_STARTED: '단일 문항 생성 시작', QUESTION_GENERATION_COMPLETED: '단일 문항 생성 완료',
  QUESTION_RESPONSE_REPAIR_STARTED: '구조화 응답 자동 교정 시작',
  QUESTION_RESPONSE_REPAIR_COMPLETED: '구조화 응답 자동 교정 완료',
  QUESTION_RESPONSE_REPAIR_FAILED: '구조화 응답 자동 교정 실패',
  QUESTION_GENERATION_FAILED: '단일 문항 생성 실패', GENERATION_COMPLETED: '전체 문항 생성 완료', GENERATION_FAILED: '생성 배치 실패',
  GENERATION_RESUMED: '미완료 문항 생성 재개',
};
const connectionLabels = {
  idle: '연결 대기',
  connecting: '연결 중',
  live: '실시간 연결',
  reconnecting: '재연결 중',
} as const;

type ObservableStageKey = 'direction' | 'retrieval' | 'generation';
const observableStages: readonly {
  key: ObservableStageKey;
  label: string;
  description: string;
  startedEvent: string;
  completedEvent: string;
  failedEvent: string;
}[] = [
  {
    key: 'direction',
    label: '방향성 설계',
    description: '문항마다 독립적인 측정 방향과 검색 질의를 설계합니다.',
    startedEvent: 'QUESTION_DIRECTION_STARTED',
    completedEvent: 'QUESTION_DIRECTION_COMPLETED',
    failedEvent: 'QUESTION_DIRECTION_FAILED',
  },
  {
    key: 'retrieval',
    label: '문항별 근거 검색',
    description: '해당 문항 전용 질의로 교과서 청크를 검색합니다.',
    startedEvent: 'QUESTION_RETRIEVAL_STARTED',
    completedEvent: 'QUESTION_RETRIEVAL_COMPLETED',
    failedEvent: 'QUESTION_RETRIEVAL_FAILED',
  },
  {
    key: 'generation',
    label: '질문·답안 생성',
    description: '검색된 근거로 질문과 모범 답안을 생성해 저장합니다.',
    startedEvent: 'QUESTION_GENERATION_STARTED',
    completedEvent: 'QUESTION_GENERATION_COMPLETED',
    failedEvent: 'QUESTION_GENERATION_FAILED',
  },
];

function failureMessage(activity: Activity | null) {
  return activity?.batch.progress?.error || activity?.job?.last_error_message || null;
}

function eventOrdinal(event: ActivityEvent) {
  const ordinal = Number(event.payload.ordinal);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null;
}

function observedStageProgress(
  activity: Activity | null,
  stage: typeof observableStages[number],
) {
  if (!activity) return { label: '배치 기록 없음', state: 'unknown' };
  const total = activity.batch.requested_count;
  const completed = new Set<number>();
  const started = new Set<number>();
  const failed = new Set<number>();

  for (const item of activity.items ?? []) {
    if (stage.key === 'direction' && item.direction) completed.add(item.ordinal);
    if (stage.key === 'retrieval' && item.latestRetrieval) completed.add(item.ordinal);
    if (stage.key === 'generation' && (item.questionId || item.questionPublicId)) completed.add(item.ordinal);
  }
  for (const event of activity.events ?? []) {
    const ordinal = eventOrdinal(event);
    if (ordinal == null) continue;
    if (event.event_type === stage.completedEvent) completed.add(ordinal);
    if (event.event_type === stage.startedEvent) started.add(ordinal);
    if (event.event_type === stage.failedEvent) failed.add(ordinal);
  }
  for (const ordinal of completed) {
    started.delete(ordinal);
    failed.delete(ordinal);
  }
  for (const ordinal of failed) started.delete(ordinal);

  const completedCount = Math.min(total, completed.size);
  const runningCount = Math.min(Math.max(0, total - completedCount), started.size);
  const failedCount = Math.min(Math.max(0, total - completedCount - runningCount), failed.size);
  if (completedCount === 0 && runningCount === 0 && failedCount === 0) {
    return ['QUEUED', 'PENDING'].includes(activity.batch.state)
      ? { label: '대기', state: 'pending' }
      : { label: '기록 없음 · legacy partial', state: 'unknown' };
  }
  const parts = [`${completedCount}/${total} 완료`];
  if (runningCount) parts.push(`${runningCount} 진행`);
  if (failedCount) parts.push(`${failedCount} 실패`);
  return {
    label: parts.join(' · '),
    state: completedCount >= total
      ? 'complete'
      : failedCount > 0
        ? 'failed'
        : runningCount > 0
          ? 'running'
          : 'pending',
  };
}

const directionLabels: Record<string, string> = {
  directionSummary: '방향 요약',
  targetConceptQuery: '목표 개념 질의',
  prerequisiteQuery: '선수 개념 질의',
  searchQuery: '통합 검색 질의',
};

function readableValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))) {
    return value.map(String).join(', ');
  }
  return null;
}

function DirectionRecord({ value }: { value: Record<string, unknown> | null }) {
  if (!value) return <p>기록 없음</p>;
  const primary = Object.entries(value)
    .filter(([key]) => !/(^id$|Id$|_id$)/.test(key))
    .map(([key, entry]) => ({ key, label: directionLabels[key] ?? key, value: readableValue(entry) }))
    .filter((entry): entry is { key: string; label: string; value: string } => entry.value != null);
  return <>
    {primary.length ? <dl className="lab-request-info">{primary.map((entry) => <div key={entry.key}>
      <dt>{entry.label}</dt><dd>{entry.value}</dd>
    </div>)}</dl> : <p>사람이 읽을 수 있는 방향성 필드가 없습니다.</p>}
    <LazyDisclosure summary="원본 방향성 기록">
      <JsonBlock value={value} />
    </LazyDisclosure>
  </>;
}

function RetrievalSummary({ value }: { value: GenerationItem['latestRetrieval'] }) {
  if (!value) return <p>검색 기록 없음</p>;
  return <div>
    <h4>검색 질의</h4>
    <p>{value.queryText || '기록 없음'}</p>
    <p><strong>선택 근거 {value.selectedChunkCount ?? 0}개</strong></p>
  </div>;
}

function RetrievalRecord({ value }: { value: GenerationRetrievalAudit | null }) {
  if (!value) return <p>기록 없음</p>;
  const chunks = (value.selectedChunks ?? [])
    .filter((chunk): chunk is Record<string, unknown> => typeof chunk === 'object' && chunk !== null);
  return <div>
    <h4>검색 질의</h4>
    <p>{value.queryText || '기록 없음'}</p>
    <h4>선택 근거 {chunks.length}개</h4>
    {chunks.length ? chunks.map((chunk, index) => {
      const page = chunk.page == null ? null : String(chunk.page);
      const rank = chunk.rank == null ? index + 1 : Number(chunk.rank);
      const content = readableValue(chunk.content);
      const unit = readableValue(chunk.unit);
      const source = readableValue(chunk.source);
      const selectionReason = readableValue(chunk.selectionReason);
      const similarity = typeof chunk.similarity === 'number' ? chunk.similarity.toFixed(4) : null;
      const chunkId = readableValue(chunk.chunkId);
      return <article key={chunkId ?? `${value.id}-${index}`}>
        {content ? <p>{content}</p> : <p>본문 기록 없음</p>}
        <strong>{Number.isFinite(rank) ? `${rank}위` : `${index + 1}위`}</strong>
        <span>{unit ?? '단원 기록 없음'}</span>
        {page && <span className="mono">p.{page}</span>}
        {(source || similarity || selectionReason) && <p>{[source, similarity && `유사도 ${similarity}`, selectionReason].filter(Boolean).join(' · ')}</p>}
        {chunkId && <small className="mono">chunk <code>{chunkId}</code></small>}
      </article>;
    }) : <p>선택 청크 기록 없음</p>}
    <LazyDisclosure summary="검색 감사 원본">
      <JsonBlock value={value} />
    </LazyDisclosure>
  </div>;
}

function ProviderInvocationRecord({ invocation }: { invocation: GenerationProviderInvocation }) {
  const title = invocation.stage === 'DIRECTION'
    ? '실제 방향성 프롬프트'
    : invocation.stage === 'QUESTION_REPAIR'
      ? '구조화 응답 자동 교정 프롬프트'
      : '실제 질문 생성 프롬프트';
  const system = readableValue(invocation.requestSnapshot.system);
  const prompt = readableValue(invocation.requestSnapshot.prompt);
  const responseText = readableValue(invocation.responseSnapshot?.text);
  return <LazyDisclosure
    className="source-event provider-invocation-record"
    summary={<>
      <strong>{title}</strong>
      <span className={`state-label state-${invocation.state.toLowerCase()}`}>{invocation.state}</span>
      <small className="mono">{invocation.provider} / {invocation.modelId}</small>
    </>}
  >
    <div className="event-payload">
      <p className="run-meta mono">
        시도 {invocation.itemAttempt} · request {invocation.requestId ?? '기록 없음'} · model snapshot {invocation.modelSnapshot ?? '기록 없음'}
      </p>
      <section>
        <h4>요청</h4>
        <strong>System</strong>
        <pre>{system ?? '기록 없음'}</pre>
        <strong>User</strong>
        <pre>{prompt ?? '기록 없음'}</pre>
        <p className="run-meta mono">
          maxOutputTokens {readableValue(invocation.requestSnapshot.maxOutputTokens) ?? '기록 없음'}
        </p>
        <LazyDisclosure summary="전체 요청 스냅샷">
          <JsonBlock value={invocation.requestSnapshot} />
        </LazyDisclosure>
      </section>
      <section>
        <h4>Provider 응답</h4>
        <pre>{responseText ?? '응답 텍스트 기록 없음'}</pre>
        <p className="run-meta mono">
          finish {invocation.finishReason ?? '기록 없음'} · token {invocation.inputTokens ?? '—'} / {invocation.outputTokens ?? '—'} · {invocation.latencyMs ?? '—'} ms
        </p>
        {invocation.error && <div className="event-error"><strong>호출 실패</strong><JsonBlock value={invocation.error} /></div>}
        <LazyDisclosure summary="Provider 원시 응답">
          <JsonBlock value={invocation.rawResponse ?? '기록 없음'} />
        </LazyDisclosure>
      </section>
      <small className="mono">시작 {invocation.startedAt} · 완료 {invocation.completedAt ?? '기록 없음'} · invocation {invocation.id}</small>
    </div>
  </LazyDisclosure>;
}

function mergeBatchSnapshot(
  batches: GenerationBatch[],
  snapshot: GenerationBatch,
): GenerationBatch[] {
  const found = batches.some((batch) => batch.id === snapshot.id);
  const merge = (batch: GenerationBatch) => ({
    ...batch,
    ...snapshot,
    conditions: { ...batch.conditions, ...snapshot.conditions },
    progress: { ...batch.progress, ...snapshot.progress },
  });
  return found
    ? batches.map((batch) => batch.id === snapshot.id ? merge(batch) : batch)
    : [snapshot, ...batches];
}

export function GenerationWorkspace({ sources, batches }: { sources: GenerationSource[]; batches: GenerationBatch[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedTocIds, setSelectedTocIds] = useState<string[]>([]);
  const [liveBatches, setLiveBatches] = useState(batches);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(batches[0]?.id ?? null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [itemAudits, setItemAudits] = useState<Record<string, GenerationItemAuditState>>({});
  const auditBatchRef = useRef<string | null>(selectedBatchId);
  const activeAuditItemRef = useRef<string | null>(null);
  const auditGenerationRef = useRef(0);
  const auditRequestsRef = useRef(new Set<string>());
  const auditAbortRef = useRef<AbortController | null>(null);
  const [promptInputs, setPromptInputs] = useState({
    subject: '과학', grade: '중학교 2학년', purpose: '핵심 개념 이해',
    questionType: '구조화 서술형', difficulty: '중',
    direction: '교과서 근거로 핵심 개념 사이의 관계를 설명하도록 구성',
    requestedCount: 10, crossUnit: false,
  });

  const fetchActivity = useCallback(async (
    batchId: string,
    includeHistory: boolean,
    signal?: AbortSignal,
  ): Promise<Activity | Omit<Activity, 'events'> | null> => {
    const suffix = includeHistory ? '' : '?history=0';
    const response = await fetch(`/api/generation/${batchId}/activity${suffix}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    const snapshot = await response.json() as Partial<Activity>;
    return snapshot.batch?.id === batchId
      ? snapshot as Activity | Omit<Activity, 'events'>
      : null;
  }, []);

  useEffect(() => {
    if (!selectedBatchId) return;
    const abort = new AbortController();
    void fetchActivity(selectedBatchId, true, abort.signal).then((snapshot) => {
      if (!abort.signal.aborted && snapshot && 'events' in snapshot) {
        setActivity(snapshot as Activity);
        setLiveBatches((current) => mergeBatchSnapshot(current, snapshot.batch));
      }
    }).catch(() => undefined);
    return () => abort.abort();
  }, [fetchActivity, selectedBatchId]);

  useEffect(() => () => auditAbortRef.current?.abort(), []);

  const refreshSelectedSnapshot = useCallback(async () => {
    if (!selectedBatchId) return;
    const [snapshot, batchesResponse] = await Promise.all([
      fetchActivity(selectedBatchId, false),
      fetch('/api/generation', { cache: 'no-store' }),
    ]);
    if (snapshot) {
      setActivity((current) => current?.batch.id === selectedBatchId
        ? { ...snapshot, eventCursor: current.eventCursor, events: current.events } as Activity
        : current);
    }
    if (batchesResponse.ok) {
      const fetched = (await batchesResponse.json()).items as GenerationBatch[];
      setLiveBatches(snapshot ? mergeBatchSnapshot(fetched, snapshot.batch) : fetched);
    } else if (snapshot) {
      setLiveBatches((current) => mergeBatchSnapshot(current, snapshot.batch));
    }
  }, [fetchActivity, selectedBatchId]);
  const coalescedRefresh = useCoalescedRefresh(refreshSelectedSnapshot);
  const stream = useCursorEventStream({
    aggregate: 'generation',
    id: selectedBatchId,
    initialCursor: activity?.eventCursor,
    enabled: Boolean(
      selectedBatchId
      && activity
      && activity.batch?.id === selectedBatchId
      && activity.eventCursor != null,
    ),
    onEvent(event) {
      setActivity((current) => {
        if (!current || current.batch.id !== event.aggregateId) return current;
        if (current.events.some((entry) => entry.id === event.id)) return current;
        return {
          ...current,
          events: [...current.events, {
            id: event.id,
            event_type: event.eventType,
            payload: event.payload,
            created_at: event.createdAt,
          }].slice(-200),
        };
      });
      coalescedRefresh();
    },
  });

  function evictItemAudit(itemId?:string) {
    if (
      itemId != null
      && activeAuditItemRef.current !== itemId
    ) return;
    activeAuditItemRef.current = null;
    auditGenerationRef.current += 1;
    auditRequestsRef.current.clear();
    auditAbortRef.current?.abort();
    auditAbortRef.current = null;
    setItemAudits({});
  }

  function selectGenerationBatch(batchId: string) {
    if (auditBatchRef.current !== batchId) {
      auditBatchRef.current = batchId;
      evictItemAudit();
    }
    setActivity(null);
    setSelectedBatchId(batchId);
  }

  async function loadItemAudit(itemId: string, offset = 0, force = false) {
    const batchId = selectedBatchId;
    if (!batchId) return;
    if (activeAuditItemRef.current !== itemId) {
      activeAuditItemRef.current = itemId;
      auditGenerationRef.current += 1;
      auditRequestsRef.current.clear();
      setItemAudits({});
    }
    const auditGeneration = auditGenerationRef.current;
    const cached = itemAudits[itemId];
    if (
      !force
      && offset === 0
      && cached?.batchId === batchId
      && (cached.loaded || cached.loading)
    ) return;

    const requestKey = `${batchId}:${itemId}:${offset}`;
    if (auditRequestsRef.current.has(requestKey)) return;
    auditRequestsRef.current.add(requestKey);
    auditAbortRef.current?.abort();
    const abort = new AbortController();
    auditAbortRef.current = abort;
    setItemAudits((current) => {
      const previous = current[itemId]?.batchId === batchId ? current[itemId] : null;
      return {
        [itemId]: {
          batchId,
          loaded: previous?.loaded ?? false,
          loading: true,
          error: null,
          latestRetrieval: previous?.latestRetrieval ?? null,
          providerInvocations: previous?.providerInvocations ?? [],
          pagination: previous?.pagination ?? null,
        },
      };
    });

    try {
      const response = await fetch(
        `/api/generation/${batchId}/items/${itemId}/audit?limit=${ITEM_AUDIT_PAGE_SIZE}&offset=${offset}`,
        { cache: 'no-store', signal:abort.signal },
      );
      if (!response.ok) throw new Error('상세 감사 기록을 불러오지 못했습니다.');
      const page = await response.json() as GenerationItemAuditPage;
      if (
        auditBatchRef.current !== batchId
        || activeAuditItemRef.current !== itemId
        || auditGenerationRef.current !== auditGeneration
        || page.batchId !== batchId
        || page.itemId !== itemId
      ) return;
      setItemAudits((current) => {
        if (auditGenerationRef.current !== auditGeneration) return current;
        const previous = current[itemId]?.batchId === batchId ? current[itemId] : null;
        const invocations = offset === 0
          ? page.providerInvocations
          : [...(previous?.providerInvocations ?? []), ...page.providerInvocations];
        return {
          [itemId]: {
            batchId,
            loaded: true,
            loading: false,
            error: null,
            latestRetrieval: page.latestRetrieval,
            providerInvocations: [...new Map(
              invocations.map((invocation) => [invocation.id, invocation]),
            ).values()],
            pagination: page.pagination,
          },
        };
      });
    } catch (error) {
      if (
        auditBatchRef.current !== batchId
        || activeAuditItemRef.current !== itemId
        || auditGenerationRef.current !== auditGeneration
      ) return;
      setItemAudits((current) => {
        if (auditGenerationRef.current !== auditGeneration) return current;
        const previous = current[itemId]?.batchId === batchId ? current[itemId] : null;
        return {
          [itemId]: {
            batchId,
            loaded: previous?.loaded ?? false,
            loading: false,
            error: error instanceof Error ? error.message : '상세 감사 기록을 불러오지 못했습니다.',
            latestRetrieval: previous?.latestRetrieval ?? null,
            providerInvocations: previous?.providerInvocations ?? [],
            pagination: previous?.pagination ?? null,
          },
        };
      });
    } finally {
      auditRequestsRef.current.delete(requestKey);
      if (auditAbortRef.current === abort) auditAbortRef.current = null;
    }
  }

  function toggleSource(source: GenerationSource, checked: boolean) {
    setSelectedSourceIds((current) => checked ? [...new Set([...current, source.id])] : current.filter((id) => id !== source.id));
    if (!checked) setSelectedTocIds((current) => current.filter((id) => !source.tocEntries.some((entry) => entry.id === id)));
  }
  function toggleToc(id: string, checked: boolean) {
    setSelectedTocIds((current) => checked ? [...new Set([...current, id])] : current.filter((entryId) => entryId !== id));
  }
  function toggleAllToc(source: GenerationSource, checked: boolean) {
    const usableEntries = source.tocEntries.filter(isUsableTocEntry);
    if (checked) {
      setSelectedSourceIds((current) => [...new Set([...current, source.id])]);
      setSelectedTocIds((current) => [...new Set([...current, ...usableEntries.map((entry) => entry.id)])]);
    } else {
      setSelectedTocIds((current) => current.filter((id) => !source.tocEntries.some((entry) => entry.id === id)));
    }
  }
  function updatePromptPreview(event: FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    setPromptInputs({
      subject: String(form.get('subject') ?? ''), grade: String(form.get('grade') ?? ''),
      purpose: String(form.get('purpose') ?? ''), questionType: String(form.get('questionType') ?? ''),
      difficulty: String(form.get('difficulty') ?? ''), direction: String(form.get('direction') ?? ''),
      requestedCount: Number(form.get('requestedCount') ?? 10), crossUnit: form.get('crossUnit') === 'on',
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSourceIds.length) { setNotice('질문 생성에 사용할 교과서를 하나 이상 선택하세요.'); return; }
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/generation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: form.get('subject'), grade: form.get('grade'),
        sourceFileIds: selectedSourceIds, tocEntryIds: selectedTocIds,
        purpose: form.get('purpose'), questionType: form.get('questionType'), difficulty: form.get('difficulty'),
        direction: form.get('direction'), chunkCount: Number(form.get('chunkCount')),
        requestedCount: Number(form.get('requestedCount')), crossUnit: form.get('crossUnit') === 'on',
        executionMode: form.get('executionMode'),
      }),
    });
    const body = await response.json();
    if (response.ok) {
      setNotice(`생성 배치 ${body.id.slice(0, 8)}를 예약했습니다.`);
      selectGenerationBatch(body.id);
      setLiveBatches((current) => [{ id: body.id, state: body.state, requested_count: Number(form.get('requestedCount')), created_at: new Date().toISOString(), progress: body.progress }, ...current]);
    } else setNotice(body.message ?? '생성 배치를 만들지 못했습니다.');
  }
  async function resumeGeneration() {
    if (!selectedBatchId) return;
    const response = await fetch(`/api/generation/${selectedBatchId}/resume`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      setNotice(body.message ?? '생성 작업을 재개하지 못했습니다.');
      return;
    }
    setNotice(`미완료 문항 생성을 재개했습니다. 재개 순번 ${body.resumeSequence}`);
    await refreshSelectedSnapshot();
  }

  const error = failureMessage(activity);
  const selectedUnits = sources.flatMap((source) => source.tocEntries)
    .filter((entry) => selectedTocIds.includes(entry.id)).map((entry) => entry.title);
  const promptPreview = buildQuestionGenerationInstructions({
    conditions: { ...promptInputs, units: selectedUnits },
    ordinal: 1,
    total: promptInputs.requestedCount,
    evidence: '[검색 완료 후 실제 교과서 청크 JSON이 이 위치에 삽입됩니다.]',
  });
  return <div className="workflow-page">
    <header className="page-heading"><div><span className="eyebrow">QUESTIONS / GENERATE</span><h1>질문 생성</h1><p>선택한 교과서 범위 안에서 검색·검증을 거쳐 벤치마크 문항을 생성합니다.</p></div></header>
    <div className="generation-grid">
      <section className="panel form-panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>생성 조건</h2></div></div><form className="dense-form" onSubmit={submit} onChange={updatePromptPreview}>
        <div className="form-row"><label>과목<input name="subject" defaultValue="과학" required /></label><label>학년<input name="grade" defaultValue="중학교 2학년" required /></label></div>
        <fieldset className="source-scope-fieldset"><legend>교과서와 목차 선택</legend><small>교과서를 체크한 뒤 목차를 펼쳐 사용할 범위를 선택합니다. 목차를 선택하지 않으면 교과서 전체를 사용합니다.</small>
          <div className="source-scope-list">{sources.map((source) => {
            const selected = selectedSourceIds.includes(source.id);
            const usableEntries = source.tocEntries.filter(isUsableTocEntry);
            const selectedCount = usableEntries.filter((entry) => selectedTocIds.includes(entry.id)).length;
            const allSelected = usableEntries.length > 0 && selectedCount === usableEntries.length;
            return <details key={source.id} className={selected ? 'selected' : ''}>
              <summary><label onClick={(event) => event.stopPropagation()}><input aria-label={`교과서 ${source.original_name}`} type="checkbox" checked={selected} onChange={(event) => toggleSource(source, event.target.checked)} /><BookOpen size={15} /><span><strong>{source.original_name}</strong><small>{source.subject ?? '과목 미지정'} · {source.grade ?? '학년 미지정'} · 사용 가능 목차 {usableEntries.length}/{source.tocEntries.length}개</small></span></label><ChevronDown size={15} /></summary>
              <div className="toc-check-list">{source.tocEntries.length ? <>
                <label className="toc-select-all"><input aria-label={`${source.original_name} 전체 단원 선택`} type="checkbox" disabled={usableEntries.length === 0} checked={allSelected} onChange={(event) => toggleAllToc(source, event.target.checked)} /><strong>전체 단원 선택</strong><small>{selectedCount}/{usableEntries.length}</small></label>
                {source.tocEntries.map((entry) => {
                  const usable = isUsableTocEntry(entry);
                  return <label key={entry.id} className={`toc-level-${entry.level}`} title={usable && entry.mapping_confidence !== null ? `매핑 신뢰도 ${Math.round(entry.mapping_confidence * 100)}%` : undefined}><input aria-label={entry.title} type="checkbox" disabled={!selected || !usable} checked={selectedTocIds.includes(entry.id)} onChange={(event) => toggleToc(entry.id, event.target.checked)} /><span>{entry.title}</span><small>{entry.printed_page !== null && <span className="mono">p.{entry.printed_page} · </span>}{usable ? <span>{entry.mapped_chunk_count}청크</span> : <span>매핑 없음</span>}</small></label>;
                })}
              </> : <p>앞 10페이지에서 목차 항목을 찾지 못했습니다. 이 교과서는 전체 범위로 사용할 수 있습니다.</p>}</div>
            </details>;
          })}</div>
        </fieldset>
        <div className="form-row"><label>질문 목적<select name="purpose"><option>핵심 개념 이해</option><option>개념 적용·문제풀이</option><option>여러 단원 연결 추론</option><option>학생 수준별 설명</option><option>오개념·잘못된 주장 교정</option></select></label><label>문항 형식<select name="questionType"><option>구조화 서술형</option><option>객관식</option><option>단답형</option><option>학생 설명형</option></select></label></div>
        <div className="form-row"><label>난이도<select name="difficulty" defaultValue="중"><option>하</option><option>중</option><option>상</option></select></label><label>검색 청크 수<input type="number" name="chunkCount" min="3" max="30" defaultValue="8" /></label></div>
        <label>질문 방향성<textarea name="direction" defaultValue="교과서 근거로 핵심 개념 사이의 관계를 설명하도록 구성" required /></label>
        <div className="form-row"><label>생성 수량<input type="number" name="requestedCount" min="1" max="100" defaultValue="10" /></label><label>생성 방식<select name="executionMode" defaultValue="parallel"><option value="parallel">병렬 생성 (빠름)</option><option value="sequential">순차 생성</option></select></label></div>
        <label className="check-control"><input type="checkbox" name="crossUnit" /> 복수 단원 연결 허용</label>
        <section className="prompt-preview" role="region" aria-labelledby="prompt-preview-title">
          <div className="prompt-preview-heading"><div><span className="eyebrow">LIVE PROMPT</span><h3 id="prompt-preview-title">AI 지시 프롬프트 미리보기</h3></div><span>실제 생성기와 동일</span></div>
          <p>검색된 교과서 근거만 자리표시자로 표시하며, 나머지는 Gemini에 실제 전달되는 내용입니다.</p>
          <details><summary>시스템 프롬프트</summary><pre>{promptPreview.system}</pre></details>
          <details open><summary>설정 적용 프롬프트</summary><pre>{promptPreview.prompt}</pre></details>
        </section>
        <button className="button primary" type="submit" disabled={sources.length === 0 || selectedSourceIds.length === 0}><Sparkles size={15} /> 문항 생성 시작</button>
        {sources.length === 0 && <p className="form-warning">준비 완료된 교과서가 필요합니다.</p>}{notice && <p className="inline-notice" role="status">{notice}</p>}
      </form></section>
      <div className="generation-side">
        <section className="panel pipeline-panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>실제 생성 단계</h2><p>배치·문항·이벤트에 저장된 단계만 표시하며, 없는 레거시 기록은 추정하지 않습니다.</p></div></div><ol>{observableStages.map((stage, index) => {
          const progress = observedStageProgress(activity, stage);
          return <li key={stage.key} aria-label={`${stage.label} 단계`} className={`stage-${progress.state}`}>
            <span className="pipeline-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{stage.label}</strong><small>{stage.description}</small></span>
            <span className={`state-label state-${progress.state}`}>{progress.label}</span>
          </li>;
        })}</ol></section>
        <section className="panel batch-panel"><div className="panel-heading compact"><div><span className="section-index mono">03</span><h2>최근 생성 배치</h2></div><RefreshCw size={13} className="live-refresh-icon" /></div>{liveBatches.length === 0 ? <div className="small-empty">생성 배치가 없습니다.</div> : liveBatches.map((batch) => {
          const completed = batch.progress?.completedQuestions ?? 0;
          const percent = Math.min(100, Math.round((completed / batch.requested_count) * 100));
          return <button type="button" className={`batch-row ${selectedBatchId === batch.id ? 'selected' : ''}`} key={batch.id} onClick={() => selectGenerationBatch(batch.id)}><span className="mono">{batch.id.slice(0, 8)}</span><strong>{completed}/{batch.requested_count}문항</strong><span className={`state-label state-${batch.state.toLowerCase()}`}>{batch.state}</span><span className="batch-progress"><i style={{ width: `${percent}%` }} /></span></button>;
        })}</section>
        <section className="panel generation-activity"><div className="panel-heading compact"><div><span className="section-index mono">04</span><h2>실시간 생성 기록</h2></div>{activity && <><span className="state-label">{activity.job?.attempts ?? 0}/{activity.job?.max_attempts ?? 0}회</span><span className="state-label">{connectionLabels[stream.status]}</span></>}</div>
          {!selectedBatchId ? <div className="small-empty">확인할 배치를 선택하세요.</div> : !activity ? <div className="small-empty">기록을 불러오는 중입니다.</div> : <div className="activity-body">
            <div className="activity-summary"><span><b>{activity.batch.progress?.completedQuestions ?? 0}</b> 완료</span><span><b>{activity.batch.progress?.failedQuestions ?? 0}</b> 실패</span><span><b>{activity.batch.conditions?.executionMode === 'parallel' ? '병렬' : '순차'}</b> 방식</span></div>
            {error && <div className="generation-failure" role="alert"><strong>실패 원인</strong><p>{error}</p>{activity.job?.last_error_code && <code>{activity.job.last_error_code}</code>}</div>}
            {activity.canResume && <button type="button" className="button secondary" onClick={resumeGeneration}><RotateCcw size={14} /> 미완료 문항 생성 재개</button>}
            {activity.items.length > 0 && <div className="generation-item-list"><h3>문항별 실행 기록</h3>{activity.items.map((item) => {
              const audit = itemAudits[item.id]?.batchId === selectedBatchId
                ? itemAudits[item.id]
                : null;
              const invocationSummary = item.providerInvocationSummary ?? {
                total: 0,
                requested: 0,
                completed: 0,
                failed: 0,
                abandoned: 0,
              };
              return <LazyDisclosure
                key={`${item.id}:${item.state === 'FAILED' ? 'failed' : 'other'}`}
                defaultOpen={item.state === 'FAILED'}
                unmountClosed={false}
                onOpenChange={(open) => {
                  if (!open) {
                    evictItemAudit(item.id);
                  } else if (
                    item.state !== 'FAILED'
                    && !audit?.loaded
                    && !audit?.loading
                  ) {
                    void loadItemAudit(item.id);
                  }
                }}
                summary={<><strong>{item.ordinal}번 문항</strong><span className={`state-label state-${item.state.toLowerCase()}`}>{item.state}</span><small className="mono">시도 {item.attempts}회</small></>}
              >
                <div className="event-payload">
                  {item.questionPublicId && <p><strong>저장 문항</strong> <span className="mono">{item.questionPublicId}</span></p>}
                  {item.error && <p className="event-error"><strong>{item.error.code ?? 'GENERATION_ITEM_FAILED'} · {item.error.retryable ? '재시도 가능' : '입력·범위 수정 필요'}</strong><br />{item.error.message ?? '문항 생성에 실패했습니다.'}</p>}
                  <details><summary>방향성</summary><DirectionRecord value={item.direction} /></details>
                  <details><summary>최근 검색 요약</summary><RetrievalSummary value={item.latestRetrieval} /></details>
                  <section aria-label={`${item.ordinal}번 문항 모델 호출 요약`}>
                    <h4>실제 모델 호출 {invocationSummary.total}건</h4>
                    <p className="run-meta mono">
                      요청 중 {invocationSummary.requested} · 완료 {invocationSummary.completed} · 실패 {invocationSummary.failed}
                      {' '}· 중단 {invocationSummary.abandoned ?? 0}
                    </p>
                  </section>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={audit?.loading}
                    onClick={() => void loadItemAudit(item.id, 0, true)}
                  >
                    {audit?.loading && !audit.loaded
                      ? '상세 감사 기록 불러오는 중'
                      : audit?.loaded
                        ? '상세 감사 기록 새로고침'
                        : '상세 감사 기록 불러오기'}
                  </button>
                  {audit?.error && <p className="event-error" role="alert">{audit.error}</p>}
                  {audit?.loaded && <section aria-label={`${item.ordinal}번 문항 상세 감사 기록`}>
                    <LazyDisclosure summary="검색 감사 상세">
                      <RetrievalRecord value={audit.latestRetrieval} />
                    </LazyDisclosure>
                    <h4>
                      불러온 모델 호출 {audit.providerInvocations.length}/{audit.pagination?.total ?? audit.providerInvocations.length}건
                    </h4>
                    {audit.providerInvocations.length
                      ? audit.providerInvocations.map((invocation) => <ProviderInvocationRecord key={invocation.id} invocation={invocation} />)
                      : <p>저장된 Provider 호출 기록이 없습니다. legacy partial 기록은 추정하지 않습니다.</p>}
                    {audit.pagination?.nextOffset != null && <button
                      type="button"
                      className="button secondary"
                      disabled={audit.loading}
                      onClick={() => void loadItemAudit(item.id, audit.pagination!.nextOffset!)}
                    >
                      {audit.loading ? '모델 호출 불러오는 중' : '모델 호출 더 보기'}
                    </button>}
                  </section>}
                  <small>최근 변경 {new Date(item.updatedAt).toLocaleString('ko-KR')}</small>
                </div>
              </LazyDisclosure>;
            })}</div>}
            <div className="generation-event-list">{activity.events.length === 0 ? <p className="empty-events">아직 기록이 없습니다.</p> : [...activity.events].reverse().map((event) => <LazyDisclosure
              key={event.id}
              defaultOpen={event.event_type.includes('FAILED')}
              summary={<><span className={`event-dot ${event.event_type.includes('FAILED') ? 'failed' : ''}`} /><strong>{eventLabels[event.event_type] ?? event.event_type}</strong><time>{new Date(event.created_at).toLocaleTimeString('ko-KR')}</time></>}
            ><div className="event-payload">
              {event.event_type === 'QUESTION_GENERATION_COMPLETED' && <><h4>{String(event.payload.ordinal)}번 문항</h4><p>{String(event.payload.questionText ?? '')}</p><strong>답안</strong><p>{String(event.payload.answerText ?? '')}</p></>}
              {event.event_type.includes('FAILED') && <p className="event-error">{String(event.payload.message ?? event.payload.code ?? '실패 원인이 기록되지 않았습니다.')}</p>}
              <JsonBlock value={event.payload} />
            </div></LazyDisclosure>)}</div>
            {activity.questions.length > 0 && <div className="persisted-questions"><h3>저장된 문항 {activity.questions.length}개</h3>{activity.questions.map((question) => <details key={question.public_id}><summary><strong>{question.public_id}</strong><span>{question.status}</span></summary><div><p>{question.question_text}</p><strong>모범 답안</strong><p>{question.answer_text}</p></div></details>)}</div>}
          </div>}
        </section>
      </div>
    </div>
  </div>;
}
