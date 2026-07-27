// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { ReviewWorkspace } from '@/components/review/review-workspace';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { SourcesWorkspace, sourceStageState } from '@/components/sources/sources-workspace';
import { DocumentLabWorkspace } from '@/components/document-lab/document-lab-workspace';
import { RunController } from '@/components/runs/run-controller';
import { SettingsWorkspace } from '@/components/settings/settings-workspace';
import { RunWorkspace } from '@/components/runs/run-workspace';
import { ResultAnalyticsDashboard } from '@/components/results/result-analytics-dashboard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('document lab identifies the active research profile before upload without inventing settings', () => {
  render(<DocumentLabWorkspace />);
  expect(screen.getByRole('heading', { name: 'Document Lab' })).toBeInTheDocument();
  expect(screen.getByLabelText('테스트 파일')).toBeInTheDocument();
  expect(screen.getByText('활성 연구 프로필 사용')).toBeInTheDocument();
  expect(screen.queryByText('Enhanced')).not.toBeInTheDocument();
  expect(screen.queryByText('ocr=force')).not.toBeInTheDocument();
  expect(screen.getByText('원본 페이지')).toBeInTheDocument();
  expect(screen.getByText('변환 HTML')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '원본 JSON' })).toBeInTheDocument();
  expect(screen.getByText('테스트 파일을 선택하면 페이지별 결과가 여기에 표시됩니다.')).toBeInTheDocument();
  expect(document.getElementById('document-lab-preview-panel')).toBeInTheDocument();
  expect(document.getElementById('document-lab-source-panel')).toHaveAttribute('hidden');
  expect(document.getElementById('document-lab-elements-panel')).toBeInTheDocument();
  expect(document.getElementById('document-lab-raw-panel')).toHaveAttribute('hidden');
  expect(document.getElementById('document-lab-request-panel')).toHaveAttribute('hidden');
});

test('document lab uploads one file and switches every result pane by PDF page', async () => {
  const responseBody = {
    mock: true,
    requestConfig: {
      model: 'mock-document-parse',
      mode: 'enhanced',
      ocr: 'force',
      base64_encoding: ['footnote'],
      output_formats: ['html'],
      rasterization: { format: 'png', dpi: 220 },
    },
    pages: [
      {
        pageNumber: 1,
        filename: 'sample-page-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cGFnZTE=',
        html: '<h1>첫 페이지</h1>',
        elements: [{ type: 'heading', content: '첫 페이지' }],
        raw: { page: 1 },
        requestId: 'mock-page-1',
        model: 'mock-document-parse',
        requestConfig: { pageNumber: 1, ocr: 'force' },
      },
      {
        pageNumber: 2,
        filename: 'sample-page-2.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cGFnZTI=',
        html: '<h1>둘째 페이지</h1>',
        elements: [{ type: 'heading', content: '둘째 페이지' }],
        raw: { page: 2 },
        requestId: 'mock-page-2',
        model: 'mock-document-parse',
        requestConfig: { pageNumber: 2, ocr: 'force' },
      },
    ],
  };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => responseBody });
  vi.stubGlobal('fetch', fetchMock);
  render(<DocumentLabWorkspace />);

  const file = new File(['%PDF-test'], 'sample.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('테스트 파일'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '문서 파싱' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(fetchMock).toHaveBeenCalledWith('/api/document-lab/parse', expect.objectContaining({ method: 'POST' }));
  expect(request.body).toBeInstanceOf(FormData);
  expect((request.body as FormData).get('file')).toBe(file);
  expect(await screen.findByText('MOCK')).toBeInTheDocument();
  expect(screen.getByText('mode=enhanced')).toBeInTheDocument();
  expect(screen.getByText('ocr=force')).toBeInTheDocument();
  expect(screen.getByText('base64_encoding=["footnote"]')).toBeInTheDocument();
  expect(screen.getByText('output_formats=["html"]')).toBeInTheDocument();
  expect(screen.getByText('format=png · dpi=220')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Page 01' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByAltText('원본 페이지 1')).toHaveAttribute('src', responseBody.pages[0].dataUrl);

  fireEvent.click(screen.getByRole('button', { name: 'Page 02' }));
  expect(screen.getByRole('button', { name: 'Page 02' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByAltText('원본 페이지 2')).toHaveAttribute('src', responseBody.pages[1].dataUrl);
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute('sandbox', '');
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute(
    'srcdoc',
    expect.stringContaining("default-src 'none'; img-src data: blob:"),
  );
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute('srcdoc', expect.stringContaining('<h1>둘째 페이지</h1>'));

  const previewTab = screen.getByRole('tab', { name: '미리보기' });
  previewTab.focus();
  fireEvent.keyDown(previewTab, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '소스 HTML' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: '소스 HTML' })).toHaveAttribute('aria-selected', 'true');
  expect(document.getElementById('document-lab-preview-panel')).toHaveAttribute('hidden');
  expect(document.getElementById('document-lab-source-panel')).not.toHaveAttribute('hidden');
  expect(screen.getByText('<h1>둘째 페이지</h1>')).toBeVisible();

  fireEvent.click(screen.getByRole('tab', { name: '원본 JSON' }));
  expect(screen.getByText(/"page": 2/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '요청 정보' }));
  expect(screen.getByText('mock-page-2')).toBeInTheDocument();
});

