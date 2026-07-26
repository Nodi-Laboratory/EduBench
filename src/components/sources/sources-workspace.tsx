'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Ban, ChevronRight, CircleStop, FileText, LoaderCircle, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { JsonBlock } from '@/components/ui/json-block';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';
import { useCursorEventStream } from '@/hooks/use-cursor-event-stream';

export type SourceListItem = {
  id: string;
  original_name: string;
  subject: string | null;
  grade: string | null;
  byte_size: string | number;
  status: string;
  failed_stage: string | null;
  created_at: string;
  current_job_id: string | null;
  current_job_state: string | null;
  source_lineage_id?: string;
  reprocessed_from_source_file_id?: string | null;
  reprocess_required?: boolean;
};

type ActivityEvent = { id: string; event_type: string; payload: Record<string, unknown>; created_at: string };
type ExecutionProfileAudit = {
  kind: 'document_parse' | 'embedding_rag';
  profileId: string | null;
  definition: unknown;
  contentHash: string | null;
  provenance: string;
};
type Activity = {
  source: SourceListItem & { failure_code?: string | null; failure_message?: string | null; updated_at: string };
  job: { id: string; state: string; attempts: number; max_attempts: number; result?: unknown; last_error_code?: string | null; last_error_message?: string | null } | null;
  events: ActivityEvent[];
  eventCursor: string;
  executionProfiles?: {
    documentParse: ExecutionProfileAudit;
    embeddingRag: ExecutionProfileAudit;
  };
};
type ArtifactKind = 'revision' | 'pages' | 'chunks' | 'toc';
type ArtifactBase = {
  kind: ArtifactKind;
  source: { id: string; original_name: string };
  completeness: 'COMPLETE' | 'INCOMPLETE' | 'LEGACY_PARTIAL' | 'NOT_AVAILABLE';
};
type RevisionArtifacts = ArtifactBase & {
  kind: 'revision';
  artifact: null | {
    id: string;
    revision: number;
    parseModel: string | null;
    parseRequestId: string | null;
    rawResponse: unknown;
    rawHtml: string | null;
    rawMarkdown: string | null;
    reviewedHtml: string | null;
    reviewSummary: string | null;
    contentIncluded?: boolean;
    contentAvailable?: boolean;
    contentBytes?: {
      rawHtml:number | null;
      rawMarkdown:number | null;
      reviewedHtml:number | null;
    };
    createdAt: string;
  };
};
type ChunkArtifacts = ArtifactBase & {
  kind: 'chunks';
  revision: { id: string; revision: number };
  total: number;
  nextAfterOrdinal: number | null;
  items: Array<{
    id: string;
    ordinal: number;
    chapter: string | null;
    unit: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    kind: string;
    html: string | null;
    content: string;
    tokenCount: number | null;
    embedding: {
      model: string | null;
      version: string | null;
      vectorSpaceId: string | null;
      profileHash: string | null;
      provenance: string | null;
      dimensions: number | null;
      norm: number | null;
    };
  }>;
};
type PageArtifacts = ArtifactBase & {
  kind: 'pages';
  revision: { id: string; revision: number };
  expectedPageCount: number | null;
  persistedPageCount: number;
  total: number;
  nextAfterPage: number | null;
  items: Array<{
    id: string;
    pageNumber: number;
    filename: string;
    mimeType: string;
    rasterWidth: number | null;
    rasterHeight: number | null;
    parseModel: string | null;
    parseRequestId: string | null;
    requestConfig: unknown;
    rawResponse: unknown;
    rawResponseIncluded?: boolean;
    rawHtml: string;
    rawMarkdown: string | null;
    createdAt: string;
  }>;
};
type TocArtifacts = ArtifactBase & {
  kind: 'toc';
  revision: { id: string; revision: number };
  total: number;
  mappingSummary?: { mapped:number; unmapped:number };
  nextAfterOrdinal: number | null;
  items: Array<{
    id: string;
    ordinal: number;
    title: string;
    level: number;
    printedPage: number | null;
    mappingStatus: string;
    mappingConfidence: number | null;
    mappings: unknown[];
  }>;
};
type SourceArtifacts = RevisionArtifacts | PageArtifacts | ChunkArtifacts | TocArtifacts;

export type SourceStageKey = 'parse' | 'html' | 'chunk' | 'embedding';
type SourceStageState = '대기' | '처리 중' | '완료' | '실패' | '중단' | '기록 없음';

