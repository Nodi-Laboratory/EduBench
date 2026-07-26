// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SettingsWorkspace } from '@/components/settings/settings-workspace';
import type { ResearchConfigProfilesData } from '@/components/settings/research-settings-workspace';
import { defaultResearchConfigDefinitions } from '@/domain/research-config';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const documentDefinition = {
  schemaVersion: 1 as const,
  kind: 'document_parse' as const,
  version: 'parser-study-v1',
  title: '교과서 정밀 파싱',
  description: '표와 수식을 손실 없이 추출해 파싱 설정 변화의 영향을 비교하는 연구 프로필입니다.',
  applyScope: '활성화 이후 새 교과서 파싱과 Document Lab 요청에 적용됩니다.',
  reprocessingImpact: '기존 교과서에 반영하려면 전체 문서를 다시 파싱해야 합니다.',
  settings: {
    provider: 'upstage' as const,
    model: 'document-parse',
    mode: 'enhanced' as const,
    ocr: 'force' as const,
    outputFormat: 'html' as const,
    base64Encoding: ['table', 'figure', 'chart', 'equation'] as Array<
      'table' | 'figure' | 'chart' | 'equation'
    >,
    rasterization: { format: 'png' as const, lossless: true as const, dpi: 300 },
    pagesPerBatch: 8,
    pageConcurrency: 6,
    requestTimeoutMs: 120_000,
  },
};

const documentProfiles = {
  items: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'document_parse' as const,
      version: 'parser-study-v1',
      title: '교과서 정밀 파싱',
      definition: documentDefinition,
      contentHash: '4a6cf8c5dd6b4a6cf8c5dd6b4a6cf8c5dd6b4a6cf8c5dd6b4a6cf8c5dd6b4a6c',
      createdAt: '2026-07-26T00:00:00.000Z',
      active: true,
    },
  ],
  activeByKind: {
    document_parse: '00000000-0000-4000-8000-000000000001',
  },
};

function renderSettings(researchProfiles: ResearchConfigProfilesData) {
  render(
    <SettingsWorkspace
      providers={[]}
      scores={[]}
      prices={[]}
      mockMode={false}
      {...{ researchProfiles }}
    />,
  );
}

