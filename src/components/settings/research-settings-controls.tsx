'use client';

import { useId, type ReactNode } from 'react';
import type {
  BenchmarkModelsResearchConfig,
  DocumentParseResearchConfig,
  EmbeddingRagResearchConfig,
  QuestionGenerationResearchConfig,
  ResearchConfigDefinition,
  ResearchConfigKind,
} from '@/domain/research-config';

type DraftProps = {
  kind: ResearchConfigKind;
  editorValue: string;
  onEditorChange: (value: string) => void;
};

type NumberControlProps = {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  range?: boolean;
  readOnly?: boolean;
  onChange: (value: number) => void;
};

function ControlShell({
  label,
  help,
  inputId,
  children,
}: {
  label: string;
  help: string;
  inputId: string;
  children: ReactNode;
}) {
  return (
    <div className="research-draft-control">
      <label htmlFor={inputId}>{label}</label>
      {children}
      <small>{help}</small>
    </div>
  );
}

function NumberControl({
  label,
  help,
  value,
  min,
  max,
  step = 1,
  range = false,
  readOnly = false,
  onChange,
}: NumberControlProps) {
  const id = useId();
  const input = (
    <input
      id={id}
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      readOnly={readOnly}
      aria-readonly={readOnly}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
  return (
    <ControlShell label={label} help={help} inputId={id}>
      {range ? (
        <div className="research-range-control">
          <input
            type="range"
            aria-label={`${label} 슬라이더`}
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          {input}
        </div>
      ) : input}
    </ControlShell>
  );
}

function NullableNumberControl({
  label,
  help,
  value,
  min,
  max,
  step = 1,
  onChange,
}: Omit<NumberControlProps, 'value' | 'range' | 'readOnly' | 'onChange'> & {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  return (
    <ControlShell label={label} help={help} inputId={id}>
      <input
        id={id}
        type="number"
        value={value ?? ''}
        placeholder="공급자 기본값"
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(
          event.target.value === '' ? null : Number(event.target.value),
        )}
      />
    </ControlShell>
  );
}

function TextControl({
  label,
  help,
  value,
  readOnly = false,
  onChange,
}: {
  label: string;
  help: string;
  value: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <ControlShell label={label} help={help} inputId={id}>
      <input
        id={id}
        type="text"
        value={value}
        readOnly={readOnly}
        aria-readonly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </ControlShell>
  );
}

function SelectControl({
  label,
  help,
  value,
  options,
  onChange,
}: {
  label: string;
  help: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <ControlShell label={label} help={help} inputId={id}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </ControlShell>
  );
}

function CheckboxControl({
  label,
  help,
  checked,
  readOnly = false,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  readOnly?: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="research-draft-control research-checkbox-control">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      <small>{help}</small>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDraft(value: string, kind: ResearchConfigKind): ResearchConfigDefinition | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !isRecord(parsed)
      || parsed.kind !== kind
      || !isRecord(parsed.settings)
      || typeof parsed.version !== 'string'
      || typeof parsed.title !== 'string'
    ) return null;
    const settings = parsed.settings;
    if (kind === 'document_parse') {
      if (
        !isRecord(settings.rasterization)
        || !Array.isArray(settings.base64Encoding)
        || typeof settings.model !== 'string'
        || typeof settings.mode !== 'string'
        || typeof settings.ocr !== 'string'
        || typeof settings.outputFormat !== 'string'
      ) return null;
    }
    if (kind === 'embedding_rag' && (
      typeof settings.model !== 'string'
      || typeof settings.vectorSpaceId !== 'string'
      || typeof settings.prefixStrategy !== 'string'
      || typeof settings.documentPrefix !== 'string'
      || typeof settings.queryPrefix !== 'string'
    )) return null;
    if (kind === 'question_generation' && (
      typeof settings.model !== 'string'
      || typeof settings.thinkingLevel !== 'string'
      || typeof settings.responseMimeType !== 'string'
    )) return null;
    if (kind === 'benchmark_models') {
      if (
        !Array.isArray(settings.models)
        || !settings.models.every((model) => (
          isRecord(model)
          && typeof model.providerKey === 'string'
          && typeof model.displayName === 'string'
          && typeof model.modelId === 'string'
          && typeof model.protocol === 'string'
          && isRecord(model.generation)
          && Array.isArray(model.generation.stopSequences)
        ))
      ) return null;
    }
    return parsed as unknown as ResearchConfigDefinition;
  } catch {
    return null;
  }
}

