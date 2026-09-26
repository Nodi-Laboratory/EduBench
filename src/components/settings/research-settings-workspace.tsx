'use client';

import { useState } from 'react';
import { FileSliders } from 'lucide-react';
import type {
  ResearchConfigDefinition,
  ResearchConfigKind,
} from '@/domain/research-config';
import { JsonBlock } from '@/components/ui/json-block';
import { StructuredResearchControls } from '@/components/settings/research-settings-controls';

export type ResearchConfigProfileView = {
  id: string;
  kind: ResearchConfigKind;
  version: string;
  title: string;
  definition: ResearchConfigDefinition;
  contentHash: string;
  createdAt: string;
  active: boolean;
};

export type ResearchConfigProfilesData = {
  items: ResearchConfigProfileView[];
  activeByKind: Partial<Record<ResearchConfigKind, string>>;
};

const emptyProfiles: ResearchConfigProfilesData = {
  items: [],
  activeByKind: {},
};

const kindCards: Array<{
  kind: ResearchConfigKind;
  label: string;
  eyebrow: string;
  purpose: string;
}> = [
  {
    kind: 'document_parse',
    label: 'Document Parse',
    eyebrow: 'INGESTION',
    purpose: '페이지 이미지의 해상도, OCR, 구조 추출 형식과 병렬 처리량을 결정합니다.',
  },
  {
    kind: 'embedding_rag',
    label: '임베딩 / RAG',
    eyebrow: 'EVIDENCE',
    purpose: '벡터 공간, 청크 크기와 검색 범위를 고정해 어떤 교과서 근거가 선택되는지 결정합니다.',
  },
  {
    kind: 'question_generation',
    label: '질문 생성',
    eyebrow: 'GENERATION',
    purpose: '문항별 방향 생성과 최종 질문 생성의 모델, 사고 수준, 출력 예산을 결정합니다.',
  },
  {
    kind: 'benchmark_models',
    label: '벤치마크 모델',
    eyebrow: 'EVALUATION',
    purpose: '비교 대상 모델과 모델별 생성 파라미터, 호출 속도 제한을 함께 고정합니다.',
  },
];

type Fact = { label: string; value: string };

function keyFacts(definition: ResearchConfigDefinition): Fact[] {
  if (definition.kind === 'document_parse') {
    const settings = definition.settings;
    return [
      { label: '모델', value: settings.model },
      { label: '인식', value: `${settings.mode} · OCR ${settings.ocr}` },
      { label: '출력', value: `${settings.outputFormat} · ${settings.base64Encoding.join(', ')}` },
      { label: '페이지 이미지', value: `${settings.rasterization.format.toUpperCase()} · ${settings.rasterization.dpi} DPI` },
      { label: '병렬 처리', value: `${settings.pagesPerBatch}쪽/배치 · 동시 ${settings.pageConcurrency}` },
    ];
  }
  if (definition.kind === 'embedding_rag') {
    const settings = definition.settings;
    return [
      { label: '임베딩', value: `${settings.model} · ${settings.dimensions}차원` },
      { label: '벡터 공간', value: settings.vectorSpaceId },
      { label: '청크 / 검색', value: `${settings.chunkTargetTokens} tokens · topK ${settings.retrievalTopK}` },
      { label: '인접 근거', value: `앞뒤 ${settings.neighborWindow}개 청크` },
      { label: '병렬 처리', value: `${settings.batchSize}개/배치 · 동시 ${settings.concurrency}` },
    ];
  }
  if (definition.kind === 'question_generation') {
    const settings = definition.settings;
    return [
      { label: '모델', value: settings.model },
      { label: '사고 수준', value: settings.thinkingLevel },
      { label: '방향 생성 한도', value: `${settings.directionMaxOutputTokens.toLocaleString()} tokens` },
      { label: '질문 생성 한도', value: `${settings.questionMaxOutputTokens.toLocaleString()} tokens` },
      { label: '출력 / 병렬', value: `${settings.responseMimeType} · 동시 ${settings.concurrency}` },
    ];
  }
  return definition.settings.models.map((model) => ({
    label: model.displayName,
    value: `${model.enabled ? '사용' : '중지'} · ${model.modelId} · 동시 ${model.concurrency}`,
  }));
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function initialEditor(
  kind: ResearchConfigKind,
  items: ResearchConfigProfileView[],
  activeByKind: ResearchConfigProfilesData['activeByKind'],
): string {
  const profiles = items.filter((item) => item.kind === kind);
  const source = profiles.find((item) => item.id === activeByKind[kind]) ?? profiles[0];
  if (source) return prettyJson(source.definition);
  return prettyJson({ schemaVersion: 1, kind });
}

function formatApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as {
    code?: unknown;
    message?: unknown;
    issues?: unknown;
  };
  if (Array.isArray(record.issues) && record.issues.length) {
    return record.issues.map((issue) => {
      if (!issue || typeof issue !== 'object') return String(issue);
      const typed = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(typed.path) ? typed.path.map(String).join('.') : '';
      const message = typeof typed.message === 'string' ? typed.message : '유효하지 않은 값입니다.';
      return path ? `${path}: ${message}` : message;
    }).join('\n');
  }
  if (typeof record.message === 'string') return record.message;
  if (typeof record.code === 'string') return record.code;
  return fallback;
}