const completeResearchProfiles: ResearchConfigProfilesData = {
  items: defaultResearchConfigDefinitions.map((definition, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    kind: definition.kind,
    version: definition.version,
    title: definition.title,
    definition,
    contentHash: String(index + 1).repeat(64),
    createdAt: '2026-07-26T00:00:00.000Z',
    active: true,
  })),
  activeByKind: Object.fromEntries(defaultResearchConfigDefinitions.map((definition, index) => [
    definition.kind,
    `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  ])),
};

test('research settings show four preset-first cards and the active profile audit data', () => {
  renderSettings(documentProfiles);

  expect(screen.getByRole('heading', { name: '연구 실행 설정' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Document Parse' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '임베딩 / RAG' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '질문 생성' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '벤치마크 모델' })).toBeInTheDocument();

  const parserCard = screen.getByTestId('research-config-card-document_parse');
  expect(within(parserCard).getByTestId('active-research-version')).toHaveTextContent('parser-study-v1');
  expect(within(parserCard).getByText('document-parse')).toBeInTheDocument();
  expect(within(parserCard).getByText(documentDefinition.applyScope)).toBeInTheDocument();
  expect(within(parserCard).getByText(documentDefinition.reprocessingImpact)).toBeInTheDocument();
  expect(within(parserCard).getByText(/4a6cf8c5dd6b/)).toBeInTheDocument();
  expect(within(parserCard).getByTestId('research-settings-json')).toHaveTextContent('"pageConcurrency": 6');

  expect(screen.getAllByText('등록된 프로필 없음')).toHaveLength(3);
});

test('researcher can activate an existing immutable profile without reloading the page', async () => {
  const secondDefinition = {
    ...documentDefinition,
    version: 'parser-study-v2',
    title: '안정성 비교 파싱',
    settings: { ...documentDefinition.settings, pageConcurrency: 2 },
  };
  const researchProfiles = {
    items: [
      ...documentProfiles.items,
      {
        ...documentProfiles.items[0],
        id: '00000000-0000-4000-8000-000000000002',
        version: secondDefinition.version,
        title: secondDefinition.title,
        definition: secondDefinition,
        contentHash: 'b'.repeat(64),
        active: false,
      },
    ],
    activeByKind: documentProfiles.activeByKind,
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      active: {
        kind: 'document_parse',
        profileId: '00000000-0000-4000-8000-000000000002',
        activatedAt: '2026-07-26T01:00:00.000Z',
      },
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderSettings(researchProfiles);

  fireEvent.change(screen.getByLabelText('Document Parse 프로필 버전'), {
    target: { value: '00000000-0000-4000-8000-000000000002' },
  });
  fireEvent.click(within(screen.getByTestId('research-config-card-document_parse'))
    .getByRole('button', { name: '선택 버전 활성화' }));

  await waitFor(() => {
    expect(screen.getByTestId('research-config-card-document_parse'))
      .toHaveTextContent('활성 프로필 · parser-study-v2');
  });
  expect(fetchMock).toHaveBeenCalledWith('/api/settings/research-profiles', expect.objectContaining({
    method: 'PATCH',
    body: JSON.stringify({
      kind: 'document_parse',
      profileId: '00000000-0000-4000-8000-000000000002',
    }),
  }));
});

test('advanced JSON editor exposes strict API issue paths instead of hiding validation errors', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    json: async () => ({
      code: 'INVALID_RESEARCH_PROFILE',
      issues: [{
        path: ['settings', 'base64Encoding'],
        message: 'table, figure, chart, equation을 각각 한 번씩 포함해야 합니다.',
      }],
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  renderSettings(documentProfiles);

  fireEvent.click(within(screen.getByTestId('research-config-card-document_parse'))
    .getByText('새 버전 JSON 편집'));
  const editor = screen.getByLabelText('Document Parse 새 버전 JSON');
  fireEvent.change(editor, {
    target: {
      value: JSON.stringify({
        ...documentDefinition,
        version: 'parser-study-invalid',
        settings: { ...documentDefinition.settings, base64Encoding: ['table'] },
      }),
    },
  });
  fireEvent.click(within(screen.getByTestId('research-config-card-document_parse'))
    .getByRole('button', { name: '새 버전 저장' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'settings.base64Encoding: table, figure, chart, equation을 각각 한 번씩 포함해야 합니다.',
  );
});

test('structured controls expose parser and embedding settings and only update the immutable-version JSON draft', () => {
  renderSettings(completeResearchProfiles);

  const parserCard = screen.getByTestId('research-config-card-document_parse');
  const parserDpi = within(parserCard).getByLabelText('페이지 렌더링 DPI');
  expect(parserDpi).toHaveValue(300);
  expect(within(parserCard).getByText(/높을수록 작은 글자와 수식 인식에 유리/)).toBeInTheDocument();

  fireEvent.change(parserDpi, { target: { value: '360' } });
  const parserDraft = JSON.parse(
    (within(parserCard).getByLabelText('Document Parse 새 버전 JSON') as HTMLTextAreaElement).value,
  );
  expect(parserDraft.settings.rasterization.dpi).toBe(360);
  expect(within(parserCard).getByText('PNG · 300 DPI')).toBeInTheDocument();

  const embeddingCard = screen.getByTestId('research-config-card-embedding_rag');
  const vectorDimensions = within(embeddingCard).getByLabelText('벡터 차원');
  expect(vectorDimensions).toHaveValue(3072);
  expect(vectorDimensions).not.toHaveAttribute('readonly');
  expect(vectorDimensions).toHaveAttribute('min', '128');
  expect(vectorDimensions).toHaveAttribute('max', '3072');
  expect(within(embeddingCard).getByLabelText('검색 후보 수(topK)')).toHaveValue(12);
  expect(within(embeddingCard).getByText(/128~3072 범위에서 저장 비용과 검색 품질/))
    .toBeInTheDocument();
  expect(within(embeddingCard).getByText(/topK를 높이면 더 많은 후보 근거를 비교/))
    .toBeInTheDocument();

  fireEvent.change(vectorDimensions, { target:{ value:'768' } });
  const embeddingDraft = JSON.parse(
    (within(embeddingCard).getByLabelText(
      '임베딩 / RAG 새 버전 JSON',
    ) as HTMLTextAreaElement).value,
  );
  expect(embeddingDraft.settings).toMatchObject({
    dimensions:768,
    vectorSpaceId:'gemini-embedding-2:768:text-prefix-prerequisite-rag-v1',
  });
});

test('structured controls expose question token budgets and concurrency with operational help', () => {
  renderSettings(completeResearchProfiles);

  const questionCard = screen.getByTestId('research-config-card-question_generation');
  expect(within(questionCard).getByLabelText('방향 생성 출력 토큰')).toHaveValue(2048);
  expect(within(questionCard).getByLabelText('질문 생성 출력 토큰')).toHaveValue(16384);
  expect(within(questionCard).getByLabelText('질문 생성 동시성')).toHaveValue(4);
  expect(within(questionCard).getByText(/문항별 방향성 설계 응답의 최대 길이/)).toBeInTheDocument();
  expect(within(questionCard).getByText(/높이면 생성 속도는 빨라지지만 API 동시 요청량/))
    .toBeInTheDocument();
});

test('structured benchmark controls expose each model runtime and generation parameters', () => {
  renderSettings(completeResearchProfiles);

  const benchmarkCard = screen.getByTestId('research-config-card-benchmark_models');
  expect(within(benchmarkCard).getByLabelText('Gemini 3.6 Flash 모델 ID'))
    .toHaveValue('gemini-3.6-flash');
  expect(within(benchmarkCard).getByLabelText('Gemini 3.6 Flash 최대 출력 토큰'))
    .toHaveValue(16384);
  expect(within(benchmarkCard).getByLabelText('Upstage Solar Pro 3 Temperature'))
    .toHaveValue(0.7);
  expect(within(benchmarkCard).getByLabelText('K-EXAONE 236B A23B 요청 간격(ms)'))
    .toHaveValue(30000);
  expect(within(benchmarkCard).getAllByText(/모델별 호출 동시성은 공급자 한도와 실행 속도/))
    .toHaveLength(3);
  expect(within(benchmarkCard).getAllByText(/출력 토큰 한도는 응답 잘림과 비용에 직접 영향/))
    .toHaveLength(3);
});

test('temporarily incomplete advanced JSON hides structured controls without crashing the editor', () => {
  renderSettings(documentProfiles);
  const parserCard = screen.getByTestId('research-config-card-document_parse');
  const editor = within(parserCard).getByLabelText('Document Parse 새 버전 JSON');

  fireEvent.change(editor, {
    target: {
      value: JSON.stringify({
        ...documentDefinition,
        settings: {
          provider: 'upstage',
          rasterization: { format: 'png', lossless: true, dpi: 300 },
        },
      }),
    },
  });

  expect(within(parserCard).getByText(/JSON 문법과 kind\/settings 구조가 올바르면/))
    .toBeInTheDocument();
  expect((editor as HTMLTextAreaElement).value).toContain('"provider":"upstage"');
});