function updateDraft(
  editorValue: string,
  kind: ResearchConfigKind,
  onEditorChange: (value: string) => void,
  update: (draft: ResearchConfigDefinition) => void,
) {
  const draft = parseDraft(editorValue, kind);
  if (!draft) return;
  update(draft);
  onEditorChange(JSON.stringify(draft, null, 2));
}

function DocumentControls({
  draft,
  update,
}: {
  draft: DocumentParseResearchConfig;
  update: (change: (next: DocumentParseResearchConfig) => void) => void;
}) {
  const settings = draft.settings;
  return (
    <>
      <TextControl
        label="Document Parse 모델 ID"
        value={settings.model}
        help="Upstage 요청에 전달되는 실제 모델 식별자입니다. 공급자에서 지원하는 값만 저장하십시오."
        onChange={(value) => update((next) => { next.settings.model = value; })}
      />
      <SelectControl
        label="파싱 모드"
        value={settings.mode}
        options={[
          { value: 'standard', label: 'standard' },
          { value: 'enhanced', label: 'enhanced' },
          { value: 'auto', label: 'auto' },
        ]}
        help="enhanced는 표·그림·수식의 구조 인식을 강화하지만 처리 시간이 늘어날 수 있습니다."
        onChange={(value) => update((next) => {
          next.settings.mode = value as DocumentParseResearchConfig['settings']['mode'];
        })}
      />
      <SelectControl
        label="OCR 방식"
        value={settings.ocr}
        options={[
          { value: 'auto', label: 'auto' },
          { value: 'force', label: 'force' },
        ]}
        help="force는 모든 페이지에 OCR을 적용해 스캔 교과서의 누락을 줄이지만 처리량이 증가합니다."
        onChange={(value) => update((next) => {
          next.settings.ocr = value as DocumentParseResearchConfig['settings']['ocr'];
        })}
      />
      <SelectControl
        label="파싱 출력 형식"
        value={settings.outputFormat}
        options={[
          { value: 'html', label: 'HTML' },
          { value: 'markdown', label: 'Markdown' },
          { value: 'both', label: 'HTML + Markdown' },
        ]}
        help="HTML은 레이아웃 확인에, Markdown은 청킹과 텍스트 감사에 유리합니다."
        onChange={(value) => update((next) => {
          next.settings.outputFormat = value as DocumentParseResearchConfig['settings']['outputFormat'];
        })}
      />
      <SelectControl
        label="페이지 이미지 형식"
        value={settings.rasterization.format}
        options={[
          { value: 'png', label: 'PNG(무손실)' },
          { value: 'jpeg', label: 'JPEG' },
        ]}
        help="PNG는 원본 화질 보존에 유리하고 JPEG는 전송량을 줄입니다."
        onChange={(value) => update((next) => {
          const dpi = next.settings.rasterization.dpi;
          next.settings.rasterization = value === 'png'
            ? { format: 'png', lossless: true, dpi }
            : { format: 'jpeg', lossless: false, dpi, jpegQuality: 95 };
        })}
      />
      <NumberControl
        label="페이지 렌더링 DPI"
        value={settings.rasterization.dpi}
        min={150}
        max={600}
        range
        help="높을수록 작은 글자와 수식 인식에 유리하지만 이미지 크기와 파싱 시간이 증가합니다."
        onChange={(value) => update((next) => { next.settings.rasterization.dpi = value; })}
      />
      {settings.rasterization.format === 'jpeg' && (
        <NumberControl
          label="JPEG 품질"
          value={settings.rasterization.jpegQuality}
          min={60}
          max={100}
          range
          help="값이 높을수록 압축 손실이 줄어들며 API 전송량은 늘어납니다."
          onChange={(value) => update((next) => {
            if (next.settings.rasterization.format === 'jpeg') {
              next.settings.rasterization.jpegQuality = value;
            }
          })}
        />
      )}
      <NumberControl
        label="페이지 배치 크기"
        value={settings.pagesPerBatch}
        min={1}
        max={100}
        help="한 작업 묶음의 페이지 수입니다. 장애 발생 시 재시도 범위와 메모리 사용량이 달라집니다."
        onChange={(value) => update((next) => { next.settings.pagesPerBatch = value; })}
      />
      <NumberControl
        label="페이지 파싱 동시성"
        value={settings.pageConcurrency}
        min={1}
        max={20}
        range
        help="동시에 처리하는 페이지 수입니다. 높이면 빨라지지만 Upstage 호출 한도에 도달할 수 있습니다."
        onChange={(value) => update((next) => { next.settings.pageConcurrency = value; })}
      />
      <NumberControl
        label="파싱 요청 제한시간(ms)"
        value={settings.requestTimeoutMs}
        min={1_000}
        max={600_000}
        step={1_000}
        help="이 시간을 넘긴 단일 Document Parse 요청은 실패로 기록되어 복구 대상으로 남습니다."
        onChange={(value) => update((next) => { next.settings.requestTimeoutMs = value; })}
      />
      <div className="research-control-wide research-base64-controls">
        <strong>Base64 보존 요소</strong>
        <small>표·그림·차트·수식을 원본 품질로 감사하려면 네 항목이 모두 필요하며, 누락 시 서버 검증이 저장을 거부합니다.</small>
        <div>
          {(['table', 'figure', 'chart', 'equation'] as const).map((element) => (
            <CheckboxControl
              key={element}
              label={element}
              checked={settings.base64Encoding.includes(element)}
              help={`${element} 영역 이미지를 파싱 응답에 Base64로 포함합니다.`}
              onChange={(checked) => update((next) => {
                next.settings.base64Encoding = checked
                  ? [...new Set([...next.settings.base64Encoding, element])]
                  : next.settings.base64Encoding.filter((item) => item !== element);
              })}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function EmbeddingControls({
  draft,
  update,
}: {
  draft: EmbeddingRagResearchConfig;
  update: (change: (next: EmbeddingRagResearchConfig) => void) => void;
}) {
  const settings = draft.settings;
  return (
    <>
      <TextControl
        label="임베딩 모델 ID"
        value={settings.model}
        help="문서와 검색 질의를 같은 벡터 공간으로 변환하는 Gemini 모델입니다."
        onChange={(value) => update((next) => { next.settings.model = value; })}
      />
      <NumberControl
        label="벡터 차원"
        value={settings.dimensions}
        min={128}
        max={3072}
        step={128}
        range
        help="128~3072 범위에서 저장 비용과 검색 품질을 조정합니다. 차원을 바꾸면 벡터 공간 ID도 함께 바뀌며 기존 벡터는 새 검색에 섞이지 않습니다."
        onChange={(value) => update((next) => {
          const previous = next.settings.dimensions;
          next.settings.dimensions = value;
          next.settings.vectorSpaceId = next.settings.vectorSpaceId.replace(
            `:${previous}:`,
            `:${value}:`,
          );
        })}
      />
      <TextControl
        label="벡터 공간 ID"
        value={settings.vectorSpaceId}
        help="모델·차원·전처리 전략을 식별합니다. 이 값이 다른 청크는 같은 검색에서 혼합하지 않습니다."
        onChange={(value) => update((next) => { next.settings.vectorSpaceId = value; })}
      />
      <SelectControl
        label="접두사 전략"
        value={settings.prefixStrategy}
        options={[
          { value: 'task_type', label: 'Gemini task_type' },
          { value: 'text_prefix', label: '텍스트 접두사' },
        ]}
        help="task_type은 API 역할 구분을 사용하고, text_prefix는 텍스트 앞에 연구자가 정의한 역할 문구를 붙입니다."
        onChange={(value) => update((next) => {
          next.settings.prefixStrategy = value as EmbeddingRagResearchConfig['settings']['prefixStrategy'];
          if (value === 'task_type') {
            next.settings.documentPrefix = '';
            next.settings.queryPrefix = '';
          }
        })}
      />
      <TextControl
        label="문서 접두사"
        value={settings.documentPrefix}
        readOnly={settings.prefixStrategy !== 'text_prefix'}
        help="text_prefix 전략에서만 문서 청크 앞에 붙습니다. task_type 전략에서는 빈 값이어야 합니다."
        onChange={(value) => update((next) => { next.settings.documentPrefix = value; })}
      />
      <TextControl
        label="질의 접두사"
        value={settings.queryPrefix}
        readOnly={settings.prefixStrategy !== 'text_prefix'}
        help="text_prefix 전략에서만 검색 질의 앞에 붙어 문서·질의 역할을 구분합니다."
        onChange={(value) => update((next) => { next.settings.queryPrefix = value; })}
      />
      <NumberControl
        label="청크 목표 토큰"
        value={settings.chunkTargetTokens}
        min={64}
        max={4_096}
        range
        help="작으면 근거 위치가 정밀해지고, 크면 문맥 보존이 늘지만 관련 없는 내용이 함께 검색될 수 있습니다."
        onChange={(value) => update((next) => { next.settings.chunkTargetTokens = value; })}
      />
      <NumberControl
        label="검색 후보 수(topK)"
        value={settings.retrievalTopK}
        min={1}
        max={100}
        range
        help="topK를 높이면 더 많은 후보 근거를 비교하지만 프롬프트 길이와 잡음이 함께 증가합니다."
        onChange={(value) => update((next) => { next.settings.retrievalTopK = value; })}
      />
      <NumberControl
        label="인접 청크 범위"
        value={settings.neighborWindow}
        min={0}
        max={5}
        range
        help="검색된 청크의 앞뒤를 함께 가져와 선수 개념과 이어지는 설명을 보존합니다."
        onChange={(value) => update((next) => { next.settings.neighborWindow = value; })}
      />
      <NumberControl
        label="임베딩 배치 크기"
        value={settings.batchSize}
        min={1}
        max={100}
        help="한 API 요청 묶음의 청크 수로, 처리량과 실패 시 재시도 범위를 결정합니다."
        onChange={(value) => update((next) => { next.settings.batchSize = value; })}
      />
      <NumberControl
        label="임베딩 동시성"
        value={settings.concurrency}
        min={1}
        max={20}
        range
        help="동시 임베딩 배치 수입니다. 높이면 처리 속도와 API 부하가 함께 증가합니다."
        onChange={(value) => update((next) => { next.settings.concurrency = value; })}
      />
      <NumberControl
        label="임베딩 요청 제한시간(ms)"
        value={settings.requestTimeoutMs}
        min={1_000}
        max={600_000}
        step={1_000}
        help="단일 임베딩 요청이 이 시간을 넘으면 중단되어 재시도 가능한 실패로 기록됩니다."
        onChange={(value) => update((next) => { next.settings.requestTimeoutMs = value; })}
      />
      <TextControl
        label="문서 태스크 유형"
        value={settings.documentTaskType}
        readOnly
        help="문서 청크는 RETRIEVAL_DOCUMENT 역할로 고정해 검색 질의와 구분합니다."
        onChange={() => undefined}
      />
      <TextControl
        label="질의 태스크 유형"
        value={settings.queryTaskType}
        readOnly
        help="질문 방향성 검색은 RETRIEVAL_QUERY 역할로 고정합니다."
        onChange={() => undefined}
      />
    </>
  );
}

function QuestionControls({
  draft,
  update,
}: {
  draft: QuestionGenerationResearchConfig;
  update: (change: (next: QuestionGenerationResearchConfig) => void) => void;
}) {
  const settings = draft.settings;
  return (
    <>
      <TextControl
        label="질문 생성 모델 ID"
        value={settings.model}
        help="질문 방향성 설계와 최종 문항 구조화 출력에 동일하게 사용하는 Gemini 모델입니다."
        onChange={(value) => update((next) => { next.settings.model = value; })}
      />
      <NumberControl
        label="방향 생성 출력 토큰"
        value={settings.directionMaxOutputTokens}
        min={512}
        max={16_384}
        range
        help="문항별 방향성 설계 응답의 최대 길이입니다. 너무 낮으면 검색 계획과 선수관계 가설이 잘릴 수 있습니다."
        onChange={(value) => update((next) => { next.settings.directionMaxOutputTokens = value; })}
      />
      <NumberControl
        label="질문 생성 출력 토큰"
        value={settings.questionMaxOutputTokens}
        min={4_096}
        max={65_536}
        step={512}
        range
        help="최종 문항·정답·근거·채점 정보를 담는 구조화 응답 한도이며, 응답 잘림에 직접 영향을 줍니다."
        onChange={(value) => update((next) => { next.settings.questionMaxOutputTokens = value; })}
      />
      <SelectControl
        label="질문 생성 사고 수준"
        value={settings.thinkingLevel}
        options={['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].map((value) => ({ value, label: value }))}
        help="높은 사고 수준은 선수관계 추론과 난문 설계에 유리하지만 지연시간과 토큰 사용량이 늘어납니다."
        onChange={(value) => update((next) => {
          next.settings.thinkingLevel = value as QuestionGenerationResearchConfig['settings']['thinkingLevel'];
        })}
      />
      <NumberControl
        label="질문 생성 동시성"
        value={settings.concurrency}
        min={1}
        max={20}
        range
        help="높이면 생성 속도는 빨라지지만 API 동시 요청량과 실패 시점의 작업 수가 증가합니다."
        onChange={(value) => update((next) => { next.settings.concurrency = value; })}
      />
      <NumberControl
        label="질문 생성 요청 제한시간(ms)"
        value={settings.requestTimeoutMs}
        min={1_000}
        max={600_000}
        step={1_000}
        help="방향 또는 최종 질문 요청 하나가 허용되는 최대 시간입니다."
        onChange={(value) => update((next) => { next.settings.requestTimeoutMs = value; })}
      />
      <CheckboxControl
        label="구조화 JSON 출력"
        checked={settings.structuredOutput}
        readOnly
        help="문항 필드 누락과 깨진 JSON을 줄이기 위해 항상 켜져 있으며 서버 스키마도 true만 허용합니다."
        onChange={() => undefined}
      />
      <TextControl
        label="응답 MIME 유형"
        value={settings.responseMimeType}
        readOnly
        help="파싱 가능한 문항 객체를 받기 위해 application/json으로 고정합니다."
        onChange={() => undefined}
      />
    </>
  );
}

function BenchmarkControls({
  draft,
  update,
}: {
  draft: BenchmarkModelsResearchConfig;
  update: (change: (next: BenchmarkModelsResearchConfig) => void) => void;
}) {
  return (
    <div className="research-model-controls research-control-wide">
      {draft.settings.models.map((model, index) => {
        const updateModel = (
          change: (next: BenchmarkModelsResearchConfig['settings']['models'][number]) => void,
        ) => update((next) => change(next.settings.models[index]));
        const prefix = model.displayName;
        return (
          <fieldset key={model.providerKey}>
            <legend>{model.displayName} · {model.providerKey}</legend>
            <div className="research-draft-control-grid">
              <CheckboxControl
                label={`${prefix} 사용`}
                checked={model.enabled}
                help="끄면 새 벤치마크 실행의 비교 대상에서 제외되며 기존 실행에는 영향이 없습니다."
                onChange={(value) => updateModel((next) => { next.enabled = value; })}
              />
              <TextControl
                label={`${prefix} 모델 ID`}
                value={model.modelId}
                help="실제 API 요청에 전달하고 실행 스냅샷에 남기는 정확한 모델 식별자입니다."
                onChange={(value) => updateModel((next) => { next.modelId = value; })}
              />
              <TextControl
                label={`${prefix} 프로토콜`}
                value={model.protocol}
                readOnly
                help="공급자 어댑터와 응답 파서를 결정하므로 providerKey에 맞춰 고정됩니다."
                onChange={() => undefined}
              />
              <NumberControl
                label={`${prefix} 동시성`}
                value={model.concurrency}
                min={1}
                max={50}
                range
                help="모델별 호출 동시성은 공급자 한도와 실행 속도, 실패 시 동시 영향 범위를 결정합니다."
                onChange={(value) => updateModel((next) => { next.concurrency = value; })}
              />
              <NumberControl
                label={`${prefix} 요청 간격(ms)`}
                value={model.requestIntervalMs}
                min={0}
                max={60_000}
                step={100}
                help="각 호출 시작 사이의 최소 간격으로 요청률 제한이 엄격한 모델을 보호합니다."
                onChange={(value) => updateModel((next) => { next.requestIntervalMs = value; })}
              />
              <NumberControl
                label={`${prefix} 요청 제한시간(ms)`}
                value={model.requestTimeoutMs}
                min={1_000}
                max={600_000}
                step={1_000}
                help="단일 응답이 이 시간을 넘으면 해당 문항 실패로 기록되고 실행은 다음 항목을 처리합니다."
                onChange={(value) => updateModel((next) => { next.requestTimeoutMs = value; })}
              />
              <NumberControl
                label={`${prefix} 최대 출력 토큰`}
                value={model.generation.maxOutputTokens}
                min={1}
                max={131_072}
                step={256}
                help="출력 토큰 한도는 응답 잘림과 비용에 직접 영향을 주며 모델의 실제 지원 한도를 넘기면 실패할 수 있습니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.maxOutputTokens = value;
                })}
              />
              <NullableNumberControl
                label={`${prefix} Temperature`}
                value={model.generation.temperature}
                min={0}
                max={2}
                step={0.05}
                help="낮을수록 결정적이고 높을수록 표현 다양성이 증가합니다. 빈 값은 공급자 기본값입니다."
                onChange={(value) => updateModel((next) => { next.generation.temperature = value; })}
              />
              <CheckboxControl
                label={`${prefix} Temperature 전송 생략`}
                checked={model.generation.omitTemperature}
                help="켜면 API 요청에서 temperature 필드를 완전히 제외해 사고 모델의 호환성을 보존합니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.omitTemperature = value;
                })}
              />
              <NullableNumberControl
                label={`${prefix} Top P`}
                value={model.generation.topP}
                min={0}
                max={1}
                step={0.01}
                help="다음 토큰 후보의 누적 확률 범위입니다. 빈 값은 공급자 기본값입니다."
                onChange={(value) => updateModel((next) => { next.generation.topP = value; })}
              />
              <CheckboxControl
                label={`${prefix} Top P 전송 생략`}
                checked={model.generation.omitTopP}
                help="켜면 API 요청에서 topP 필드를 완전히 제외합니다."
                onChange={(value) => updateModel((next) => { next.generation.omitTopP = value; })}
              />
              <NullableNumberControl
                label={`${prefix} Presence penalty`}
                value={model.generation.presencePenalty}
                min={-2}
                max={2}
                step={0.1}
                help="이미 등장한 주제의 반복을 줄이거나 늘립니다. 빈 값은 해당 필드를 전송하지 않습니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.presencePenalty = value;
                })}
              />
              <NullableNumberControl
                label={`${prefix} Frequency penalty`}
                value={model.generation.frequencyPenalty}
                min={-2}
                max={2}
                step={0.1}
                help="같은 토큰의 반복 빈도를 조절합니다. 빈 값은 해당 필드를 전송하지 않습니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.frequencyPenalty = value;
                })}
              />
              <SelectControl
                label={`${prefix} 사고 수준`}
                value={model.generation.thinkingLevel ?? ''}
                options={[
                  { value: '', label: '공급자 기본값 / 미지원' },
                  ...['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].map((value) => ({ value, label: value })),
                ]}
                help="지원 모델에서 추론 예산 수준을 정합니다. 미지원 공급자는 빈 값으로 둡니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.thinkingLevel = value
                    ? value as NonNullable<typeof next.generation.thinkingLevel>
                    : null;
                })}
              />
              <SelectControl
                label={`${prefix} Thinking 사용`}
                value={model.generation.enableThinking == null
                  ? ''
                  : String(model.generation.enableThinking)}
                options={[
                  { value: '', label: '공급자 기본값 / 미지원' },
                  { value: 'true', label: '사용' },
                  { value: 'false', label: '미사용' },
                ]}
                help="OpenAI 호환 공급자의 명시적 thinking 플래그입니다. 모델이 지원하지 않으면 빈 값으로 둡니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.enableThinking = value === '' ? null : value === 'true';
                })}
              />
              <TextControl
                label={`${prefix} 중단 문자열`}
                value={model.generation.stopSequences.join('\n')}
                help="줄마다 하나씩 입력하며, 모델 출력에서 일치하면 생성을 종료합니다."
                onChange={(value) => updateModel((next) => {
                  next.generation.stopSequences = value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean);
                })}
              />
              <NullableNumberControl
                label={`${prefix} Seed`}
                value={model.generation.seed}
                min={0}
                max={2_147_483_647}
                help="지원 공급자에서 재현성을 높이는 난수 시드입니다. 빈 값은 전송하지 않습니다."
                onChange={(value) => updateModel((next) => { next.generation.seed = value; })}
              />
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