function ResearchConfigCard({
  descriptor,
  profiles,
  activeProfileId,
  selectedProfileId,
  editorValue,
  busy,
  error,
  onSelect,
  onActivate,
  onEditorChange,
  onCreate,
}: {
  descriptor: (typeof kindCards)[number];
  profiles: ResearchConfigProfileView[];
  activeProfileId?: string;
  selectedProfileId?: string;
  editorValue: string;
  busy: boolean;
  error: string;
  onSelect: (profileId: string) => void;
  onActivate: () => void;
  onEditorChange: (value: string) => void;
  onCreate: () => void;
}) {
  const active = profiles.find((profile) => profile.id === activeProfileId)
    ?? profiles.find((profile) => profile.active);
  const selectedId = profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : profiles[0]?.id;

  return (
    <article
      className="research-config-card"
      data-testid={`research-config-card-${descriptor.kind}`}
    >
      <header className="research-config-card-header">
        <div>
          <span className="eyebrow">{descriptor.eyebrow}</span>
          <h3>{descriptor.label}</h3>
        </div>
        <span className={`research-active-badge ${active ? '' : 'is-empty'}`}>
          {active ? 'ACTIVE' : 'NOT CONFIGURED'}
        </span>
      </header>
      <p className="research-config-purpose">{descriptor.purpose}</p>

      {active ? (
        <>
          <div className="research-active-profile">
            <small>현재 활성 프로필</small>
            <strong data-testid="active-research-version">
              활성 프로필 · {active.version}
            </strong>
            <span>{active.title}</span>
            <p>{active.definition.description}</p>
            <code title={active.contentHash}>SHA-256 · {active.contentHash}</code>
          </div>
          <dl className="research-config-effects">
            <div>
              <dt>적용 범위</dt>
              <dd>{active.definition.applyScope}</dd>
            </div>
            <div>
              <dt>재처리 영향</dt>
              <dd>{active.definition.reprocessingImpact}</dd>
            </div>
          </dl>
          <div className="research-config-facts">
            {keyFacts(active.definition).map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <small>{fact.label}</small>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
          <details className="research-json-audit">
            <summary>전체 settings JSON</summary>
            <div data-testid="research-settings-json">
              <JsonBlock value={active.definition.settings} />
            </div>
          </details>
        </>
      ) : (
        <div className="research-config-empty">
          <strong>등록된 프로필 없음</strong>
          <p>아래 JSON 편집기에 전체 정의를 입력해 첫 불변 버전을 등록하십시오.</p>
        </div>
      )}

      <div className="research-profile-switcher">
        <label>
          {descriptor.label} 프로필 버전
          <select
            value={selectedId ?? ''}
            onChange={(event) => onSelect(event.target.value)}
            disabled={!profiles.length || busy}
          >
            {!profiles.length && <option value="">등록된 버전 없음</option>}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.version} · {profile.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          type="button"
          onClick={onActivate}
          disabled={!profiles.length || !selectedId || selectedId === active?.id || busy}
        >
          {busy ? '처리 중…' : '선택 버전 활성화'}
        </button>
      </div>
      {error && <pre className="research-config-error" role="alert">{error}</pre>}

      <details className="research-config-editor">
        <summary>새 버전 JSON 편집</summary>
        <div>
          <p>
            기존 프로필은 변경되지 않습니다. version과 필요한 설정을 바꾸면 엄격한 스키마 검증 후 새 버전으로 저장됩니다.
          </p>
          <StructuredResearchControls
            kind={descriptor.kind}
            editorValue={editorValue}
            onEditorChange={onEditorChange}
          />
          <label>
            {descriptor.label} 새 버전 JSON
            <textarea
              className="mono"
              value={editorValue}
              onChange={(event) => onEditorChange(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            className="button primary"
            type="button"
            onClick={onCreate}
            disabled={busy}
          >
            {busy ? '검증 중…' : '새 버전 저장'}
          </button>
        </div>
      </details>
    </article>
  );
}

export function ResearchSettingsWorkspace({
  initialProfiles = emptyProfiles,
}: {
  initialProfiles?: ResearchConfigProfilesData;
}) {
  const [items, setItems] = useState(initialProfiles.items);
  const [activeByKind, setActiveByKind] = useState(initialProfiles.activeByKind);
  const [selectedByKind, setSelectedByKind] = useState<
    Partial<Record<ResearchConfigKind, string>>
  >(() => Object.fromEntries(kindCards.map(({ kind }) => {
    const first = initialProfiles.items.find((item) => item.kind === kind);
    return [kind, initialProfiles.activeByKind[kind] ?? first?.id ?? ''];
  })));
  const [editors, setEditors] = useState<Record<ResearchConfigKind, string>>(
    () => Object.fromEntries(kindCards.map(({ kind }) => [
      kind,
      initialEditor(kind, initialProfiles.items, initialProfiles.activeByKind),
    ])) as Record<ResearchConfigKind, string>,
  );
  const [errors, setErrors] = useState<Partial<Record<ResearchConfigKind, string>>>({});
  const [busyKind, setBusyKind] = useState<ResearchConfigKind | null>(null);
  const [notice, setNotice] = useState('');

  async function readPayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  async function activate(kind: ResearchConfigKind) {
    const profileId = selectedByKind[kind];
    if (!profileId) return;
    setBusyKind(kind);
    setErrors((current) => ({ ...current, [kind]: '' }));
    try {
      const response = await fetch('/api/settings/research-profiles', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, profileId }),
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        setErrors((current) => ({
          ...current,
          [kind]: formatApiError(payload, '프로필을 활성화하지 못했습니다.'),
        }));
        return;
      }
      setActiveByKind((current) => ({ ...current, [kind]: profileId }));
      setItems((current) => current.map((profile) => (
        profile.kind === kind
          ? { ...profile, active: profile.id === profileId }
          : profile
      )));
      const activated = items.find((profile) => profile.id === profileId);
      setNotice(`${activated?.version ?? '선택한 프로필'}을 활성화했습니다. 새 작업부터 적용됩니다.`);
    } catch {
      setErrors((current) => ({
        ...current,
        [kind]: '네트워크 오류로 프로필을 활성화하지 못했습니다.',
      }));
    } finally {
      setBusyKind(null);
    }
  }

  async function create(kind: ResearchConfigKind) {
    let definition: unknown;
    try {
      definition = JSON.parse(editors[kind]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '유효하지 않은 JSON입니다.';
      setErrors((current) => ({ ...current, [kind]: `JSON 문법 오류: ${detail}` }));
      return;
    }
    setBusyKind(kind);
    setErrors((current) => ({ ...current, [kind]: '' }));
    try {
      const response = await fetch('/api/settings/research-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(definition),
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        setErrors((current) => ({
          ...current,
          [kind]: formatApiError(payload, '새 연구 설정 버전을 저장하지 못했습니다.'),
        }));
        return;
      }
      const item = (payload as { item?: ResearchConfigProfileView } | undefined)?.item;
      if (!item) {
        setErrors((current) => ({
          ...current,
          [kind]: '서버 응답에 저장된 프로필 정보가 없습니다.',
        }));
        return;
      }
      setItems((current) => [item, ...current]);
      setSelectedByKind((current) => ({ ...current, [kind]: item.id }));
      setEditors((current) => ({ ...current, [kind]: prettyJson(item.definition) }));
      setNotice(`${item.version}을 새 불변 버전으로 저장했습니다. 검토 후 활성화하십시오.`);
    } catch {
      setErrors((current) => ({
        ...current,
        [kind]: '네트워크 오류로 새 연구 설정 버전을 저장하지 못했습니다.',
      }));
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <section className="panel settings-section research-settings-section">
      <div className="panel-heading">
        <div><FileSliders size={16} /><h2>연구 실행 설정</h2></div>
        <span className="count-label">활성 프리셋 우선 · 불변 버전</span>
      </div>
      <div className="research-settings-intro">
        <p>
          현재 활성 버전이 새 작업의 기본값입니다. 기존 결과는 바뀌지 않으며 API 키는 위 입력란(브라우저), Base URL은 .env에서 관리합니다.
        </p>
        <span>설정을 바꾸기 전 적용 범위와 재처리 영향을 확인하십시오.</span>
      </div>
      {notice && <p className="inline-notice" role="status">{notice}</p>}
      <div className="research-config-grid">
        {kindCards.map((descriptor) => {
          const profiles = items.filter((item) => item.kind === descriptor.kind);
          return (
            <ResearchConfigCard
              key={descriptor.kind}
              descriptor={descriptor}
              profiles={profiles}
              activeProfileId={activeByKind[descriptor.kind]}
              selectedProfileId={selectedByKind[descriptor.kind]}
              editorValue={editors[descriptor.kind]}
              busy={busyKind === descriptor.kind}
              error={errors[descriptor.kind] ?? ''}
              onSelect={(profileId) => setSelectedByKind((current) => ({
                ...current,
                [descriptor.kind]: profileId,
              }))}
              onActivate={() => activate(descriptor.kind)}
              onEditorChange={(value) => setEditors((current) => ({
                ...current,
                [descriptor.kind]: value,
              }))}
              onCreate={() => create(descriptor.kind)}
            />
          );
        })}
      </div>
    </section>
  );
}