const stages: readonly { key: SourceStageKey; label: string }[] = [
  { key: 'parse', label: 'Document Parse' },
  { key: 'html', label: 'HTML 검수' },
  { key: 'chunk', label: '청크' },
  { key: 'embedding', label: '임베딩' },
];
const activeJobStates = new Set(['PENDING', 'RETRY_WAIT', 'LEASED']);
const connectionLabels = {
  idle: '연결 대기',
  connecting: '연결 중',
  live: '실시간 연결',
  reconnecting: '재연결 중',
} as const;
const eventLabels: Record<string, string> = {
  JOB_ENQUEUED: '작업 등록', JOB_CLAIMED: '워커 실행 시작', JOB_CANCELLED: '사용자 중단',
  JOB_SUCCEEDED: '작업 완료', JOB_RETRY_SCHEDULED: '재시도 예약', JOB_RELEASED_ON_SHUTDOWN: '워커 종료 · 안전 재개 대기', JOB_TERMINAL_FAILED: '작업 실패',
  PIPELINE_STARTED: '교과서 처리 시작', DOCUMENT_PARSE_STARTED: 'Upstage Document Parse 시작',
  DOCUMENT_RASTERIZATION_STARTED: 'PDF 페이지 분리 시작',
  DOCUMENT_RASTER_BATCH_STARTED: 'PDF 페이지 배치 렌더링 시작',
  DOCUMENT_PAGE_RENDERED: '고화질 페이지 이미지 생성',
  DOCUMENT_RASTER_BATCH_COMPLETED: 'PDF 페이지 배치 렌더링 완료',
  DOCUMENT_PARSE_BATCH_STARTED: '페이지 파싱 배치 시작', DOCUMENT_PARSE_BATCH_COMPLETED: '페이지 파싱 배치 완료',
  DOCUMENT_PAGE_PARSE_STARTED: '페이지 이미지 파싱 시작', DOCUMENT_PAGE_PARSE_RETRY: '페이지 API 호출 재시도',
  DOCUMENT_PAGE_PARSE_COMPLETED: '페이지 파싱 완료',
  DOCUMENT_PARSE_COMPLETED: 'Document Parse 완료', DOCUMENT_PARSE_PERSISTED: '파싱 원문 영구 저장',
  CHUNKING_STARTED: 'HTML 청킹 시작',
  CHUNKING_COMPLETED: 'HTML 청킹 완료', GEMINI_EMBEDDING_STARTED: 'Gemini 임베딩 시작',
  TABLE_OF_CONTENTS_EXTRACTED: '교과서 목차 추출 완료',
  EMBEDDING_BATCH_COMPLETED: '임베딩 배치 완료', GEMINI_EMBEDDING_COMPLETED: 'Gemini 임베딩 완료',
  EMBEDDING_BATCH_STARTED: '임베딩 배치 시작',
  PIPELINE_COMPLETED: '교과서 처리 완료', PIPELINE_FAILED: '교과서 처리 실패',
};
const artifactInvalidationEvents = new Set([
  'DOCUMENT_PARSE_PERSISTED',
  'PIPELINE_COMPLETED',
  'PIPELINE_FAILED',
  'JOB_SUCCEEDED',
  'JOB_TERMINAL_FAILED',
  'JOB_CANCELLED',
]);

const statusOrder: Record<string, number> = {
  UPLOADED: 0,
  PARSING: 1,
  PARSED: 2,
  HTML_REVIEWED: 3,
  CHUNKING: 4,
  CHUNKED: 5,
  EMBEDDING: 6,
  READY: 7,
};
const artifactTabs: readonly { kind: ArtifactKind; label: string }[] = [
  { kind: 'revision', label: '파싱 원문' },
  { kind: 'pages', label: '파싱 페이지' },
  { kind: 'chunks', label: '청크·임베딩' },
  { kind: 'toc', label: '목차 매핑' },
];
const stageThreshold: Record<SourceStageKey, number> = {
  parse: 2,
  html: 3,
  chunk: 5,
  embedding: 7,
};
const activeStageByStatus: Partial<Record<string, SourceStageKey>> = {
  PARSING: 'parse',
  CHUNKING: 'chunk',
  EMBEDDING: 'embedding',
};
const failedStageByCode: Record<string, SourceStageKey> = {
  UPLOADED: 'parse',
  PARSE: 'parse',
  PARSING: 'parse',
  DOCUMENT_PARSE: 'parse',
  DOCUMENT_PARSING: 'parse',
  UPSTAGE_DOCUMENT_PARSE: 'parse',
  PARSED: 'html',
  HTML: 'html',
  HTML_REVIEW: 'html',
  HTML_REVIEWED: 'html',
  CHUNK: 'chunk',
  CHUNKING: 'chunk',
  CHUNKED: 'chunk',
  EMBED: 'embedding',
  EMBEDDING: 'embedding',
  GEMINI_EMBEDDING: 'embedding',
};
const stageIndex: Record<SourceStageKey, number> = {
  parse: 0,
  html: 1,
  chunk: 2,
  embedding: 3,
};

export function sourceStageState(
  source: Pick<SourceListItem, 'status' | 'failed_stage'>,
  stage: SourceStageKey,
): SourceStageState {
  const status = source.status.toUpperCase();
  if (status === 'CANCELLED') return '중단';
  if (status === 'FAILED') {
    const failedStage = source.failed_stage
      ? failedStageByCode[source.failed_stage.trim().toUpperCase()]
      : undefined;
    if (!failedStage) return '기록 없음';
    if (stage === failedStage) return '실패';
    return stageIndex[stage] < stageIndex[failedStage] ? '완료' : '대기';
  }

  const current = statusOrder[status];
  if (current == null) return '기록 없음';
  if (current >= stageThreshold[stage]) return '완료';
  if (activeStageByStatus[status] === stage) return '처리 중';
  return '대기';
}

