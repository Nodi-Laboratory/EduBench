'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileJson, FileText } from 'lucide-react';
import { ResultAnalyticsDashboard } from '@/components/results/result-analytics-dashboard';
import {
  benchmarkRetrievalModeMetadata,
  benchmarkRetrievalModes,
  type BenchmarkRetrievalMode,
  type StoredBenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import { resultMetricLabels } from '@/domain/result-metrics';
import { useCoalescedRefresh } from '@/hooks/use-coalesced-refresh';
import { useCursorEventStream } from '@/hooks/use-cursor-event-stream';
import type { ResultDetails } from '@/server/results/details';

const connectionLabels = {
  idle: '대기',
  connecting: '연결 중',
  live: '실시간 연결',
  reconnecting: '재연결 중',
} as const;

function retrievalLabel(mode: StoredBenchmarkRetrievalMode): string {
  return mode === 'LEGACY_EVIDENCE'
    ? '기존 근거'
    : benchmarkRetrievalModeMetadata[mode].shortLabel;
}

export function ResultDetailLive({
  initialDetails,
}: {
  initialDetails: ResultDetails;
}) {
  const [details, setDetails] = useState(initialDetails);
  const [selectedModes, setSelectedModes] = useState<
    BenchmarkRetrievalMode[]
  >(() => benchmarkRetrievalModes.filter((mode) => (
    initialDetails.run.retrievalModes.includes(mode)
  )));
  const [initialEventCursor] = useState(initialDetails.eventCursor);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const runId = initialDetails.run.id;
  const scheduleRefresh = useCoalescedRefresh(async () => {
    try {
      const response = await fetch(`/api/results/${runId}/details`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`RESULT_DETAILS_HTTP_${response.status}`);
      }
      const next = await response.json() as ResultDetails;
      if (next.run?.id !== runId) {
        setRefreshError('최신 결과 응답의 실행 식별자가 일치하지 않습니다. 마지막으로 확인된 결과를 유지합니다.');
        throw new Error('RESULT_DETAILS_RUN_MISMATCH');
      }
      setDetails(next);
      setRefreshError(null);
    } catch (error) {
      setRefreshError('최신 결과를 불러오지 못했습니다. 현재 화면에는 마지막으로 확인된 결과를 유지합니다.');
      throw error;
    }
  }, {
    retryLimit: 2,
    retryDelayMs: 300,
  });
  const stream = useCursorEventStream({
    aggregate: 'benchmark_run',
    id: runId,
    initialCursor: initialEventCursor,
    enabled: true,
    onEvent: () => scheduleRefresh(),
  });
  const summary = details.run;
  const scoringEngine = details.scoringEngine;
  const officialAnalysis = (
    !summary.profileReplacementRequired
    && scoringEngine.currentVerified
  );
  const hasComparableModes = details.run.retrievalModes.some(
    (mode) => mode !== 'LEGACY_EVIDENCE',
  );
  const visibleMode = (mode:StoredBenchmarkRetrievalMode) => (
    !hasComparableModes
    || (
      mode !== 'LEGACY_EVIDENCE'
      && selectedModes.includes(mode)
    )
  );
  const visibleModels = details.models.filter((model) => (
    visibleMode(model.retrievalMode)
  ));
  const visibleMetrics = details.metricSummary.filter((row) => (
    visibleMode(row.retrievalMode)
  ));
  const visibleCapabilities = details.capabilities.filter((row) => (
    visibleMode(row.retrievalMode)
  ));
  const visibleTotalItems = visibleModels.reduce(
    (sum, model) => sum + Number(model.totalItems),
    0,
  );
  const visibleResponses = visibleModels.reduce(
    (sum, model) => sum + Number(model.responses),
    0,
  );
  const visibleFailedItems = visibleModels.reduce(
    (sum, model) => sum + Number(model.failedItems),
    0,
  );
  const modeQuery = hasComparableModes
    ? `&modes=${encodeURIComponent(selectedModes.join(','))}`
    : '';

  return (
    <div className="workflow-page">
      <header className="page-heading">
        <div>
          <Link className="text-link" href="/results">
            <ArrowLeft size={13} /> 결과 목록
          </Link>
          <span className="eyebrow mono">{summary.publicId}</span>
          <h1>{summary.title}</h1>
          <p>
            {summary.datasetVersion} · {summary.scoreVersion ?? '—'} · 실제 저장 응답{' '}
            {summary.eligibleItems}건
          </p>
          <span className="state-label" role="status">
            {connectionLabels[stream.status]}
          </span>
        </div>
        <div className="heading-actions">
          <a className="button" href={`/api/results/${runId}/export?format=json${modeQuery}`}>
            <FileJson size={14} /> JSON
          </a>
          <a className="button" href={`/api/results/${runId}/export?format=pdf${modeQuery}`}>
            <FileText size={14} /> PDF 보고서
          </a>
          <a
            className="button primary"
            href={`/api/results/${runId}/export?format=csv${modeQuery}`}
          >
            <Download size={14} /> CSV 근거표
          </a>
        </div>
      </header>
      {refreshError && <p className="result-warning" role="alert">{refreshError}</p>}
      {(summary.parameters.sample_data || summary.parameters.mock_providers) && (
        <p className="result-warning">
          샘플 데이터 또는 MOCK 제공자를 사용한 실행은 기능 검증 전용이며 공식
          소개 자료의 근거로 사용할 수 없습니다.
        </p>
      )}
      {summary.profileReplacementRequired && (
        <p className="result-warning">
          채점 프로필 또는 생성 시점 스냅샷 provenance가 검증되지 않은 실행입니다.
          공식 근거로 사용하지 말고 새 프로필과 새 실행을 생성하십시오.
        </p>
      )}
      <p className="mono">
        Score profile snapshot provenance: {summary.scoreProfileSnapshotProvenance}
      </p>
      <section className="panel result-engine-panel">
        <div className="panel-heading">
          <div>
            <span className="section-index mono">ENGINE</span>
            <h2>채점 엔진 검증</h2>
          </div>
          <span className="count-label mono">
            {scoringEngine.currentVerified ? 'CURRENT · VERIFIED' : 'NON-OFFICIAL'}
          </span>
        </div>
        <p>
          <strong>{scoringEngine.title ?? '검증 가능한 엔진 제목 없음'}</strong>
          {' · '}
          <span className="mono">{scoringEngine.version ?? '버전 기록 없음'}</span>
        </p>
        <p className="mono">
          provenance {scoringEngine.snapshotProvenance}
          {' · '}
          SHA-256 {scoringEngine.contentHash ?? '기록 없음'}
          {' · '}
          snapshot verified {scoringEngine.verified ? 'true' : 'false'}
          {' · '}
          current verified {scoringEngine.currentVerified ? 'true' : 'false'}
        </p>
      </section>
      {!officialAnalysis && (
        <p className="result-warning">
          <strong>비공식 분석:</strong> 현재 코드와 일치하는 채점 엔진 및 검증된
          평가 프로필을 확인할 수 없어 아래 차트를 공식 근거로 사용할 수 없습니다.
          공식 PDF 내보내기와 동일한 검증 기준을 적용합니다.
        </p>
      )}
      <section className="metric-grid">
        <div className="metric-card metric-feature">
          <div className="metric-label">응답 완료</div>
          <div className="metric-value mono">
            {visibleResponses}
            <small> / {visibleTotalItems}</small>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">실패 항목</div>
          <div className="metric-value mono">{visibleFailedItems}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">비교 시계열</div>
          <div className="metric-value mono">{visibleModels.length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">실행 상태</div>
          <div className="metric-value mono">{summary.state}</div>
        </div>
      </section>
      <section
        aria-label={officialAnalysis
          ? '공식 벤치마크 분석 차트'
          : '비공식 벤치마크 분석 차트'}
        data-official={officialAnalysis ? 'true' : 'false'}
      >
        <ResultAnalyticsDashboard
          analytics={details.analytics}
          selectedModes={selectedModes}
          onSelectedModesChange={setSelectedModes}
          runId={runId}
          snapshotVersion={details.eventCursor}
        />
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-index mono">01</span>
            <h2>모델별 실제 집계</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>블라인드</th>
                <th>모델</th>
                <th>실행 커버리지</th>
                <th className="numeric">응답</th>
                <th>대표 실패 원인</th>
                <th className="numeric">평균 지연</th>
                <th className="numeric">입력 토큰</th>
                <th className="numeric">출력 토큰</th>
                <th className="numeric">비용(KRW)</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((model) => {
                const totalItems = Number(model.totalItems);
                const failedItems = Number(model.failedItems);
                const allFailedWithoutResponse = totalItems > 0
                  && failedItems === totalItems
                  && Number(model.responses) === 0;
                return (
                <tr key={`${model.blindId}-${model.retrievalMode}`}>
                  <td className="mono">
                    <strong>{model.blindId}</strong>
                    <br />
                    <small>{retrievalLabel(model.retrievalMode)}</small>
                  </td>
                  <td>
                    {model.displayName}
                    <br />
                    <small className="mono">{model.modelId}</small>
                  </td>
                  <td>
                    <strong className="mono">
                      성공 {model.succeededItems} / 전체 {model.totalItems}
                    </strong>
                    <br />
                    <small className="mono">실패 {model.failedItems}</small>
                    {allFailedWithoutResponse && (
                      <>
                        <br />
                        <small className="state-label state-FAILED">
                          응답 0 · 전체 실패
                        </small>
                      </>
                    )}
                  </td>
                  <td className="numeric mono">{model.responses}</td>
                  <td>
                    {model.representativeFailure ? (
                      <>
                        <strong className="mono">
                          {model.representativeFailure.code}
                          {' · '}
                          {model.representativeFailure.count}건
                        </strong>
                        <br />
                        <small>{model.representativeFailure.message}</small>
                      </>
                    ) : '—'}
                  </td>
                  <td className="numeric mono">
                    {model.latency == null
                      ? '—'
                      : `${Math.round(Number(model.latency))} ms`}
                  </td>
                  <td className="numeric mono">{model.inputTokens ?? '—'}</td>
                  <td className="numeric mono">{model.outputTokens ?? '—'}</td>
                  <td className="numeric mono">
                    {model.costKrw == null
                      ? '—'
                      : Number(model.costKrw).toLocaleString('ko-KR')}
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <span className="section-index mono">02</span>
            <h2>채점 지표별 평균</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>블라인드 모델</th>
                <th>지표</th>
                <th className="numeric">표본</th>
                <th className="numeric">평균</th>
              </tr>
            </thead>
            <tbody>
              {visibleMetrics.filter(
                (row) => row.metricKey !== 'exact_match',
              ).map((row) => (
                <tr key={`${row.blindId}-${row.retrievalMode}-${row.metricKey}`}>
                  <td className="mono">{row.blindId} · {retrievalLabel(row.retrievalMode)}</td>
                  <td>{resultMetricLabels[row.metricKey] ?? row.metricKey}</td>
                  <td className="numeric mono">{row.sampleCount}</td>
                  <td className="numeric mono">
                    {row.score == null
                      ? '—'
                      : `${(Number(row.score) * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <span className="section-index mono">03</span>
            <h2>역량별 정확성</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>역량</th>
                <th>블라인드 모델</th>
                <th className="numeric">표본</th>
                <th className="numeric">점수</th>
              </tr>
            </thead>
            <tbody>
              {visibleCapabilities.map((row) => (
                <tr key={`${row.purpose}-${row.blindId}-${row.retrievalMode}`}>
                  <td>{row.purpose}</td>
                  <td className="mono">{row.blindId} · {retrievalLabel(row.retrievalMode)}</td>
                  <td className="numeric mono">{row.sampleCount}</td>
                  <td className="numeric mono">
                    {row.score == null
                      ? '—'
                      : `${(Number(row.score) * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
