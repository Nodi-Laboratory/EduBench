'use client';

import { useState } from 'react';
import { BadgeDollarSign, FileSliders, ServerCog } from 'lucide-react';
import { ScoreProfileAudit, type ScoreProfileAuditData } from '@/components/settings/score-profile-audit';
import {
  ResearchSettingsWorkspace,
  type ResearchConfigProfilesData,
} from '@/components/settings/research-settings-workspace';

type Provider = { provider_key: string; display_name: string; protocol: string; configured: boolean; envNames: string[] };
type Price = { version: string; provider_key: string; model_pattern: string; currency: string; input_per_million: string; output_per_million: string };

export function SettingsWorkspace({ providers, scores, prices, mockMode, researchProfiles }: { providers: Provider[]; scores: ScoreProfileAuditData[]; prices: Price[]; mockMode: boolean; researchProfiles?: ResearchConfigProfilesData }) {
  const [notice, setNotice] = useState('');
  const [scoreJudgeProvider, setScoreJudgeProvider] = useState('gemini');

  async function save(body: Record<string, unknown>) {
    const response = await fetch('/api/settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    setNotice(response.ok ? '프로필을 저장했습니다. 새 실행부터 적용할 수 있습니다.' : result.message ?? '저장하지 못했습니다.');
    if (response.ok) location.reload();
  }

  return <div className="workflow-page">
    <header className="page-heading"><div><span className="eyebrow">SYSTEM / CONFIGURATION</span><h1>시스템 설정</h1><p>비밀값은 화면에 저장하지 않고 .env에서만 읽으며, 실행 재현용 버전 프로필만 관리합니다.</p></div></header>
    {notice && <p className="inline-notice">{notice}</p>}
    <section className="panel settings-section">
      <div className="panel-heading"><div><ServerCog size={16}/><h2>모델 제공자 환경</h2></div><span className="count-label">연결 확인 기능 없음</span></div>
      <div className="provider-status-grid">{providers.map((provider) => <div key={provider.provider_key}><span className={`status-dot ${provider.configured ? '' : 'idle'}`}/><div><strong>{provider.display_name}</strong><small className="mono">{provider.protocol}</small></div><b>{mockMode ? 'MOCK 명시됨' : provider.configured ? '환경변수 설정됨' : provider.envNames.join(' · ')}</b></div>)}</div>
    </section>
    <ResearchSettingsWorkspace initialProfiles={researchProfiles}/>
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-heading"><div><FileSliders size={16}/><h2>채점 프로필 연구 감사</h2></div><span className="count-label">정의 · 루브릭 · 실행 추적</span></div>
        <form className="dense-form" action={(form) => save({
          kind: 'score', version: form.get('version'), title: form.get('title'),
          metrics: String(form.get('metrics')).split(',').map((value) => value.trim()).filter(Boolean),
          weights: (() => {
            try { return JSON.parse(String(form.get('weights') || '{}')); }
            catch { return { __invalid_json__: -1 }; }
          })(),
          rubricPrompt: form.get('rubricPrompt'), judgeProvider: form.get('judgeProvider'), judgeModel: form.get('judgeModel'),
        })}>
          <div className="form-row"><label>버전<input name="version" placeholder="score-v2" required/></label><label>제목<input name="title" placeholder="교육 적합성 프로필" required/></label></div>
          <label>지표 키 (쉼표 구분)<input name="metrics" defaultValue="accuracy,faithfulness,completeness,curriculum_alignment,student_fit,misconception,hallucination" required/></label>
          <label>지표 가중치 (JSON 객체)<input className="mono" name="weights" defaultValue={'{"response_present":0}'}/><small>생략한 지표는 1, 응답 존재 지표는 기본 0입니다. 0은 종합점수에서 제외합니다.</small></label>
          <div className="form-row"><label>심사 제공자<select name="judgeProvider" value={scoreJudgeProvider} onChange={(event) => setScoreJudgeProvider(event.target.value)}><option value="">결정론적 지표만</option>{providers.map((provider) => <option key={provider.provider_key} value={provider.provider_key}>{provider.display_name}</option>)}</select></label><label>정확한 심사 모델<input name="judgeModel" placeholder="예: gemini-2.5-pro" required={Boolean(scoreJudgeProvider)}/><small>.env 기본값이 아닌 이 모델 ID가 실행에 고정됩니다.</small></label></div>
          <label>루브릭 프롬프트<textarea name="rubricPrompt" placeholder="블라인드 절대평가 기준"/></label>
          <button className="button primary">채점 프로필 추가</button>
        </form>
        <div className="score-profile-list">{scores.map((score) => <ScoreProfileAudit key={score.version} profile={score}/>)}</div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><BadgeDollarSign size={16}/><h2>가격 프로필</h2></div></div>
        <form className="dense-form" action={(form) => save({ kind:'price', version:form.get('version'), providerKey:form.get('providerKey'), modelPattern:form.get('modelPattern'), currency:form.get('currency'), inputPerMillion:Number(form.get('input')), outputPerMillion:Number(form.get('output')), krwExchangeRate:Number(form.get('exchange')) || undefined })}>
          <div className="form-row"><label>버전<input name="version" placeholder="price-2026-07" required/></label><label>제공자<select name="providerKey">{providers.map((provider) => <option key={provider.provider_key} value={provider.provider_key}>{provider.display_name}</option>)}</select></label></div>
          <label>모델 SQL 패턴<input name="modelPattern" defaultValue="%" required/></label>
          <div className="form-row"><label>통화<input name="currency" defaultValue="USD" maxLength={3} required/></label><label>KRW 환율<input name="exchange" type="number" step="0.01"/></label></div>
          <div className="form-row"><label>입력 / 1M 토큰<input name="input" type="number" min="0" step="0.000001" required/></label><label>출력 / 1M 토큰<input name="output" type="number" min="0" step="0.000001" required/></label></div>
          <button className="button primary">가격 프로필 추가</button>
        </form>
        <div className="compact-list">{prices.map((price) => <div key={`${price.version}-${price.provider_key}-${price.model_pattern}`}><strong className="mono">{price.version}</strong><span>{price.provider_key} · {price.model_pattern}</span><small>{price.currency} {price.input_per_million} / {price.output_per_million}</small></div>)}</div>
      </section>
    </div>
  </div>;
}