function PageRawResponse({
  sourceId,
  revisionId,
  page,
}: {
  sourceId:string;
  revisionId:string;
  page:PageArtifacts['items'][number];
}) {
  const [rawResponse, setRawResponse] = useState(page.rawResponse);
  const [loaded, setLoaded] = useState(Boolean(page.rawResponseIncluded));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(open: boolean) {
    if (!open || loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        kind:'pages',
        limit:'1',
        afterPage:String(Math.max(0, page.pageNumber - 1)),
        revisionId,
        includeRaw:'1',
      });
      const response = await fetch(
        `/api/sources/${sourceId}/artifacts?${query.toString()}`,
        { cache:'no-store' },
      );
      const body = await response.json() as PageArtifacts & {
        code?:string;
        message?:string;
      };
      const exact = body.kind === 'pages'
        ? body.items.find((entry) => entry.pageNumber === page.pageNumber)
        : null;
      if (!response.ok || body.revision?.id !== revisionId || !exact) {
        throw new Error(body.message ?? body.code ?? '페이지 원시 응답을 불러오지 못했습니다.');
      }
      setRawResponse(exact.rawResponse);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : '페이지 원시 응답을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return <details onToggle={(event) => void load(event.currentTarget.open)}>
    <summary>Provider 원시 응답 {loaded ? '' : '· 펼칠 때 불러오기'}</summary>
    {loading
      ? <p>원시 응답을 불러오는 중…</p>
      : error
        ? <p className="result-warning">{error}</p>
        : loaded
          ? <JsonBlock value={rawResponse} />
          : null}
  </details>;
}

function RevisionArtifactView({
  result,
  artifact:initialArtifact,
}: {
  result:RevisionArtifacts;
  artifact:NonNullable<RevisionArtifacts['artifact']>;
}) {
  const [artifact, setArtifact] = useState(initialArtifact);
  const [loaded, setLoaded] = useState(Boolean(initialArtifact.contentIncluded));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'readable' | 'html' | 'reviewed'>('readable');

  async function loadContent() {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        kind:'revision',
        revisionId:artifact.id,
        includeContent:'1',
      });
      const response = await fetch(
        `/api/sources/${result.source.id}/artifacts?${query.toString()}`,
        { cache:'no-store' },
      );
      const body = await response.json() as RevisionArtifacts & {
        code?:string;
        message?:string;
      };
      if (
        !response.ok
        || body.kind !== 'revision'
        || body.artifact?.id !== artifact.id
      ) {
        throw new Error(body.message ?? body.code ?? '파싱 본문을 불러오지 못했습니다.');
      }
      setArtifact(body.artifact);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error
        ? loadError.message
        : '파싱 본문을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const meaningfulMarkdown = artifact.rawMarkdown
    ?.replace(/<!--\s*page:\d+\s*-->/g, '')
    .trim()
    ? artifact.rawMarkdown
    : null;
  const readable = meaningfulMarkdown ?? artifact.rawHtml;
  const selectedContent = view === 'html'
    ? artifact.rawHtml
    : view === 'reviewed'
      ? artifact.reviewedHtml
      : readable;
  const bytes = artifact.contentBytes;

  return <article>
    <header><strong>Revision {artifact.revision}</strong><span>{result.completeness}</span></header>
    <p className="run-meta mono">model {artifact.parseModel ?? '기록 없음'} · request {artifact.parseRequestId ?? '기록 없음'}</p>
    <p className="run-meta mono">
      Markdown {bytes?.rawMarkdown ?? '—'} B · HTML {bytes?.rawHtml ?? '—'} B
      {' · '}검수 HTML {bytes?.reviewedHtml ?? '—'} B
    </p>
    {!loaded && artifact.contentAvailable !== false && <button
      className="button"
      type="button"
      disabled={loading}
      onClick={() => void loadContent()}
    >{loading ? '본문 불러오는 중…' : '파싱 본문 불러오기'}</button>}
    {error && <p className="result-warning">{error}</p>}
    {loaded && <>
      <div className="heading-actions">
        <button className="button" type="button" onClick={() => setView('readable')}>읽기 본문</button>
        <button className="button" type="button" onClick={() => setView('html')}>원본 HTML</button>
        <button className="button" type="button" onClick={() => setView('reviewed')}>검수 HTML</button>
      </div>
      <h4>{view === 'html' ? '원본 HTML' : view === 'reviewed' ? '검수 HTML' : '사람이 읽는 파싱 본문'}</h4>
      <pre>{selectedContent ?? '기록 없음'}</pre>
    </>}
    <p>{artifact.reviewSummary ?? '검수 요약 기록 없음'}</p>
    <details><summary>Provider revision 응답 요약</summary><JsonBlock value={artifact.rawResponse ?? '기록 없음'} /></details>
    <small className="mono">revision {artifact.id} · {artifact.createdAt}</small>
  </article>;
}

