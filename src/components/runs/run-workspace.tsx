'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, PlayCircle, ServerCog } from 'lucide-react';

type Dataset = { id: string; version: string; title: string; question_count: number };
type Profile = { id: string; version: string; title: string };
type Provider = { provider_key: string; display_name: string; protocol: string; modelId: string; envName: string; requestIntervalMs: number };
type Run = { id: string; public_id: string; title: string; state: string; total_items: number; completed_items: number; failed_items: number; created_at: string };

export function RunWorkspace({ datasets, scoreProfiles, providers, initialRuns }: {
  datasets: Dataset[]; scoreProfiles: Profile[]; providers: Provider[]; initialRuns: Run[];
}) {
  const [selected, setSelected] = useState(() => providers.filter((provider) => provider.modelId).map((provider) => provider.provider_key));
  const [runs, setRuns] = useState(initialRuns);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(formData: FormData) {
    setSubmitting(true); setNotice('');
    const selectedProviders = providers.filter((provider) => selected.includes(provider.provider_key));
    const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: formData.get('title'), datasetVersionId: formData.get('datasetVersionId'), scoreProfileId: formData.get('scoreProfileId'),
      priceProfileVersion: String(formData.get('priceProfileVersion')), systemPrompt: formData.get('systemPrompt'),
      questionLimit: Number(formData.get('questionLimit')),
      models: selectedProviders.map((provider) => ({
        providerKey: provider.provider_key,
        displayName: provider.display_name,
        modelId: provider.modelId,
        protocol: provider.protocol,
        requestIntervalMs: provider.requestIntervalMs,
      })),
    }) });
    const body = await response.json();
    if (!response.ok) setNotice(body.message ?? '실행을 만들지 못했습니다. 입력값을 확인하세요.');
    else {
      setNotice(`${body.publicId} 초안을 만들었습니다. 상세 화면에서 실행을 시작하세요.`);
      setRuns((current) => [{ id: body.id, public_id: body.publicId, title: String(formData.get('title')), state: 'DRAFT', total_items: body.totalItems, completed_items: 0, failed_items: 0, created_at: new Date().toISOString() }, ...current]);
    }
    setSubmitting(false);
  }

  const seoulDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  return <div className="workflow-page">
    <header className="page-heading"><div><span className="eyebrow">BENCHMARK / EXECUTION</span><h1>벤치마크 실행</h1><p>불변 데이터셋과 환경변수의 실제 모델을 결합해 재현 가능한 실행을 생성합니다.</p></div></header>
    <div className="run-setup-grid">
      <section className="panel"><div className="panel-heading"><div><span className="section-index mono">01</span><h2>실행 명세</h2></div></div>
        <form className="dense-form" action={submit}>
          <label>실행 제목<input name="title" defaultValue={`공식 비교 실행 ${seoulDate}`} required /></label>
          <div className="form-row"><label>불변 데이터셋<select name="datasetVersionId" required>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.version} · {dataset.question_count}문항</option>)}</select></label><label>채점 프로필<select name="scoreProfileId" required>{scoreProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.version} · {profile.title}</option>)}</select></label></div>
          <div className="form-row"><label>가격 프로필 버전<input name="priceProfileVersion" defaultValue="manual-2026-07" required /></label><label>문항 수<input name="questionLimit" type="number" min="1" max="5000" defaultValue={datasets[0]?.question_count ?? 1} required /></label></div>
          <label>시스템 프롬프트<textarea name="systemPrompt" defaultValue="제공된 교과서 근거와 질문의 지시를 따르며, 근거가 부족하면 부족하다고 명시한다." required /></label>
          <button className="button primary" disabled={submitting || selected.length === 0}><PlayCircle size={15} /> {submitting ? '실행 명세 생성 중…' : '실행 초안 생성'}</button>
          {notice && <p className="inline-notice">{notice}</p>}
        </form>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="section-index mono">02</span><h2>모델 선택</h2></div><span className="count-label mono">{selected.length} SELECTED</span></div>
        <div className="provider-selector">{providers.map((provider, index) => <label key={provider.provider_key} className={!provider.modelId ? 'disabled-provider' : ''}><input type="checkbox" checked={selected.includes(provider.provider_key)} disabled={!provider.modelId} onChange={(event) => setSelected((current) => event.target.checked ? [...current, provider.provider_key] : current.filter((key) => key !== provider.provider_key))} /><span className={`model-key model-${index + 1}`} /><span><strong>{provider.display_name}</strong><small className="mono">{provider.modelId || `${provider.envName} 미설정`}</small></span><b>{provider.protocol}</b></label>)}</div>
        <div className="dataset-note"><ServerCog size={17} /><p>API 키와 모델 ID는 <strong>.env</strong>에서만 읽습니다. 별도의 연결 확인 단계는 두지 않습니다.</p></div>
      </section>
    </div>
    <section className="panel recent-panel"><div className="panel-heading"><div><span className="section-index mono">03</span><h2>실행 기록</h2></div><span className="count-label mono">{runs.length} RUNS</span></div>
      {runs.length === 0 ? <div className="table-empty"><Activity size={22} /><strong>아직 실행 기록이 없습니다.</strong><span>위 명세로 첫 실행을 생성하세요.</span></div> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>실행 ID</th><th>제목</th><th>상태</th><th className="numeric">진행</th><th className="numeric">실패</th><th>생성 시각</th><th /></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td className="mono">{run.public_id}</td><td><strong>{run.title}</strong></td><td><span className={`state-label state-${run.state}`}>{run.state}</span></td><td className="numeric mono">{run.completed_items} / {run.total_items}</td><td className="numeric mono">{run.failed_items}</td><td className="mono">{run.created_at.slice(0,16).replace('T',' ')}</td><td><Link className="icon-button" href={`/runs/${run.id}`} aria-label={`${run.public_id} 열기`}><ArrowRight size={14} /></Link></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
