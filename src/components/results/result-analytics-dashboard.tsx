'use client';

import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis,
  Radar, RadarChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import type { ResultAnalytics } from '@/server/results/analytics';

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

export function ResultAnalyticsDashboard({ analytics }: { analytics: ResultAnalytics }) {
  const [selectedModels, setSelectedModels] = useState(() => analytics.models.map((model) => model.blindId));
  const [selectedMetric, setSelectedMetric] = useState(() => analytics.metricRows.find((row) => row.metricKey === 'accuracy')?.metricKey ?? analytics.metricRows[0]?.metricKey ?? '');
  const activeMetric = analytics.metricRows.some((row) => row.metricKey === selectedMetric)
    ? selectedMetric
    : analytics.metricRows.find((row) => row.metricKey === 'accuracy')?.metricKey
      ?? analytics.metricRows[0]?.metricKey
      ?? '';
  const visibleModels = analytics.models.filter((model) => selectedModels.includes(model.blindId));
  const selectedMetricRow = analytics.metricRows.find((row) => row.metricKey === activeMetric);
  const colorByModel = useMemo(() => Object.fromEntries(analytics.models.map((model, index) => [model.blindId, modelColors[index % modelColors.length]!])), [analytics.models]);
  const compositeData = visibleModels.map((model) => ({
    model:model.blindId,
    score:model.compositeScore == null ? null : model.compositeScore * 100,
    samples:model.scoreCount,
  }));
  const radarData = analytics.metricRows.filter((row) => row.metricKey !== 'response_present').map((row) => ({
    metric:row.label,
    ...Object.fromEntries(visibleModels.map((model) => [model.blindId, row.scores[model.blindId] == null ? null : row.scores[model.blindId] * 100])),
  }));
  const metricDetailData = visibleModels.map((model) => ({
    model:model.blindId,
    score:selectedMetricRow?.scores[model.blindId] == null ? null : selectedMetricRow.scores[model.blindId] * 100,
    samples:selectedMetricRow?.counts[model.blindId] ?? 0,
  }));
  const prerequisiteData = analytics.prerequisiteRows.map((row) => ({
    metric:row.label,
    ...Object.fromEntries(visibleModels.map((model) => [model.blindId, row.scores[model.blindId] == null ? null : row.scores[model.blindId] * 100])),
  }));
  const purposeData = analytics.purposeRows.map((row) => ({
    purpose:row.purpose,
    ...Object.fromEntries(visibleModels.map((model) => [model.blindId, row.scores[model.blindId] == null ? null : row.scores[model.blindId] * 100])),
  }));
  const distributionData = visibleModels.map((model) => {
    const bins = analytics.distributions.find((row) => row.blindId === model.blindId)?.bins ?? [0, 0, 0, 0, 0];
    return { model:model.blindId, ...Object.fromEntries(distributionLabels.map((label, index) => [label, bins[index]])) };
  });

  if (!analytics.models.length) return <section className="panel analytics-dashboard"><ChartEmpty>저장된 모델 응답이 없어 시각화할 수 없습니다.</ChartEmpty></section>;

  return <section className="analytics-dashboard" aria-label="벤치마크 결과 시각화">
    <div className="analytics-toolbar panel">
      <div><span className="section-index mono">VISUAL</span><h2>통합 분석 대시보드</h2><p>실제 저장 점수만 사용하며 결측치는 0점으로 계산하지 않습니다.</p></div>
      <div className="analytics-filters">
        <fieldset><legend>비교 모델</legend>{analytics.models.map((model) => <label key={model.blindId} style={{ '--model-color':colorByModel[model.blindId] } as React.CSSProperties}><input aria-label={`${model.blindId} 모델 표시`} type="checkbox" checked={selectedModels.includes(model.blindId)} onChange={(event) => setSelectedModels((current) => event.target.checked ? [...current, model.blindId] : current.filter((id) => id !== model.blindId))}/><span/>{model.blindId} · {model.displayName}</label>)}</fieldset>
        <label>상세 지표<select aria-label="상세 평가 지표" value={activeMetric} onChange={(event) => setSelectedMetric(event.target.value)}>{analytics.metricRows.map((row) => <option key={row.metricKey} value={row.metricKey}>{row.label}</option>)}</select></label>
      </div>
    </div>

    {!visibleModels.length ? <div className="panel"><ChartEmpty>표시할 모델을 하나 이상 선택하세요.</ChartEmpty></div> : <>
      <section className="panel analytics-section">
        <div className="panel-heading"><div><span className="section-index mono">01</span><h2>종합 성능 비교</h2></div><span className="count-label mono">{visibleModels.length} MODELS</span></div>
        <div className="analytics-ranking">{visibleModels.map((model, index) => <article key={model.blindId} data-testid={`ranking-${model.blindId}`} style={{ '--model-color':colorByModel[model.blindId] } as React.CSSProperties}><span className="analytics-rank mono">#{index + 1}</span><div><strong>{model.blindId} · {model.displayName}</strong><small className="mono">{model.modelId}</small></div><b>{percent(model.compositeScore)}</b><dl><div><dt>표본 점수</dt><dd>{model.scoreCount}</dd></div><div><dt>평균 지연</dt><dd>{model.avgLatencyMs == null ? '—' : `${Math.round(model.avgLatencyMs)} ms`}</dd></div><div><dt>비용</dt><dd>{model.costKrw == null ? '—' : `${model.costKrw.toLocaleString('ko-KR')}원`}</dd></div></dl></article>)}</div>
        <div className="analytics-chart chart-wide"><h3>모델별 종합점수</h3><ResponsiveContainer width="100%" height={300}><BarChart data={compositeData} margin={{ top:16, right:20, left:0, bottom:8 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="model"/><YAxis domain={[0,100]} unit="%"/><Tooltip formatter={tooltipPercent}/><Bar dataKey="score" name="종합점수" fill="#1f6feb" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></div>
      </section>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>평가 지표 레이더</h2>{radarData.length ? <ResponsiveContainer width="100%" height={390}><RadarChart data={radarData} outerRadius="68%"><PolarGrid/><PolarAngleAxis dataKey="metric" tick={{ fontSize:11 }}/><PolarRadiusAxis domain={[0,100]} tick={{ fontSize:10 }}/>{visibleModels.map((model) => <Radar key={model.blindId} name={model.blindId} dataKey={model.blindId} stroke={colorByModel[model.blindId]} fill={colorByModel[model.blindId]} fillOpacity={0.12}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></RadarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
        <section className="panel analytics-chart"><h2>평가 지표별 비교</h2><p>{selectedMetricRow?.label ?? '지표를 선택하세요.'}</p>{selectedMetricRow ? <ResponsiveContainer width="100%" height={350}><BarChart data={metricDetailData} layout="vertical" margin={{ left:12, right:24 }}><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number" domain={[0,100]} unit="%"/><YAxis type="category" dataKey="model" width={48}/><Tooltip formatter={tooltipPercent}/><Bar dataKey="score" name={selectedMetricRow.label} fill="#7c3aed" radius={[0,5,5,0]}/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>선수관계 역량</h2><p>선수 개념에서 목표 개념까지의 관계 이해와 적용 능력을 분리해 비교합니다.</p>{prerequisiteData.length ? <ResponsiveContainer width="100%" height={390}><RadarChart data={prerequisiteData} outerRadius="68%"><PolarGrid/><PolarAngleAxis dataKey="metric" tick={{ fontSize:10 }}/><PolarRadiusAxis domain={[0,100]} tick={{ fontSize:10 }}/>{visibleModels.map((model) => <Radar key={model.blindId} name={model.blindId} dataKey={model.blindId} stroke={colorByModel[model.blindId]} fill={colorByModel[model.blindId]} fillOpacity={0.12}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></RadarChart></ResponsiveContainer> : <ChartEmpty>선수관계 전용 평가 지표가 없습니다.</ChartEmpty>}</section>
        <section className="panel analytics-chart"><h2>질문 목적별 성능</h2>{purposeData.length ? <ResponsiveContainer width="100%" height={390}><BarChart data={purposeData} margin={{ top:16, right:12, left:0, bottom:48 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="purpose" angle={-20} textAnchor="end" interval={0} height={70} tick={{ fontSize:10 }}/><YAxis domain={[0,100]} unit="%"/>{visibleModels.map((model) => <Bar key={model.blindId} dataKey={model.blindId} name={model.blindId} fill={colorByModel[model.blindId]}/>) }<Legend/><Tooltip formatter={tooltipPercent}/></BarChart></ResponsiveContainer> : <ChartEmpty/>}</section>
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-chart"><h2>성능·효율</h2><p>오른쪽 위에 가까울수록 빠르면서 종합점수가 높습니다.</p><ResponsiveContainer width="100%" height={350}><ScatterChart margin={{ top:20, right:24, bottom:18, left:4 }}><CartesianGrid strokeDasharray="3 3"/><XAxis type="number" dataKey="latency" name="평균 지연" unit="ms"/><YAxis type="number" dataKey="score" name="종합점수" domain={[0,100]} unit="%"/><ZAxis type="number" dataKey="responses" range={[90,360]} name="응답 수"/><Tooltip cursor={{ strokeDasharray:'3 3' }}/><Legend/>{visibleModels.map((model) => <Scatter key={model.blindId} name={model.blindId} fill={colorByModel[model.blindId]} data={[{ latency:model.avgLatencyMs, score:model.compositeScore == null ? null : model.compositeScore * 100, responses:model.responses, cost:model.costKrw }]}/>)}</ScatterChart></ResponsiveContainer></section>
        <section className="panel analytics-chart"><h2>점수 분포</h2><p>정확성 점수를 20점 간격으로 구분한 문항 수입니다.</p><ResponsiveContainer width="100%" height={350}><BarChart data={distributionData}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="model"/><YAxis allowDecimals={false}/><Tooltip/><Legend/>{distributionLabels.map((label, index) => <Bar key={label} dataKey={label} stackId="scores" fill={['#dbeafe','#93c5fd','#60a5fa','#2563eb','#1e3a8a'][index]}/>)}</BarChart></ResponsiveContainer></section>
      </div>

      <section className="panel analytics-section"><div className="panel-heading"><div><span className="section-index mono">08</span><h2>문항별 히트맵</h2></div><span className="count-label mono">ACCURACY</span></div>{analytics.questionRows.length ? <div className="analytics-heatmap-wrap"><table className="analytics-heatmap"><thead><tr><th>문항</th><th>목적</th>{visibleModels.map((model) => <th key={model.blindId}>{model.blindId}</th>)}</tr></thead><tbody>{analytics.questionRows.map((question) => <tr key={question.questionId}><th title={question.questionText}><span className="mono">{question.publicId}</span><small>{question.questionText}</small></th><td>{question.purpose}</td>{visibleModels.map((model) => { const score=question.scores[model.blindId]; return <td key={model.blindId} style={score == null ? undefined : { backgroundColor:`rgba(31, 111, 235, ${0.08 + score * 0.82})`, color:score >= 0.58 ? '#fff' : '#172033' }}>{percent(score)}</td>; })}</tr>)}</tbody></table></div> : <ChartEmpty/>}</section>
    </>}
  </section>;
}
