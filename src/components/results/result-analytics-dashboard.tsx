'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis,
  Radar, RadarChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import {
  benchmarkRetrievalModeMetadata,
  type BenchmarkRetrievalMode,
} from '@/domain/benchmark-retrieval';
import type {
  ResultAnalytics,
  ResultQuestionHeatmapPage,
} from '@/server/results/analytics';

const modelColors = ['#1f6feb', '#e8590c', '#2b8a3e', '#7c3aed', '#c2255c', '#087f5b'];
const distributionLabels = ['0–20', '20–40', '40–60', '60–80', '80–100'];

function percent(value: number | null | undefined): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function tooltipPercent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : 'N/A';
}

function ChartEmpty({ children = '분석 가능한 점수가 없습니다.' }: { children?: string }) {
  return <div className="analytics-empty">{children}</div>;
}

function seriesLabel(model: ResultAnalytics['models'][number]): string {
  const mode = model.retrievalMode;
  return mode && mode !== 'LEGACY_EVIDENCE'
    ? `${model.blindId} · ${benchmarkRetrievalModeMetadata[mode].shortLabel}`
    : model.blindId;
}

function rankingTestId(model: ResultAnalytics['models'][number]): string {
  return `ranking-${model.blindId}${
    model.retrievalMode && model.retrievalMode !== 'LEGACY_EVIDENCE'
      ? `-${model.retrievalMode}`
      : ''
  }`;
}