test('document lab clears stale results and resets panes when a different file is selected', async () => {
  const responseBody = {
    mock: true,
    requestConfig: { mode: 'enhanced' },
    pages: [{
      pageNumber: 1,
      filename: 'first-page.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,Zmlyc3Q=',
      html: '<p>stale first file</p>',
      elements: [{ type: 'paragraph' }],
      raw: { source: 'first' },
      requestId: 'first-request',
      model: 'mock-document-parse',
      requestConfig: { pageNumber: 1 },
    }],
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => responseBody }));
  render(<DocumentLabWorkspace />);

  const input = screen.getByLabelText('테스트 파일');
  fireEvent.change(input, { target: { files: [new File(['first'], 'first.pdf', { type: 'application/pdf' })] } });
  fireEvent.click(screen.getByRole('button', { name: '문서 파싱' }));
  expect(await screen.findByAltText('원본 페이지 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '소스 HTML' }));
  fireEvent.click(screen.getByRole('tab', { name: '원본 JSON' }));

  fireEvent.change(input, { target: { files: [new File(['second'], 'second.pdf', { type: 'application/pdf' })] } });

  expect(screen.queryByAltText('원본 페이지 1')).not.toBeInTheDocument();
  expect(screen.queryByText('MOCK')).not.toBeInTheDocument();
  expect(screen.getByText('테스트 파일을 선택하면 페이지별 결과가 여기에 표시됩니다.')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '미리보기' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Elements' })).toHaveAttribute('aria-selected', 'true');
});

test('document lab locks file controls while parsing and preserves structured provider errors', async () => {
  let resolveFetch!: (value: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void;
  const fetchPromise = new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
    resolveFetch = resolve;
  });
  vi.stubGlobal('fetch', vi.fn(() => fetchPromise));
  render(<DocumentLabWorkspace />);

  const input = screen.getByLabelText('테스트 파일');
  fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.pdf', { type: 'application/pdf' })] } });
  fireEvent.click(screen.getByRole('button', { name: '문서 파싱' }));

  expect(await screen.findByRole('status')).toHaveTextContent('문서를 페이지별로 분석하고 있습니다.');
  expect(input).toBeDisabled();
  expect(screen.getByRole('button', { name: '파싱 중…' })).toBeDisabled();

  resolveFetch({ ok: false, json: async () => ({
    code: 'DOCUMENT_PAGE_PARSE_FAILED',
    message: 'Upstage request was rejected.',
    page: 3,
    requestId: 'upstage-request-123',
    status: 429,
    category: 'RATE_LIMIT',
  }) });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Upstage request was rejected.');
  expect(alert).toHaveTextContent('DOCUMENT_PAGE_PARSE_FAILED');
  expect(alert).toHaveTextContent('페이지 3');
  expect(alert).toHaveTextContent('upstage-request-123');
  expect(alert).toHaveTextContent('HTTP 429');
  expect(alert).toHaveTextContent('RATE_LIMIT');
  expect(alert).toHaveTextContent('파일 형식과 서버 설정을 확인한 뒤 같은 파일로 다시 시도하세요.');
  expect(input).not.toBeDisabled();
});

test('source workspace exposes PDF upload and each processing stage', () => {
  render(<SourcesWorkspace initialSources={[]} />);
  expect(screen.getByRole('heading', { name: '교과서 자료 관리' })).toBeInTheDocument();
  expect(screen.getByLabelText('교과서 PDF')).toBeInTheDocument();
  expect(screen.getByText('Document Parse')).toBeInTheDocument();
  expect(screen.getByText('HTML 검수')).toBeInTheDocument();
  expect(screen.getByText('청크')).toBeInTheDocument();
  expect(screen.getByText('임베딩')).toBeInTheDocument();
});

test('source processing stages are derived from machine status and failed-stage codes', () => {
  const source = {
    id: 'source-stage',
    original_name: 'science.pdf',
    subject: '과학',
    grade: '중2',
    byte_size: 10,
    status: 'CHUNKING',
    failed_stage: null,
    created_at: '2026-07-20T10:00:00Z',
    current_job_id: 'job-stage',
    current_job_state: 'LEASED',
  };

  expect(sourceStageState(source, 'parse')).toBe('완료');
  expect(sourceStageState(source, 'html')).toBe('완료');
  expect(sourceStageState(source, 'chunk')).toBe('처리 중');
  expect(sourceStageState(source, 'embedding')).toBe('대기');
  expect(sourceStageState({ ...source, status: 'FAILED', failed_stage: 'CHUNKING' }, 'chunk')).toBe('실패');
  expect(sourceStageState({ ...source, status: 'FAILED', failed_stage: 'EMBEDDING' }, 'embedding')).toBe('실패');
  expect(sourceStageState({ ...source, status: 'FAILED', failed_stage: 'UNKNOWN_LEGACY_STAGE' }, 'chunk')).toBe('기록 없음');
});