export function StructuredResearchControls({
  kind,
  editorValue,
  onEditorChange,
}: DraftProps) {
  const draft = parseDraft(editorValue, kind);
  if (!draft) {
    return (
      <p className="research-draft-unavailable">
        JSON 문법과 kind/settings 구조가 올바르면 구조화 설정 컨트롤이 표시됩니다.
      </p>
    );
  }

  const update = <T extends ResearchConfigDefinition>(
    change: (next: T) => void,
  ) => updateDraft(editorValue, kind, onEditorChange, (next) => change(next as T));

  return (
    <section className="research-draft-controls" aria-label={`${kind} 새 버전 구조화 설정`}>
      <header>
        <strong>새 불변 버전 초안 설정</strong>
        <span>컨트롤 변경 → JSON 초안 반영 → 서버 검증 → 새 버전 저장</span>
      </header>
      <p>
        활성 프로필에서 복제한 초안만 변경합니다. 현재 활성 설정과 기존 실행 기록은 직접 수정되지 않습니다.
      </p>
      <div className="research-draft-control-grid">
        <TextControl
          label="새 프로필 버전"
          value={draft.version}
          help="기존 버전과 겹치지 않는 영문 소문자·숫자·점·밑줄·하이픈 식별자를 사용하십시오."
          onChange={(value) => update<ResearchConfigDefinition>((next) => {
            next.version = value;
          })}
        />
        <TextControl
          label="새 프로필 제목"
          value={draft.title}
          help="비교 실험에서 변경 의도를 구분할 수 있는 짧은 제목입니다."
          onChange={(value) => update<ResearchConfigDefinition>((next) => {
            next.title = value;
          })}
        />
        {draft.kind === 'document_parse' && (
          <DocumentControls draft={draft} update={update} />
        )}
        {draft.kind === 'embedding_rag' && (
          <EmbeddingControls draft={draft} update={update} />
        )}
        {draft.kind === 'question_generation' && (
          <QuestionControls draft={draft} update={update} />
        )}
        {draft.kind === 'benchmark_models' && (
          <BenchmarkControls draft={draft} update={update} />
        )}
      </div>
    </section>
  );
}