export function ResultAnalyticsDashboard({
  analytics,
  selectedModes:controlledSelectedModes,
  onSelectedModesChange,
  runId,
  snapshotVersion,
}: {
  analytics:ResultAnalytics;
  selectedModes?:BenchmarkRetrievalMode[];
  onSelectedModesChange?:(modes:BenchmarkRetrievalMode[]) => void;
  runId?:string;
  snapshotVersion?:string;
}) {
  const availableModes = analytics.retrievalModes ?? [];
  const [internalSelectedModes, setInternalSelectedModes] = useState<
    BenchmarkRetrievalMode[]
  >(
    () => [...availableModes],
  );
  const selectedModes = controlledSelectedModes ?? internalSelectedModes;
  const setSelectedModes = (
    update:(current:BenchmarkRetrievalMode[]) => BenchmarkRetrievalMode[],
  ) => {
    const next = update(selectedModes);
    setHeatmapPage(1);
    if (onSelectedModesChange) onSelectedModesChange(next);
    else setInternalSelectedModes(next);
  };
  const purposeOptions = analytics.purposeOptions ?? [];
  const purposeViews = analytics.purposeViews ?? {};
  const [selectedPurpose, setSelectedPurpose] = useState('');
  const activePurpose = selectedPurpose && purposeViews[selectedPurpose]
    ? selectedPurpose
    : '';
  const activeAnalytics = activePurpose ? purposeViews[activePurpose]! : analytics;
  const modelCatalog = useMemo(
    () => [...new Map(
      [...analytics.models]
        .sort((a, b) => a.blindId.localeCompare(
          b.blindId,
          undefined,
          { numeric:true },
        ))
        .map((model) => [model.blindId, model]),
    ).values()],
    [analytics.models],
  );
  const [selectedModels, setSelectedModels] = useState(
    () => modelCatalog.map((model) => model.blindId),
  );
  const [heatmapPage, setHeatmapPage] = useState(1);
  const [heatmap, setHeatmap] = useState<ResultQuestionHeatmapPage | null>(null);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const updateSelectedModels = (
    update:(current:string[]) => string[],
  ) => {
    setHeatmapPage(1);
    setSelectedModels(update);
  };
  const updateSelectedPurpose = (purpose:string) => {
    setHeatmapPage(1);
    setSelectedPurpose(purpose);
  };
  const [selectedMetric, setSelectedMetric] = useState(() => activeAnalytics.metricRows.find((row) => row.metricKey === 'accuracy')?.metricKey ?? activeAnalytics.metricRows[0]?.metricKey ?? '');
  const activeMetric = activeAnalytics.metricRows.some((row) => row.metricKey === selectedMetric)
    ? selectedMetric
    : activeAnalytics.metricRows.find((row) => row.metricKey === 'accuracy')?.metricKey
      ?? activeAnalytics.metricRows[0]?.metricKey
      ?? '';
  const visibleModels = activeAnalytics.models.filter((model) => (
    selectedModels.includes(model.blindId)
    && (
      !availableModes.length
      || (
        model.retrievalMode !== undefined
        && model.retrievalMode !== 'LEGACY_EVIDENCE'
        && selectedModes.includes(model.retrievalMode)
      )
    )
  ));
  const selectedMetricRow = activeAnalytics.metricRows.find((row) => row.metricKey === activeMetric);
  const colorBySeries = useMemo(() => Object.fromEntries(
    [...analytics.models]
      .sort((left, right) => (
        left.blindId.localeCompare(
          right.blindId,
          undefined,
          { numeric:true },
        )
        || String(left.retrievalMode).localeCompare(
          String(right.retrievalMode),
        )
      ))
      .map((model, index) => [
      model.seriesKey,
      modelColors[index % modelColors.length]!,
      ]),
  ), [analytics.models]);
  const compositeData = visibleModels.map((model) => ({
    model:seriesLabel(model),
    score:model.compositeScore == null ? null : model.compositeScore * 100,
    samples:model.scoreCount,
  }));
  const radarData = activeAnalytics.metricRows.filter((row) => row.metricKey !== 'response_present').map((row) => ({
    metric:row.label,
    ...Object.fromEntries(visibleModels.map((model) => [model.seriesKey, row.scores[model.seriesKey] == null ? null : row.scores[model.seriesKey] * 100])),
  }));
  const metricDetailData = visibleModels.map((model) => ({
    model:seriesLabel(model),
    score:selectedMetricRow?.scores[model.seriesKey] == null ? null : selectedMetricRow.scores[model.seriesKey] * 100,
    samples:selectedMetricRow?.counts[model.seriesKey] ?? 0,
  }));
  const prerequisiteData = activeAnalytics.prerequisiteRows.map((row) => ({
    metric:row.label,
    ...Object.fromEntries(visibleModels.map((model) => [model.seriesKey, row.scores[model.seriesKey] == null ? null : row.scores[model.seriesKey] * 100])),
  }));
  const purposeData = activeAnalytics.purposeRows.map((row) => ({
    purpose:row.purpose,
    ...Object.fromEntries(visibleModels.map((model) => [model.seriesKey, row.scores[model.seriesKey] == null ? null : row.scores[model.seriesKey] * 100])),
  }));
  const distributionData = visibleModels.map((model) => {
    const bins = activeAnalytics.distributions.find((row) => row.blindId === model.seriesKey)?.bins ?? [0, 0, 0, 0, 0];
    return { model:seriesLabel(model), ...Object.fromEntries(distributionLabels.map((label, index) => [label, bins[index]])) };
  });

  useEffect(() => {
    if (!runId) {
      return undefined;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      page:String(heatmapPage),
      pageSize:'25',
    });
    if (activePurpose) params.set('purpose', activePurpose);
    if (availableModes.length && selectedModes.length !== availableModes.length) {
      params.set('modes', selectedModes.join(','));
    }
    if (selectedModels.length !== modelCatalog.length) {
      params.set('models', selectedModels.join(','));
    }
    void (async () => {
      try {
        const response = await fetch(`/api/results/${runId}/heatmap?${params.toString()}`, {
          cache:'no-store',
          signal:controller.signal,
        });
        if (!response.ok) throw new Error(`RESULT_HEATMAP_HTTP_${response.status}`);
        const next = await response.json() as ResultQuestionHeatmapPage;
        if (!Array.isArray(next.rows) || !Number.isFinite(next.total)) {
          throw new Error('RESULT_HEATMAP_INVALID_RESPONSE');
        }
        if (!controller.signal.aborted) {
          setHeatmap(next);
          setHeatmapError(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setHeatmapError('문항별 점수를 불러오지 못했습니다. 마지막으로 확인된 페이지를 유지합니다.');
        }
      }
    })();
    return () => controller.abort();
  }, [
    activePurpose,
    availableModes.length,
    heatmapPage,
    modelCatalog.length,
    runId,
    selectedModels,
    selectedModes,
    snapshotVersion,
  ]);
  const visibleHeatmap = runId ? heatmap : null;

  if (!modelCatalog.length) return <section className="panel analytics-dashboard"><ChartEmpty>저장된 모델 응답이 없어 시각화할 수 없습니다.</ChartEmpty></section>;

  return <section className="analytics-dashboard" aria-label="벤치마크 결과 시각화">
    <div className="analytics-toolbar panel">
      <div><span className="section-index mono">VISUAL</span><h2>통합 분석 대시보드</h2><p aria-live="polite">{activePurpose ? `${activePurpose} 목적 문항만 표시합니다. ` : '전체 질문 목적을 표시합니다. '}목적을 선택하면 실행 전체 통계가 아니라 해당 목적 문항만 다시 집계합니다. 실제 저장 점수만 사용하며 결측치는 0점으로 계산하지 않습니다.</p></div>
      <div className="analytics-filters">
        {availableModes.length > 0 && <div className="analytics-mode-buttons" role="group" aria-label="검색 조건 비교">
          {availableModes.map((mode) => {
            const metadata = benchmarkRetrievalModeMetadata[mode];
            const active = selectedModes.includes(mode);
            return <button
              type="button"
              key={mode}
              aria-label={`${metadata.shortLabel} 결과 표시`}
              aria-pressed={active}
              onClick={() => setSelectedModes((current) => (
                current.includes(mode)
                  ? current.length > 1
                    ? current.filter((candidate) => candidate !== mode)
                    : current
                  : availableModes.filter((candidate) => (
                    current.includes(candidate) || candidate === mode
                  ))
              ))}
            >{metadata.shortLabel}</button>;
          })}
        </div>}
        <fieldset><legend>비교 모델</legend>{modelCatalog.map((model) => <label key={model.blindId} style={{ '--model-color':colorBySeries[model.seriesKey] } as React.CSSProperties}><input aria-label={`${model.blindId} 모델 표시`} type="checkbox" checked={selectedModels.includes(model.blindId)} onChange={(event) => updateSelectedModels((current) => event.target.checked ? [...current, model.blindId] : current.filter((id) => id !== model.blindId))}/><span/>{model.blindId} · {model.displayName}</label>)}</fieldset>
        <label>질문 목적<select aria-label="질문 목적" value={activePurpose} onChange={(event) => updateSelectedPurpose(event.target.value)}><option value="">전체 질문 목적</option>{purposeOptions.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}</select></label>
        <label>상세 지표<select aria-label="상세 평가 지표" value={activeMetric} onChange={(event) => setSelectedMetric(event.target.value)}>{activeAnalytics.metricRows.map((row) => <option key={row.metricKey} value={row.metricKey}>{row.label}</option>)}</select></label>
      </div>
    </div>

    {!visibleModels.length ? <div className="panel"><ChartEmpty>표시할 모델을 하나 이상 선택하세요.</ChartEmpty></div> : <>
      <section className="panel analytics-section">
        <div className="panel-heading"><div><span className="section-index mono">01</span><h2>종합 성능 비교</h2></div><span className="count-label mono">{visibleModels.length} SERIES</span></div>
        <div className="analytics-ranking">{visibleModels.map((model, index) => <article key={model.seriesKey} data-testid={rankingTestId(model)} style={{ '--model-color':colorBySeries[model.seriesKey] } as React.CSSProperties}><span className="analytics-rank mono">#{index + 1}</span><div><strong>{seriesLabel(model)} · {model.displayName}</strong><small className="mono">{model.modelId}</small></div><b>{percent(model.compositeScore)}</b><dl><div><dt>표본 점수</dt><dd>{model.scoreCount}</dd></div><div><dt>평균 지연</dt><dd>{model.avgLatencyMs == null ? '—' : `${Math.round(model.avgLatencyMs)} ms`}</dd></div><div><dt>비용</dt><dd>{model.costKrw == null ? '—' : `${model.costKrw.toLocaleString('ko-KR')}원`}</dd></div></dl></article>)}</div>
        <div className="analytics-chart chart-wide"><h3>모델별 종합점수</h3><ResponsiveContainer width="100%" height={300}><BarChart data={compositeData} margin={{ top:16, right:20, left:0, bottom:8 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="model"/><YAxis domain={[0,100]} unit="%"/><Tooltip formatter={tooltipPercent}/><Bar dataKey="score" name="종합점수" fill="#1f6feb" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></div>
      </section>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>평가 지표 레이더</h2>{radarData.length ? <ResponsiveContainer width="100%" height={390}><RadarChart data={radarData} outerRadius="68%"><PolarGrid/><PolarAngleAxis dataKey="metric" tick={{ fontSize:11 }}/><PolarRadiusAxis domain={[0,100]} tick={{ fontSize:10 }}/>{visibleModels.map((model) => <Radar key={model.seriesKey} name={seriesLabel(model)} dataKey={model.seriesKey} stroke={colorBySeries[model.seriesKey]} fill={colorBySeries[model.seriesKey]} fillOpacity={0.12}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></RadarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
        <section className="panel analytics-chart"><h2>평가 지표별 비교</h2><p>{selectedMetricRow?.label ?? '지표를 선택하세요.'}</p>{selectedMetricRow ? <ResponsiveContainer width="100%" height={350}><BarChart data={metricDetailData} layout="vertical" margin={{ left:12, right:24 }}><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number" domain={[0,100]} unit="%"/><YAxis type="category" dataKey="model" width={48}/><Tooltip formatter={tooltipPercent}/><Bar dataKey="score" name={selectedMetricRow.label} fill="#7c3aed" radius={[0,5,5,0]}/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>선수관계 역량</h2><p>선수 개념에서 목표 개념까지의 관계 이해와 적용 능력을 분리해 비교합니다.</p>{prerequisiteData.length ? <ResponsiveContainer width="100%" height={390}><RadarChart data={prerequisiteData} outerRadius="68%"><PolarGrid/><PolarAngleAxis dataKey="metric" tick={{ fontSize:10 }}/><PolarRadiusAxis domain={[0,100]} tick={{ fontSize:10 }}/>{visibleModels.map((model) => <Radar key={model.seriesKey} name={seriesLabel(model)} dataKey={model.seriesKey} stroke={colorBySeries[model.seriesKey]} fill={colorBySeries[model.seriesKey]} fillOpacity={0.12}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></RadarChart></ResponsiveContainer> : <ChartEmpty>선수관계 전용 평가 지표가 없습니다.</ChartEmpty>}</section>
        <section className="panel analytics-chart"><h2>질문 목적별 성능</h2>{purposeData.length ? <ResponsiveContainer width="100%" height={390}><BarChart data={purposeData} margin={{ top:16, right:12, left:0, bottom:48 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="purpose" angle={-20} textAnchor="end" interval={0} height={70} tick={{ fontSize:10 }}/><YAxis domain={[0,100]} unit="%"/>{visibleModels.map((model) => <Bar key={model.seriesKey} dataKey={model.seriesKey} name={seriesLabel(model)} fill={colorBySeries[model.seriesKey]}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>성능·효율</h2><p>왼쪽 위에 가까울수록 빠르면서 종합점수가 높습니다.</p><ResponsiveContainer width="100%" height={350}><ScatterChart margin={{ top:20, right:24, bottom:18, left:4 }}><CartesianGrid strokeDasharray="3 3"/><XAxis type="number" dataKey="latency" name="평균 지연" unit="ms"/><YAxis type="number" dataKey="score" name="종합점수" domain={[0,100]} unit="%"/><ZAxis type="number" dataKey="responses" range={[90,360]} name="응답 수"/><Tooltip cursor={{ strokeDasharray:'3 3' }}/><Legend/>{visibleModels.map((model) => <Scatter key={model.seriesKey} name={seriesLabel(model)} fill={colorBySeries[model.seriesKey]} data={[{ latency:model.avgLatencyMs, score:model.compositeScore == null ? null : model.compositeScore * 100, responses:model.responses, cost:model.costKrw }]}/>)}</ScatterChart></ResponsiveContainer></section>
        <section className="panel analytics-chart"><h2>점수 분포</h2><p>정확성 점수를 20점 간격으로 구분한 문항 수입니다.</p><ResponsiveContainer width="100%" height={350}><BarChart data={distributionData}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="model"/><YAxis allowDecimals={false}/><Tooltip/><Legend/>{distributionLabels.map((label, index) => <Bar key={label} dataKey={label} stackId="scores" fill={['#dbeafe','#93c5fd','#60a5fa','#2563eb','#1e3a8a'][index]}/>)}</BarChart></ResponsiveContainer></section>
      </div>

      <section className="panel analytics-section"><div className="panel-heading"><div><span className="section-index mono">08</span><h2>문항별 히트맵</h2></div><span className="count-label mono">ACCURACY · {visibleHeatmap?.total ?? 0} ITEMS</span></div>{heatmapError ? <ChartEmpty>{heatmapError}</ChartEmpty> : visibleHeatmap?.rows.length ? <><div className="analytics-heatmap-wrap"><table className="analytics-heatmap"><thead><tr><th>문항</th><th>목적</th>{visibleModels.map((model) => <th key={model.seriesKey}>{seriesLabel(model)}</th>)}</tr></thead><tbody>{visibleHeatmap.rows.map((question) => <tr key={question.questionId}><th title={question.questionText}><span className="mono">{question.publicId}</span><small>{question.questionText}</small></th><td>{question.purpose}</td>{visibleModels.map((model) => { const score=question.scores[model.seriesKey]; return <td key={model.seriesKey} style={score == null ? undefined : { backgroundColor:`rgba(31, 111, 235, ${0.08 + score * 0.82})`, color:score >= 0.58 ? '#fff' : '#172033' }}>{percent(score)}</td>; })}</tr>)}</tbody></table></div><div className="analytics-pagination"><span className="mono">{visibleHeatmap.total}개 중 {(visibleHeatmap.page - 1) * visibleHeatmap.pageSize + 1}–{Math.min(visibleHeatmap.total, visibleHeatmap.page * visibleHeatmap.pageSize)}</span><button type="button" onClick={() => setHeatmapPage((current) => Math.max(1, current - 1))} disabled={visibleHeatmap.page <= 1}>이전</button><button type="button" onClick={() => setHeatmapPage((current) => current + 1)} disabled={visibleHeatmap.page * visibleHeatmap.pageSize >= visibleHeatmap.total}>다음</button></div></> : <ChartEmpty>{runId ? '문항별 점수를 불러오는 중입니다.' : '문항별 점수를 표시할 실행을 선택하세요.'}</ChartEmpty>}</section>
    </>}
  </section>;
}