test('run detail exposes exact prompts, responses, failures, scores, and the evaluation profile', () => {
  class EventSourceStub { addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', EventSourceStub);
  render(<RunController
    initialRun={{ id:'run-1', public_id:'RUN-1', title:'실행', state:'RUNNING', total_items:1, completed_items:1, failed_items:0, dataset_version:'actual-v1', score_version:'score-v1', price_profile_version:'price-v1', created_at:'2026-07-22T00:00:00Z' }}
    models={[{ id:'model-1', display_name:'Gemini', blind_id:'M01', model_id:'gemini-test', protocol:'gemini', concurrency:1 }]}
    profile={{ version:'score-v1', title:'선수관계 평가', metrics:['accuracy'], rubricPrompt:'절대평가한다.', judgeProvider:'gemini', judgeModel:'gemini-test', contentHash:'abc123', dynamicMetrics:['prerequisite_relation_accuracy'], snapshotProvenance:'LEGACY_BACKFILL_UNVERIFIED' }}
    initialItems={[{ id:'item-1', state:'SUCCEEDED', attempts:1, errorCode:null, errorMessage:null, questionPublicId:'Q-1', questionText:'질문', providerKey:'gemini', displayName:'Gemini', modelId:'gemini-test', blindId:'M01', request:{ system:'시스템 지시', prompt:'실제 질문 입력' }, response:{ text:'모델 답변', raw:{ id:'raw' }, requestId:'req-1', retryHistory:[] }, scores:[{ metricKey:'accuracy', value:0.8, label:'GOOD', rationale:'근거에 부합', evidence:[] }] }]}
  />);
  expect(screen.getByText('평가 프로필')).toBeInTheDocument();
  expect(screen.getByText('실제 전송 프롬프트')).toBeInTheDocument();
  expect(screen.getByText('모델 응답')).toBeInTheDocument();
  expect(screen.getByText('점수와 판정 근거')).toBeInTheDocument();
  expect(screen.getByText(/생성 시점 스냅샷 출처가 검증되지 않았습니다/)).toBeInTheDocument();
});

test('run detail separates execution completion from scoring coverage', () => {
  class EventSourceStub { addEventListener() {} removeEventListener() {} close() {} }
  vi.stubGlobal('EventSource', EventSourceStub);
  const baseItem = {
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    questionText: '질문',
    providerKey: 'gemini',
    displayName: 'Gemini',
    modelId: 'gemini-test',
    blindId: 'M01',
    request: { prompt: '질문' },
    judgeInvocations: [],
    requiredMetricKeys: ['accuracy'],
  };
  render(<RunController
    initialRun={{ id:'run-coverage', public_id:'RUN-COVERAGE', title:'진행률 분리', state:'COMPLETED', total_items:3, completed_items:2, failed_items:1, dataset_version:'actual-v1', score_version:'score-v1', price_profile_version:'price-v1', created_at:'2026-07-22T00:00:00Z' }}
    models={[]}
    profile={{ version:'score-v1', title:'평가', metrics:['accuracy'], rubricPrompt:'평가', judgeProvider:'gemini', judgeModel:'gemini-test', contentHash:'hash', dynamicMetrics:[] }}
    initialItems={[
      { ...baseItem, id:'item-1', state:'SUCCEEDED', questionPublicId:'Q-1', response:{ text:'응답 1', raw:{}, requestId:'r1', retryHistory:[] }, scores:[{ metricKey:'accuracy', value:0.8, label:'GOOD', rationale:'근거', evidence:[] }] },
      { ...baseItem, id:'item-2', state:'SUCCEEDED', questionPublicId:'Q-2', response:{ text:'응답 2', raw:{}, requestId:'r2', retryHistory:[] }, scores:[] },
      { ...baseItem, id:'item-3', state:'FAILED', questionPublicId:'Q-3', response:null, scores:[] },
    ]}
  />);

  const progress = screen.getByRole('region', { name: '실행 및 채점 진행률' });
  expect(within(progress).getByText('실행 진행')).toBeInTheDocument();
  expect(within(progress).getByText('3 / 3')).toBeInTheDocument();
  expect(within(progress).getByText('채점 범위')).toBeInTheDocument();
  expect(within(progress).getByText('1 / 2 지표')).toBeInTheDocument();
  expect(within(progress).getByText(/필수 지표별 실제 저장률/)).toBeInTheDocument();
});

test('settings exposes the complete evaluation profile configuration', () => {
  render(<SettingsWorkspace providers={[]} prices={[]} mockMode={false} scores={[{
    version:'score-v1', title:'선수관계 평가', judge_provider:'gemini', judge_model:'gemini-test',
    metrics:['accuracy','faithfulness'], rubric_prompt:'교과서 근거로 절대평가한다.', content_hash:'hash-123', created_at:'2026-07-22T00:00:00Z',
  }]}/>);
  expect(screen.getByText('교과서 근거로 절대평가한다.')).toBeInTheDocument();
  expect(screen.getByText('accuracy')).toBeInTheDocument();
  expect(screen.getByText('gemini-test')).toBeInTheDocument();
  expect(screen.getByText('hash-123')).toBeInTheDocument();
});

test('settings marks unresolved legacy score profiles as deprecated', () => {
  const unresolvedProfiles = [{
    version:'legacy-score-v0',
    title:'이전 프로필',
    judge_provider:'gemini',
    judge_model:'legacy-environment-default-unrecorded',
    metrics:['accuracy'],
    rubric_prompt:'이전 평가',
    content_hash:'legacy-hash',
    created_at:'2026-07-01T00:00:00Z',
    provenance_unresolved:true,
  }];
  render(<SettingsWorkspace providers={[]} prices={[]} mockMode={false} scores={unresolvedProfiles}/>);

  expect(screen.getByText('폐기됨 · Judge 출처 미확정')).toBeInTheDocument();
  expect(screen.getByText(/새 채점 프로필 버전을 만들어야/)).toBeInTheDocument();
});

test('run setup excludes unresolved score profiles and explains why', () => {
  const scoreProfiles = [
    { id:'legacy-profile', version:'legacy-v0', title:'출처 미확정', provenance_unresolved:true },
    { id:'verified-profile', version:'score-v2', title:'검증 프로필', provenance_unresolved:false },
  ];
  render(<RunWorkspace
    datasets={[{ id:'dataset-1', version:'actual-v1', title:'실제', question_count:1 }]}
    scoreProfiles={scoreProfiles}
    providers={[{ provider_key:'gemini', display_name:'Gemini', protocol:'gemini', modelId:'gemini-test', envName:'GEMINI_GENERATION_MODEL', requestIntervalMs:0 }]}
    initialRuns={[]}
  />);

  expect(screen.getByText(/출처가 확인되지 않은 채점 프로필 1개를 실행 선택에서 제외/)).toBeInTheDocument();
  expect(screen.queryByRole('option', { name:/legacy-v0/ })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name:/score-v2/ })).toBeInTheDocument();
});