function SourceArtifactView({
  result,
  loadingMore,
  onLoadMore,
}: {
  result: SourceArtifacts;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (result.completeness === 'NOT_AVAILABLE') {
    return <p>저장된 실제 산출물이 없습니다.</p>;
  }
  if (result.kind === 'revision') {
    const artifact = result.artifact;
    if (!artifact) return <p>저장된 파싱 revision이 없습니다.</p>;
    return <RevisionArtifactView result={result} artifact={artifact} />;
  }
  if (result.kind === 'pages') {
    return <div>
      <p>
        {result.total}개 중 {result.items.length}개 페이지 · {result.completeness}
        {result.expectedPageCount == null
          ? ' · 기존 revision은 기대 페이지 수 기록 없음'
          : ` · 기대 ${result.expectedPageCount} / 저장 ${result.persistedPageCount}`}
      </p>
      {result.items.length ? result.items.map((page) => <article key={page.id}>
        <header>
          <strong>Page {page.pageNumber}</strong>
          <span>{page.filename}</span>
        </header>
        <p className="run-meta mono">
          {page.mimeType} · {page.rasterWidth ?? '—'}×{page.rasterHeight ?? '—'}
          {' · '}model {page.parseModel ?? '기록 없음'}
        </p>
        {page.rawMarkdown
          ? <pre>{page.rawMarkdown}</pre>
          : <pre>{page.rawHtml}</pre>}
        <details><summary>페이지 HTML</summary><pre>{page.rawHtml}</pre></details>
        <PageRawResponse
          sourceId={result.source.id}
          revisionId={result.revision.id}
          page={page}
        />
        <small className="mono">page artifact {page.id} · request {page.parseRequestId ?? '기록 없음'}</small>
      </article>) : <p>저장된 페이지 artifact가 없습니다.</p>}
      {result.nextAfterPage != null && <button
        className="button"
        type="button"
        disabled={loadingMore}
        onClick={onLoadMore}
      >{loadingMore ? '페이지 불러오는 중…' : '페이지 더 보기'}</button>}
    </div>;
  }
  if (result.kind === 'chunks') {
    return <div>
      <p>{result.total}개 중 {result.items.length}개 청크를 표시합니다.</p>
      {result.items.length ? result.items.map((chunk) => <article key={chunk.id}>
        <header><strong>{chunk.ordinal}. {chunk.unit ?? chunk.chapter ?? '단원 기록 없음'}</strong><span>{chunk.kind}</span></header>
        <p>{chunk.content}</p>
        <p className="run-meta mono">
          page {chunk.pageStart ?? '—'}–{chunk.pageEnd ?? '—'} · token {chunk.tokenCount ?? '—'}
        </p>
        <dl>
          <div><dt>임베딩 모델</dt><dd>{chunk.embedding.model ?? '기록 없음'}</dd></div>
          <div><dt>벡터 공간</dt><dd className="mono">{chunk.embedding.vectorSpaceId ?? '기록 없음'}</dd></div>
          <div><dt>차원 / norm</dt><dd className="mono">{chunk.embedding.dimensions ?? '—'} / {chunk.embedding.norm ?? '—'}</dd></div>
          <div><dt>프로필 해시</dt><dd className="mono">{chunk.embedding.profileHash ?? '기록 없음'}</dd></div>
        </dl>
        <details><summary>청크 HTML</summary><pre>{chunk.html ?? '기록 없음'}</pre></details>
        <small className="mono">chunk {chunk.id} · provenance {chunk.embedding.provenance ?? '기록 없음'}</small>
      </article>) : <p>저장된 청크가 없습니다.</p>}
      {result.nextAfterOrdinal != null && <button
        className="button"
        type="button"
        disabled={loadingMore}
        onClick={onLoadMore}
      >{loadingMore ? '청크 불러오는 중…' : '청크 더 보기'}</button>}
    </div>;
  }
  return <div>
    <p>{result.total}개 중 {result.items.length}개 목차 항목 · {result.completeness}</p>
    {result.mappingSummary && <p
      className={result.mappingSummary.unmapped > 0 ? 'result-warning' : 'inline-notice'}
      role={result.mappingSummary.unmapped > 0 ? 'alert' : 'status'}
    >
      청크 연결 {result.mappingSummary.mapped}/{result.total}
      {' · '}미연결 {result.mappingSummary.unmapped}개
      {result.mappingSummary.unmapped > 0
        ? ' — 미연결 목차는 단원 제한 RAG의 근거 범위를 좁힐 수 있으므로 연구 결과 해석 전에 확인하십시오.'
        : ' — 모든 목차 항목이 청크 근거와 연결됐습니다.'}
    </p>}
    {result.items.length ? result.items.map((entry) => <article key={entry.id}>
      <header><strong>{entry.ordinal}. {entry.title}</strong><span>{entry.mappingStatus}</span></header>
      <p className="run-meta mono">level {entry.level} · page {entry.printedPage ?? '—'} · confidence {entry.mappingConfidence ?? '—'}</p>
      <details><summary>청크 매핑 {entry.mappings.length}건</summary><JsonBlock value={entry.mappings} /></details>
      <small className="mono">toc {entry.id}</small>
    </article>) : <p>저장된 목차 매핑이 없습니다.</p>}
    {result.nextAfterOrdinal != null && <button
      className="button"
      type="button"
      disabled={loadingMore}
      onClick={onLoadMore}
    >{loadingMore ? '목차 불러오는 중…' : '목차 더 보기'}</button>}
  </div>;
}

export function SourcesWorkspace({ initialSources }: { initialSources: SourceListItem[] }) {
  const [sources, setSources] = useState(initialSources);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);
  const [artifactState, setArtifactState] = useState<{
    sourceId: string | null;
    activeKind: ArtifactKind | null;
    cache: Partial<Record<ArtifactKind, SourceArtifacts>>;
    loadingKind: ArtifactKind | null;
    error: string | null;
    epoch: number;
  }>({
    sourceId: null,
    activeKind: null,
    cache: {},
    loadingKind: null,
    error: null,
    epoch: 0,
  });
  const clearArtifactState = useCallback(() => {
    setArtifactState((current) => ({
      sourceId:null,
      activeKind:null,
      cache:{},
      loadingKind:null,
      error:null,
      epoch:current.epoch + 1,
    }));
  }, []);

  const mergeSourceSnapshot = useCallback((snapshot: SourceListItem) => {
    setSources((current) => {
      const found = current.some((source) => source.id === snapshot.id);
      return found
        ? current.map((source) => source.id === snapshot.id ? { ...source, ...snapshot } : source)
        : [snapshot, ...current];
    });
  }, []);

  const refreshSources = useCallback(async () => {
    const response = await fetch('/api/sources', { cache: 'no-store' });
    if (response.ok) setSources((await response.json()).items);
  }, []);
  const fetchActivity = useCallback(async (
    sourceId: string,
    includeHistory: boolean,
    signal?: AbortSignal,
  ): Promise<Activity | Omit<Activity, 'events'> | null> => {
    const suffix = includeHistory ? '' : '?history=0';
    const response = await fetch(`/api/sources/${sourceId}/activity${suffix}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    const snapshot = await response.json() as Partial<Activity>;
    return snapshot.source?.id === sourceId
      ? snapshot as Activity | Omit<Activity, 'events'>
      : null;
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const abort = new AbortController();
    void fetchActivity(selectedId, true, abort.signal).then((snapshot) => {
      if (!abort.signal.aborted && snapshot && 'events' in snapshot) {
        setActivity(snapshot as Activity);
        mergeSourceSnapshot(snapshot.source);
      }
    }).catch(() => undefined);
    return () => abort.abort();
  }, [selectedId, fetchActivity, mergeSourceSnapshot]);

  const refreshSelectedSnapshot = useCallback(async () => {
    if (!selectedId) return;
    const [snapshot] = await Promise.all([
      fetchActivity(selectedId, false),
      refreshSources(),
    ]);
    if (!snapshot) return;
    mergeSourceSnapshot(snapshot.source);
    setActivity((current) => current?.source.id === selectedId
      ? { ...snapshot, eventCursor: current.eventCursor, events: current.events } as Activity
      : current);
  }, [fetchActivity, mergeSourceSnapshot, refreshSources, selectedId]);
  const coalescedRefresh = useCoalescedRefresh(refreshSelectedSnapshot);
  const stream = useCursorEventStream({
    aggregate: 'source',
    id: selectedId,
    initialCursor: activity?.eventCursor,
    enabled: Boolean(
      selectedId
      && activity
      && activity.source?.id === selectedId
      && activity.eventCursor != null,
    ),
    onEvent(event) {
      if (artifactInvalidationEvents.has(event.eventType)) {
        setArtifactState((current) => current.sourceId === event.aggregateId
          ? {
              sourceId:current.sourceId,
              activeKind:null,
              cache:{},
              loadingKind:null,
              error:null,
              epoch:current.epoch + 1,
            }
          : current);
      }
      setActivity((current) => {
        if (!current || current.source.id !== event.aggregateId) return current;
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const form = event.currentTarget;
    const response = await fetch('/api/sources', { method: 'POST', body: new FormData(form) });
    const body = await response.json();
    if (!response.ok) setNotice(body.message ?? '파일을 등록하지 못했습니다.');
    else {
      setNotice(body.existing ? '동일한 파일의 처리 기록을 열었습니다.' : 'PDF를 저장했고 문서 분석을 시작합니다.');
      setActivity(null);
      clearArtifactState();
      setSelectedId(body.id);
      await refreshSources();
      form.reset();
    }
    setSubmitting(false);
  }
  async function retry(sourceId: string) {
    const response = await fetch(`/api/sources/${sourceId}/retry`, { method: 'POST' });
    const body = await response.json();
    setNotice(response.ok ? '문서 처리 작업을 다시 예약했습니다.' : (body.message ?? '재실행하지 못했습니다.'));
    await Promise.all([refreshSources(), fetchActivity(sourceId, false).then((snapshot) => {
      if (snapshot) setActivity((current) => current?.source.id === sourceId
        ? { ...snapshot, eventCursor: current.eventCursor, events: current.events } as Activity
        : current);
    })]);
  }
  async function reprocess(source: SourceListItem) {
    setReprocessingId(source.id);
    const response = await fetch(`/api/sources/${source.id}/reprocess`, {
      method:'POST',
    });
    const body = await response.json();
    if (!response.ok) {
      setNotice(body.message ?? '현재 연구 설정으로 다시 처리하지 못했습니다.');
    } else {
      setNotice(body.existing
        ? '현재 연구 설정과 일치하는 처리 기록을 열었습니다.'
        : '현재 연구 설정으로 새 처리 계보를 시작했습니다.');
      setActivity(null);
      clearArtifactState();
      setSelectedId(body.id);
      await refreshSources();
    }
    setReprocessingId(null);
  }
  async function cancel() {
    if (!selectedId) return;
    const sourceId = selectedId;
    setCancelling(true);
    const response = await fetch(`/api/sources/${sourceId}/cancel`, { method: 'POST' });
    const body = await response.json();
    setNotice(response.ok ? '교과서 처리를 중단했습니다.' : (body.message ?? '작업을 중단하지 못했습니다.'));
    await Promise.all([refreshSources(), fetchActivity(sourceId, false).then((snapshot) => {
      if (snapshot) setActivity((current) => current?.source.id === sourceId
        ? { ...snapshot, eventCursor: current.eventCursor, events: current.events } as Activity
        : current);
    })]);
    setCancelling(false);
  }
  async function remove(source: SourceListItem) {
    if (!window.confirm(`"${source.original_name}" 등록 자료를 삭제할까요?\n처리 기록과 원본은 복구를 위해 보존됩니다.`)) return;
    const response = await fetch(`/api/sources/${source.id}`, { method: 'DELETE' });
    const body = await response.json();
    setNotice(response.ok ? '등록 자료를 목록에서 삭제했습니다.' : (body.message ?? '등록 자료를 삭제하지 못했습니다.'));
    if (response.ok) {
      setSources((current) => current.filter((item) => item.id !== source.id));
      setActivity((current) => current?.source.id === source.id ? null : current);
      setSelectedId((current) => current === source.id ? null : current);
      if (selectedId === source.id) clearArtifactState();
    }
  }
  async function showArtifact(kind: ArtifactKind) {
    if (!selectedId) return;
    const sourceId = selectedId;
    const scopedState = artifactState.sourceId === sourceId
      ? artifactState
      : {
          sourceId,
          activeKind: null,
          cache: {},
          loadingKind: null,
          error: null,
          epoch: artifactState.epoch + 1,
        };
    const requestEpoch = scopedState.epoch;
    setArtifactState({
      ...scopedState,
      activeKind: kind,
      loadingKind: scopedState.cache[kind] ? null : kind,
      error: null,
    });
    if (scopedState.cache[kind] || scopedState.loadingKind === kind) return;
    try {
      const suffix = kind === 'revision'
        ? ''
        : `&limit=${kind === 'pages' ? 5 : 25}`;
      const response = await fetch(`/api/sources/${sourceId}/artifacts?kind=${kind}${suffix}`, {
        cache: 'no-store',
      });
      const body = await response.json() as SourceArtifacts & { code?: string; message?: string };
      if (!response.ok) {
        setArtifactState((current) => current.sourceId === sourceId
          && current.epoch === requestEpoch
          ? { ...current, error: body.message ?? body.code ?? '실제 산출물을 불러오지 못했습니다.' }
          : current);
        return;
      }
      if (body.source?.id === sourceId) {
        setArtifactState((current) => current.sourceId === sourceId
          && current.epoch === requestEpoch
          ? { ...current, cache: { ...current.cache, [kind]: body } }
          : current);
      }
    } catch {
      setArtifactState((current) => current.sourceId === sourceId
        && current.epoch === requestEpoch
        ? { ...current, error: '실제 산출물을 불러오지 못했습니다.' }
        : current);
    } finally {
      setArtifactState((current) => current.sourceId === sourceId
        && current.epoch === requestEpoch
        ? { ...current, loadingKind: null }
        : current);
    }
  }
  async function loadMoreArtifact() {
    if (!selectedId || artifactState.sourceId !== selectedId || !artifactState.activeKind) return;
    const sourceId = selectedId;
    const kind = artifactState.activeKind;
    const requestEpoch = artifactState.epoch;
    const pageLimit = kind === 'pages' ? 5 : 25;
    const cached = artifactState.cache[kind];
    if (!cached || cached.kind === 'revision') return;
    const cursor = cached.kind === 'pages'
      ? cached.nextAfterPage
      : cached.nextAfterOrdinal;
    if (cursor == null || artifactState.loadingKind === kind) return;
    const cursorQuery = cached.kind === 'pages'
      ? `afterPage=${cursor}`
      : `afterOrdinal=${cursor}`;
    setArtifactState((current) => current.sourceId === sourceId
      && current.epoch === requestEpoch
      ? { ...current, loadingKind: kind, error: null }
      : current);
    try {
      const refreshLatest = async () => {
        const freshResponse = await fetch(
          `/api/sources/${sourceId}/artifacts?kind=${kind}&limit=${pageLimit}`,
          { cache:'no-store' },
        );
        const freshBody = await freshResponse.json() as SourceArtifacts & {
          code?:string;
          message?:string;
        };
        if (!freshResponse.ok || freshBody.source?.id !== sourceId) {
          throw new Error(freshBody.message ?? freshBody.code ?? '최신 산출물을 불러오지 못했습니다.');
        }
        setArtifactState((current) => current.sourceId === sourceId
          && current.epoch === requestEpoch
          ? {
              ...current,
              activeKind:kind,
              cache:{ ...current.cache, [kind]:freshBody },
            }
          : current);
      };
      const response = await fetch(
        `/api/sources/${sourceId}/artifacts?kind=${kind}&limit=${pageLimit}&revisionId=${encodeURIComponent(cached.revision.id)}&${cursorQuery}`,
        { cache: 'no-store' },
      );
      const body = await response.json() as SourceArtifacts & {
        code?: string;
        message?: string;
      };
      if (!response.ok && body.code === 'SOURCE_ARTIFACT_REVISION_MISMATCH') {
        await refreshLatest();
        return;
      }
      if (!response.ok) {
        setArtifactState((current) => current.sourceId === sourceId
          && current.epoch === requestEpoch
          ? { ...current, error: body.message ?? body.code ?? '추가 산출물을 불러오지 못했습니다.' }
          : current);
        return;
      }
      if (
        body.kind === 'revision'
        || body.kind !== cached.kind
        || body.revision.id !== cached.revision.id
      ) {
        await refreshLatest();
        return;
      }
      setArtifactState((current) => {
        if (
          current.sourceId !== sourceId
          || current.epoch !== requestEpoch
          || body.source?.id !== sourceId
        ) return current;
        const existing = current.cache[kind];
        let merged: SourceArtifacts = body;
        if (existing?.kind === 'pages' && body.kind === 'pages') {
          merged = { ...body, items: [...existing.items, ...body.items] };
        } else if (existing?.kind === 'chunks' && body.kind === 'chunks') {
          merged = { ...body, items: [...existing.items, ...body.items] };
        } else if (existing?.kind === 'toc' && body.kind === 'toc') {
          merged = { ...body, items: [...existing.items, ...body.items] };
        }
        return { ...current, cache: { ...current.cache, [kind]: merged } };
      });
    } catch {
      setArtifactState((current) => current.sourceId === sourceId
        && current.epoch === requestEpoch
        ? { ...current, error: '추가 산출물을 불러오지 못했습니다.' }
        : current);
    } finally {
      setArtifactState((current) => current.sourceId === sourceId
        && current.epoch === requestEpoch
        ? { ...current, loadingKind: null }
        : current);
    }
  }

  const selected = sources.find((source) => source.id === selectedId);
  const canCancel = Boolean(activity?.job && activeJobStates.has(activity.job.state));
  const artifactKind = artifactState.sourceId === selectedId ? artifactState.activeKind : null;
  const artifactLoading = artifactState.sourceId === selectedId ? artifactState.loadingKind : null;
  const artifactError = artifactState.sourceId === selectedId ? artifactState.error : null;
  const activeArtifact = artifactKind && artifactState.sourceId === selectedId
    ? artifactState.cache[artifactKind]
    : null;

  return (
    <div className="workflow-page">
      <header className="page-heading"><div><span className="eyebrow">SOURCES / TEXTBOOKS</span><h1>교과서 자료 관리</h1><p>PDF 원본부터 HTML·청크·임베딩까지 처리 과정을 실시간으로 추적합니다.</p></div></header>
      <section className="upload-panel panel">
        <form onSubmit={submit}>
          <div className="upload-copy"><span className="upload-icon"><Upload size={20} /></span><div><strong>교과서 PDF 등록</strong><p>최대 100MB. 업로드 직후 처리 로그가 열립니다.</p></div></div>
          <label className="file-control">교과서 PDF<input aria-label="교과서 PDF" name="file" type="file" accept="application/pdf" required /></label>
          <label>과목<input name="subject" placeholder="예: 과학" /></label><label>학년<input name="grade" placeholder="예: 중학교 2학년" /></label>
          <button className="button primary" disabled={submitting}>{submitting ? '저장 중…' : '업로드 및 분석 시작'}</button>
        </form>
        {notice && <p className="inline-notice" role="status">{notice}</p>}
      </section>
      <div className={`sources-layout ${selectedId ? 'has-activity' : ''}`}>
        <section className="panel workflow-table-panel">
          <div className="panel-heading"><div><span className="section-index mono">01</span><h2>등록 자료</h2></div><span className="count-label mono">{sources.length} FILES</span></div>
          <div className="data-table-wrap"><table className="data-table source-table"><thead><tr><th>파일</th><th>과목·학년</th>{stages.map((stage) => <th key={stage.key}>{stage.label}</th>)}<th>등록 일시</th><th aria-label="작업" /></tr></thead><tbody>
            {sources.map((source) => <tr key={source.id} className={selectedId === source.id ? 'selected-source' : ''} onClick={() => {
              if (selectedId !== source.id) {
                setActivity(null);
                clearArtifactState();
              }
              setSelectedId(source.id);
            }}>
              <td><div className="file-cell"><FileText size={17} /><div><strong>{source.original_name}</strong><small className="mono">{source.id.slice(0, 8)}</small></div></div></td>
              <td>{source.subject ?? '미지정'} · {source.grade ?? '미지정'}</td>
              {stages.map((stage) => { const state = sourceStageState(source, stage.key); return <td key={stage.key}><span className={`state-label state-${state.replace(' ', '-')}`}>{state}</span></td>; })}
              <td className="mono">{source.created_at.slice(0, 16).replace('T', ' ')}</td>
              <td><div className="source-row-actions">{source.reprocess_required
                ? <button
                  className="icon-button"
                  aria-label={`${source.original_name} 현재 설정으로 재처리`}
                  disabled={reprocessingId === source.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void reprocess(source);
                  }}
                ><RotateCcw size={15} /></button>
                : ['FAILED', 'CANCELLED'].includes(source.status) && <button className="icon-button" aria-label="문서 처리 재실행" onClick={(event) => { event.stopPropagation(); void retry(source.id); }}><RotateCcw size={15} /></button>}<button className="icon-button delete-source-button" aria-label={`${source.original_name} 삭제`} onClick={(event) => { event.stopPropagation(); void remove(source); }}><Trash2 size={15} /></button></div></td>
            </tr>)}
            {sources.length === 0 && <tr><td colSpan={9}><div className="table-empty"><FileText size={22} /><strong>등록된 교과서가 없습니다.</strong><span>위에서 PDF를 등록하면 처리 상태가 여기에 표시됩니다.</span></div></td></tr>}
          </tbody></table></div>
        </section>
        {selectedId && <aside className="panel source-activity" aria-label="교과서 처리 기록">
          <div className="source-activity-header"><div><span className="eyebrow">LIVE PROCESS LOG</span><h2>{selected?.original_name ?? activity?.source.original_name ?? '처리 기록'}</h2></div><button className="icon-button" aria-label="기록 닫기" onClick={() => { setActivity(null); clearArtifactState(); setSelectedId(null); }}><X size={15} /></button></div>
          <div className="source-job-summary">
            <span className={`status-dot ${canCancel ? '' : 'idle'}`} />
            <div><strong>{activity?.job?.state ?? '기록 불러오는 중'}</strong><small>{activity ? `${activity.events.length}개 로그 · 시도 ${activity.job?.attempts ?? 0}/${activity.job?.max_attempts ?? 0}` : '잠시 기다려 주세요'}</small>{activity && <small>{connectionLabels[stream.status]}</small>}</div>
            {canCancel && <button className="button danger" onClick={cancel} disabled={cancelling}><CircleStop size={14} /> {cancelling ? '중단 중…' : '작업 중단'}</button>}
          </div>
          {activity?.executionProfiles && <section className="source-profile-audit" aria-label="고정 실행 설정">
            <h3>고정 실행 설정</h3>
            {([
              ['Document Parse', activity.executionProfiles.documentParse],
              ['Embedding · RAG', activity.executionProfiles.embeddingRag],
            ] as const).map(([label, profile]) => <article key={profile.kind}>
              <header><strong>{label}</strong><span>{profile.provenance}</span></header>
              <dl>
                <div><dt>프로필 ID</dt><dd>{profile.profileId ?? '기존 기록 · 미확인'}</dd></div>
                <div><dt>콘텐츠 해시</dt><dd className="mono">{profile.contentHash ?? '기존 기록 · 미확인'}</dd></div>
              </dl>
              <details>
                <summary>고정 설정 스냅샷</summary>
                <JsonBlock value={profile.definition} />
              </details>
            </article>)}
          </section>}
          <section className="source-profile-audit" aria-label="실제 산출물">
            <h3>실제 산출물</h3>
            <p>대형 원문·청크·매핑 데이터는 선택할 때만 불러오며 실시간 로그 새로고침과 분리됩니다.</p>
            <div role="tablist" aria-label="산출물 종류">
              {artifactTabs.map((tab) => <button
                key={tab.kind}
                type="button"
                role="tab"
                aria-selected={artifactKind === tab.kind}
                className="button"
                disabled={artifactLoading === tab.kind}
                onClick={() => void showArtifact(tab.kind)}
              >{artifactLoading === tab.kind ? `${tab.label} 불러오는 중…` : tab.label}</button>)}
            </div>
            {artifactError && <p className="event-error" role="alert">{artifactError}</p>}
            <div role="tabpanel">
              {!artifactKind && <p>확인할 산출물 종류를 선택하세요.</p>}
              {artifactKind && artifactLoading === artifactKind && <p>실제 산출물을 불러오는 중입니다.</p>}
              {activeArtifact && <SourceArtifactView
                result={activeArtifact}
                loadingMore={artifactLoading === activeArtifact.kind}
                onLoadMore={() => void loadMoreArtifact()}
              />}
            </div>
          </section>
          <div className="source-event-log" aria-live="polite">
            {!activity && <div className="activity-loading"><LoaderCircle className="lab-spinner" size={18} /> 기록을 불러오는 중입니다.</div>}
            {activity?.events.map((event, index) => <details key={event.id} className={`source-event event-${event.event_type}`}>
              <summary><ChevronRight size={14} /><span className="event-sequence mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{eventLabels[event.event_type] ?? event.event_type}</strong><time>{new Date(event.created_at).toLocaleTimeString('ko-KR')}</time></div></summary>
              <JsonBlock value={event.payload} />
            </details>)}
            {activity && activity.events.length === 0 && <div className="activity-loading"><Ban size={18} /> 아직 기록된 로그가 없습니다.</div>}
          </div>
        </aside>}
      </div>
    </div>
  );
}