test('benchmark run preserves provider request pacing in the execution spec', async () => {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    void input;
    void init;
    return { ok:true, json:async () => ({ id:'run-1', publicId:'RUN-1', totalItems:1 }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<RunWorkspace
    datasets={[{ id:'dataset-1', version:'actual-v1', title:'실제', question_count:1 }]}
    scoreProfiles={[{ id:'profile-1', version:'score-v1', title:'평가' }]}
    providers={[{ provider_key:'exaone', display_name:'EXAONE', protocol:'openai-compatible', modelId:'exaone-test', envName:'EXAONE_MODEL', requestIntervalMs:20000 }]}
    modelProfile={{ id:'model-profile-1', version:'benchmark-models-test-v1', contentHash:'a'.repeat(64) }}
    initialRuns={[]}
  />);
  fireEvent.click(screen.getByRole('button', { name:'실행 초안 생성' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(String(request.body));
  expect(body.models[0]).toMatchObject({ providerKey:'exaone', requestIntervalMs:20000 });
});

test('result analytics renders comprehensive charts and filters models', () => {
  render(<ResultAnalyticsDashboard analytics={{
    models:[
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:10, avgLatencyMs:900, costKrw:12, compositeScore:0.82, scoreCount:150 },
      { blindId:'M02', displayName:'EXAONE', modelId:'exaone-test', responses:10, avgLatencyMs:1500, costKrw:null, compositeScore:0.74, scoreCount:150 },
    ],
    metricRows:[{ metricKey:'accuracy', label:'정확성', scores:{ M01:0.8, M02:0.7 }, counts:{ M01:10, M02:10 } }],
    purposeRows:[{ purpose:'선수 관계', scores:{ M01:0.8, M02:0.7 }, counts:{ M01:5, M02:5 } }],
    prerequisiteRows:[{ metricKey:'prerequisite_relation_accuracy', label:'선수 관계 방향 정확성', scores:{ M01:0.75, M02:0.65 }, counts:{ M01:10, M02:10 } }],
    questionRows:[{ questionId:'q1', publicId:'Q-1', questionText:'선수 개념을 적용하라.', purpose:'선수 관계', scores:{ M01:0.8, M02:0.7 } }],
    distributions:[{ blindId:'M01', bins:[0,1,2,3,4] }, { blindId:'M02', bins:[1,2,3,3,1] }],
  }} />);
  expect(screen.getByRole('heading', { name:'종합 성능 비교' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name:'평가 지표 레이더' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name:'선수관계 역량' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name:'성능·효율' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name:'문항별 히트맵' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name:'점수 분포' })).toBeInTheDocument();
  expect(screen.getByText('왼쪽 위에 가까울수록 빠르면서 종합점수가 높습니다.')).toBeInTheDocument();
  const exaone = screen.getByLabelText('M02 모델 표시');
  fireEvent.click(exaone);
  expect(exaone).not.toBeChecked();
  expect(screen.queryByTestId('ranking-M02')).not.toBeInTheDocument();
});

test('source workspace opens live expandable logs and exposes cancellation', async () => {
  const source = {
    id: 'source-12345678', original_name: 'science.pdf', subject: '과학', grade: '중2', byte_size: 10,
    status: 'PARSING', failed_stage: null, created_at: '2026-07-20T10:00:00Z', current_job_id: 'job-1', current_job_state: 'LEASED',
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/cancel') && init?.method === 'POST') return { ok: true, json: async () => ({ state: 'CANCELLED' }) };
    if (input.endsWith('/activity')) return { ok: true, json: async () => ({
      source: { ...source, updated_at: source.created_at },
      job: { id: 'job-1', state: 'LEASED', attempts: 1, max_attempts: 4 },
      events: [{ id: '1', event_type: 'DOCUMENT_PARSE_STARTED', payload: { provider: 'upstage' }, created_at: source.created_at }],
    }) };
    return { ok: true, json: async () => ({ items: [source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getByText('science.pdf'));
  expect(await screen.findByRole('complementary', { name: '교과서 처리 기록' })).toBeInTheDocument();
  expect(await screen.findByText('Upstage Document Parse 시작')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Upstage Document Parse 시작'));
  expect(screen.getByText(/"provider": "upstage"/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '작업 중단' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sources/source-12345678/cancel', { method: 'POST' }));
});

test('source activity exposes the immutable document and embedding execution profiles', async () => {
  const source = {
    id: 'source-profile-audit', original_name: 'history.pdf', subject: '한국사', grade: '고등학교',
    byte_size: 10, status: 'READY', failed_stage: null, created_at: '2026-07-20T10:00:00Z',
    current_job_id: 'job-profile', current_job_state: 'SUCCEEDED',
  };
  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/activity')) return { ok: true, json: async () => ({
      source: { ...source, updated_at: source.created_at },
      job: { id: 'job-profile', state: 'SUCCEEDED', attempts: 1, max_attempts: 4 },
      events: [],
      executionProfiles: {
        documentParse: {
          kind: 'document_parse',
          profileId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'a'.repeat(64),
          provenance: 'AT_CREATION_VERIFIED',
          definition: { kind: 'document_parse', version: 'document-parse-v1' },
        },
        embeddingRag: {
          kind: 'embedding_rag',
          profileId: '22222222-2222-4222-8222-222222222222',
          contentHash: 'b'.repeat(64),
          provenance: 'AT_CREATION_VERIFIED',
          definition: { kind: 'embedding_rag', version: 'embedding-rag-v1' },
        },
      },
    }) };
    return { ok: true, json: async () => ({ items: [source] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SourcesWorkspace initialSources={[source]} />);

  fireEvent.click(screen.getByText('history.pdf'));

  const audit = await screen.findByRole('region', { name: '고정 실행 설정' });
  expect(within(audit).getByRole('heading', { name: '고정 실행 설정' })).toBeInTheDocument();
  expect(within(audit).getByText('Document Parse')).toBeInTheDocument();
  expect(within(audit).getByText('Embedding · RAG')).toBeInTheDocument();
  expect(within(audit).getByText('11111111-1111-4111-8111-111111111111')).toBeInTheDocument();
  expect(within(audit).getByText('a'.repeat(64))).toBeInTheDocument();
  expect(within(audit).getAllByText('AT_CREATION_VERIFIED')).toHaveLength(2);
});

test('question generation exposes source scope and observable generation stages', () => {
  render(<GenerationWorkspace sources={[]} batches={[]} />);
  expect(screen.getByRole('heading', { name: '질문 생성' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '교과서와 목차 선택' })).toBeInTheDocument();
  expect(screen.getByText('실제 생성 단계')).toBeInTheDocument();
  expect(screen.getByText(/배치·문항·이벤트에 저장된 단계만 표시/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '문항 생성 시작' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'AI 지시 프롬프트 미리보기' })).toBeInTheDocument();
});

test('question prompt preview reacts to purpose, format, and high difficulty', () => {
  render(<GenerationWorkspace sources={[]} batches={[]} />);
  fireEvent.change(screen.getByLabelText('질문 목적'), { target: { value: '오개념·잘못된 주장 교정' } });
  fireEvent.change(screen.getByLabelText('문항 형식'), { target: { value: '객관식' } });
  fireEvent.change(screen.getByLabelText('난이도'), { target: { value: '상' } });

  const preview = screen.getByRole('region', { name: 'AI 지시 프롬프트 미리보기' });
  expect(preview).toHaveTextContent('수능 고난도');
  expect(preview).toHaveTextContent('대표 오개념');
  expect(preview).toHaveTextContent('5개 선택지');
});

test('question generation lazily loads full retrieval and provider audit with pagination', async () => {
  class EventSourceStub { addEventListener() {} removeEventListener() {} close() {} }
  vi.stubGlobal('EventSource', EventSourceStub);
  const batchId = 'batch-observable';
  const activity = {
    batch: {
      id: batchId,
      state: 'RUNNING',
      requested_count: 2,
      created_at: '2026-07-26T00:00:00Z',
      conditions: { executionMode: 'parallel' },
      progress: { completedQuestions: 1, failedQuestions: 0 },
    },
    job: { state: 'LEASED', attempts: 1, max_attempts: 3, last_error_code: null, last_error_message: null },
    events: [
      { id:'e1', event_type:'QUESTION_DIRECTION_COMPLETED', payload:{ ordinal:1 }, created_at:'2026-07-26T00:00:01Z' },
      { id:'e2', event_type:'QUESTION_DIRECTION_COMPLETED', payload:{ ordinal:2 }, created_at:'2026-07-26T00:00:02Z' },
      { id:'e3', event_type:'QUESTION_RETRIEVAL_COMPLETED', payload:{ ordinal:1 }, created_at:'2026-07-26T00:00:03Z' },
      { id:'e4', event_type:'QUESTION_RETRIEVAL_STARTED', payload:{ ordinal:2 }, created_at:'2026-07-26T00:00:04Z' },
      { id:'e5', event_type:'QUESTION_GENERATION_COMPLETED', payload:{ ordinal:1 }, created_at:'2026-07-26T00:00:05Z' },
    ],
    questions: [],
    canResume: false,
    eventCursor: 'e5',
    items: [
      {
        id:'item-1', ordinal:1, state:'COMPLETED', attempts:1, retryable:false,
        direction:{ directionSummary:'속력 개념에서 가속도 관계를 추론' },
        error:null,
        latestRetrieval:{
          id:'retrieval-1', attempt:1, queryText:'속력과 가속도의 선수 관계',
          selectedChunkCount:1,
          createdAt:'2026-07-26T00:00:03Z',
        },
        providerInvocationSummary:{ total:2, requested:0, completed:2, failed:0, abandoned:0 },
        questionId:'question-1', questionPublicId:'Q-1',
        startedAt:'2026-07-26T00:00:00Z', completedAt:'2026-07-26T00:00:05Z', updatedAt:'2026-07-26T00:00:05Z',
      },
      {
        id:'item-2', ordinal:2, state:'RUNNING', attempts:1, retryable:true,
        direction:{ directionSummary:'힘 개념을 이용해 운동 변화를 설명' },
        error:null, latestRetrieval:null,
        providerInvocationSummary:{ total:0, requested:0, completed:0, failed:0, abandoned:0 },
        questionId:null, questionPublicId:null,
        startedAt:'2026-07-26T00:00:00Z', completedAt:null, updatedAt:'2026-07-26T00:00:04Z',
      },
    ],
  };
  const auditPages = [{
    batchId,
    itemId:'item-1',
    latestRetrieval:{
      id:'retrieval-1', attempt:1, queryText:'속력과 가속도의 선수 관계',
      candidateScope:{ tocEntryIds:['unit-1'] },
      selectedChunks:[{
        chunkId:'chunk-hidden-123', rank:1, page:12, unit:'운동과 에너지',
        content:'속력이 변하면 가속도가 생긴다.', source:'semantic', similarity:0.91,
      }],
      createdAt:'2026-07-26T00:00:03Z',
    },
    providerInvocations:[{
      id:'invocation-direction-1', itemAttempt:1, stage:'DIRECTION', state:'COMPLETED',
      provider:'gemini', modelId:'gemini-test',
      requestSnapshot:{ system:'선수관계 방향을 설계하라.', prompt:'1번 문항 검색 방향을 JSON으로 반환하라.', maxOutputTokens:2048 },
      responseSnapshot:{ text:'{"searchQuery":"속력과 가속도"}' },
      rawResponse:{ candidates:[{ finishReason:'STOP' }] },
      requestId:'provider-request-1', modelSnapshot:'gemini-test-20260727',
      finishReason:'STOP', inputTokens:120, outputTokens:30, latencyMs:456,
      error:null, startedAt:'2026-07-26T00:00:01Z', completedAt:'2026-07-26T00:00:02Z',
    }],
    pagination:{ limit:20, offset:0, total:21, nextOffset:20 },
  }, {
    batchId,
    itemId:'item-1',
    latestRetrieval:{
      id:'retrieval-1', attempt:1, queryText:'속력과 가속도의 선수 관계',
      candidateScope:{ tocEntryIds:['unit-1'] },
      selectedChunks:[{
        chunkId:'chunk-hidden-123', rank:1, page:12, unit:'운동과 에너지',
        content:'속력이 변하면 가속도가 생긴다.', source:'semantic', similarity:0.91,
      }],
      createdAt:'2026-07-26T00:00:03Z',
    },
    providerInvocations:[{
      id:'invocation-question-1', itemAttempt:1, stage:'QUESTION', state:'COMPLETED',
      provider:'gemini', modelId:'gemini-test',
      requestSnapshot:{ system:'교과서 근거만 사용하라.', prompt:'실제 문항을 생성하라.', maxOutputTokens:8192 },
      responseSnapshot:{ text:'{"questionText":"가속도를 설명하라"}' },
      rawResponse:{ candidates:[{ finishReason:'STOP' }], page:2 },
      requestId:'provider-request-2', modelSnapshot:'gemini-test-20260727',
      finishReason:'STOP', inputTokens:240, outputTokens:90, latencyMs:654,
      error:null, startedAt:'2026-07-26T00:00:03Z', completedAt:'2026-07-26T00:00:05Z',
    }],
    pagination:{ limit:20, offset:20, total:21, nextOffset:null },
  }];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/generation/${batchId}/items/item-1/audit`)) {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0);
      return { ok:true, json:async () => auditPages[offset === 0 ? 0 : 1] };
    }
    return { ok:true, json:async () => activity };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<GenerationWorkspace sources={[]} batches={[activity.batch]} />);

  const direction = await screen.findByRole('listitem', { name:'방향성 설계 단계' });
  expect(direction).toHaveTextContent('2/2 완료');
  const retrieval = screen.getByRole('listitem', { name:'문항별 근거 검색 단계' });
  expect(retrieval).toHaveTextContent('1/2 완료');
  expect(retrieval).toHaveTextContent('1 진행');
  const generation = screen.getByRole('listitem', { name:'질문·답안 생성 단계' });
  expect(generation).toHaveTextContent('1/2 완료');

  expect(screen.getByText('속력 개념에서 가속도 관계를 추론')).toBeInTheDocument();
  expect(screen.getByText('속력과 가속도의 선수 관계')).toBeInTheDocument();
  expect(screen.getByText('선택 근거 1개')).toBeInTheDocument();
  expect(screen.getByText('실제 모델 호출 2건')).toBeInTheDocument();
  expect(screen.getAllByText(/중단 0/)).toHaveLength(2);
  expect(screen.queryByText('운동과 에너지')).not.toBeInTheDocument();
  expect(screen.queryByText('선수관계 방향을 설계하라.')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/audit'))).toBe(false);

  const itemDetails = screen.getByText('1번 문항', { selector:'strong' }).closest('details')!;
  itemDetails.open = true;
  fireEvent(itemDetails, new Event('toggle'));

  expect(await screen.findByText('운동과 에너지')).toBeInTheDocument();
  expect(screen.getByText('p.12')).toBeInTheDocument();
  expect(screen.getByText('chunk-hidden-123')).toBeInTheDocument();
  expect(screen.getByText('실제 방향성 프롬프트')).toBeInTheDocument();
  expect(screen.getByText('선수관계 방향을 설계하라.')).toBeInTheDocument();
  expect(screen.getByText('1번 문항 검색 방향을 JSON으로 반환하라.')).toBeInTheDocument();
  expect(screen.getByText('{"searchQuery":"속력과 가속도"}')).toBeInTheDocument();
  expect(screen.getByText('Provider 원시 응답')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/generation/${batchId}/items/item-1/audit?limit=20&offset=0`,
    { cache:'no-store' },
  );

  fireEvent.click(screen.getByRole('button', { name:'모델 호출 더 보기' }));
  expect(await screen.findByText('실제 문항을 생성하라.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/generation/${batchId}/items/item-1/audit?limit=20&offset=20`,
    { cache:'no-store' },
  );
});

test('question generation ignores an old audit response after switching A to B and back to A', async () => {
  class EventSourceStub { addEventListener() {} removeEventListener() {} close() {} }
  vi.stubGlobal('EventSource', EventSourceStub);
  const batchA = 'batch-a-111';
  const batchB = 'batch-b-222';
  const activityFor = (batchId: string, direction: string) => ({
    batch: {
      id:batchId, state:'RUNNING', requested_count:1,
      created_at:'2026-07-26T00:00:00Z',
      conditions:{ executionMode:'parallel' },
      progress:{ completedQuestions:0, failedQuestions:0 },
    },
    job:{ state:'LEASED', attempts:1, max_attempts:3, last_error_code:null, last_error_message:null },
    events:[],
    questions:[],
    canResume:false,
    eventCursor:'0',
    items:[{
      id:'shared-item', ordinal:1, state:'RUNNING', attempts:1, retryable:true,
      direction:{ directionSummary:direction },
      error:null, latestRetrieval:null,
      providerInvocationSummary:{ total:1, requested:0, completed:1, failed:0, abandoned:0 },
      questionId:null, questionPublicId:null,
      startedAt:'2026-07-26T00:00:00Z', completedAt:null, updatedAt:'2026-07-26T00:00:01Z',
    }],
  });
  const activityA = activityFor(batchA, 'A 방향');
  const activityB = activityFor(batchB, 'B 방향');
  let resolveOldAudit!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  const oldAudit = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(
    (resolve) => { resolveOldAudit = resolve; },
  );
  let auditACalls = 0;
  const auditPage = (prompt: string) => ({
    batchId:batchA,
    itemId:'shared-item',
    latestRetrieval:null,
    providerInvocations:[{
      id:`invocation-${prompt}`, itemAttempt:1, stage:'DIRECTION', state:'COMPLETED',
      provider:'gemini', modelId:'gemini-test',
      requestSnapshot:{ system:'system', prompt },
      responseSnapshot:{ text:'response' }, rawResponse:{ marker:prompt },
      requestId:null, modelSnapshot:null, finishReason:'STOP',
      inputTokens:1, outputTokens:1, latencyMs:1, error:null,
      startedAt:'2026-07-26T00:00:00Z', completedAt:'2026-07-26T00:00:01Z',
    }],
    pagination:{ limit:20, offset:0, total:1, nextOffset:null },
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/generation/${batchA}/items/shared-item/audit`)) {
      auditACalls += 1;
      if (auditACalls === 1) return oldAudit;
      return { ok:true, json:async () => auditPage('FRESH_A_PROMPT') };
    }
    if (url.includes(`/api/generation/${batchA}/activity`)) {
      return { ok:true, json:async () => activityA };
    }
    if (url.includes(`/api/generation/${batchB}/activity`)) {
      return { ok:true, json:async () => activityB };
    }
    return { ok:true, json:async () => ({ items:[activityA.batch, activityB.batch] }) };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<GenerationWorkspace sources={[]} batches={[activityA.batch, activityB.batch]} />);
  await screen.findByText('A 방향');
  const firstItem = screen.getByText('1번 문항', { selector:'strong' }).closest('details')!;
  firstItem.open = true;
  fireEvent(firstItem, new Event('toggle'));
  await waitFor(() => expect(auditACalls).toBe(1));

  fireEvent.click(screen.getByRole('button', { name:/batch-b-/ }));
  await screen.findByText('B 방향');
  fireEvent.click(screen.getByRole('button', { name:/batch-a-/ }));
  await screen.findByText('A 방향');
  const currentItem = screen.getByText('1번 문항', { selector:'strong' }).closest('details')!;
  currentItem.open = true;
  fireEvent(currentItem, new Event('toggle'));
  expect(await screen.findByText('FRESH_A_PROMPT')).toBeInTheDocument();

  resolveOldAudit({ ok:true, json:async () => auditPage('STALE_A_PROMPT') });
  await waitFor(() => expect(auditACalls).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText('STALE_A_PROMPT')).not.toBeInTheDocument();
  expect(screen.getByText('FRESH_A_PROMPT')).toBeInTheDocument();
});

test('question generation selects every textbook unit and submits parallel mode', async () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const tocIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ id: '44444444-4444-4444-8444-444444444444', state: 'QUEUED', progress: {} }) };
    return { ok: true, json: async () => ({ items: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<GenerationWorkspace sources={[{
    id: sourceId, original_name: 'science.pdf', subject: '과학', grade: '중학교 2학년',
    tocEntries: [
      { id: tocIds[0]!, source_file_id: sourceId, title: '물질의 구성', level: 1, printed_page: 12 },
      { id: tocIds[1]!, source_file_id: sourceId, title: '전기와 자기', level: 1, printed_page: 44 },
    ],
  }]} batches={[]} />);

  fireEvent.click(screen.getByLabelText('science.pdf 전체 단원 선택'));
  expect(screen.getByLabelText('물질의 구성')).toBeChecked();
  expect(screen.getByLabelText('전기와 자기')).toBeChecked();
  expect(screen.getByLabelText('교과서 science.pdf')).toBeChecked();
  expect(screen.getByLabelText('생성 방식')).toHaveValue('parallel');
  fireEvent.click(screen.getByRole('button', { name: '문항 생성 시작' }));

  await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true));
  const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
  const body = JSON.parse(String(post[1]?.body));
  expect(body).toMatchObject({ sourceFileIds: [sourceId], tocEntryIds: tocIds, executionMode: 'parallel' });
});

test('question generation exposes durable item errors and resumes only unfinished work', async () => {
  const batchId = '44444444-4444-4444-8444-444444444444';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/resume') && init?.method === 'POST') {
      return { ok: true, json: async () => ({ state: 'QUEUED', resumeSequence: 2 }) };
    }
    if (url.endsWith('/activity')) {
      return {
        ok: true,
        json: async () => ({
          batch: {
            id: batchId,
            state: 'FAILED',
            requested_count: 3,
            conditions: { executionMode: 'parallel' },
            progress: { completedQuestions: 2, failedQuestions: 1, error: '일부 문항 실패' },
          },
          job: {
            state: 'TERMINAL_FAILED',
            attempts: 3,
            max_attempts: 3,
            last_error_code: 'GENERATION_ITEMS_INCOMPLETE',
            last_error_message: '일부 문항 실패',
          },
          events: [],
          questions: [],
          canResume: true,
          items: [{
            id: 'item-2',
            ordinal: 2,
            state: 'FAILED',
            attempts: 1,
            retryable: true,
            direction: { directionSummary: '선수관계 적용' },
            error: { code: 'MODEL_TIMEOUT', message: '모델 응답 제한 시간 초과', retryable: true },
            latestRetrieval: {
              id: 'retrieval-2',
              attempt: 1,
              queryText: '속도 가속도 선수관계',
              candidateScope: {},
              selectedChunks: [],
              createdAt: '2026-07-26T00:00:00Z',
            },
            questionId: null,
            questionPublicId: null,
            startedAt: '2026-07-26T00:00:00Z',
            completedAt: null,
            updatedAt: '2026-07-26T00:00:01Z',
          }],
        }),
      };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<GenerationWorkspace sources={[]} batches={[{
    id: batchId,
    state: 'FAILED',
    requested_count: 3,
    created_at: '2026-07-26T00:00:00Z',
    progress: { completedQuestions: 2, failedQuestions: 1 },
  }]} />);

  expect(await screen.findByText('문항별 실행 기록')).toBeInTheDocument();
  expect(screen.getByText('2번 문항')).toBeInTheDocument();
  expect(screen.getByText(/MODEL_TIMEOUT/)).toBeInTheDocument();
  expect(screen.getByText('모델 응답 제한 시간 초과')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '미완료 문항 생성 재개' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/generation/${batchId}/resume`,
    { method: 'POST' },
  ));
  expect(await screen.findByText(/재개 순번 2/)).toBeInTheDocument();
});

test('review workspace keeps question, rubric, and evidence visible together', () => {
  render(<ReviewWorkspace questions={[]} />);
  expect(screen.getByRole('heading', { name: '질문 검수' })).toBeInTheDocument();
  expect(screen.getByText('문항·모범 답안')).toBeInTheDocument();
  expect(screen.getByText('원자 채점 기준')).toBeInTheDocument();
  expect(screen.getByText('교과서 근거')).toBeInTheDocument();
});

test('dataset workspace starts with explicit editable question-set management', () => {
  render(<DatasetWorkspace approvedQuestionIds={['q-1', 'q-2']} workingDistribution={{ capabilities: { '핵심 개념 이해': 1, '개념 적용·문제풀이': 1 }, responseFormats: { '구조화 서술형': 2 }, evidenceModes: { GROUNDED: 2 } }} versions={[]} />);
  expect(screen.getByRole('heading', { name: '데이터셋 관리' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '편집 가능한 질문 세트' })).toBeInTheDocument();
  expect(screen.getByLabelText('새 질문 세트 이름')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '벤치마크 데이터셋 발행' })).toBeDisabled();
  expect(screen.getByRole('heading', { name: '불변 버전' })).toBeInTheDocument();
});
