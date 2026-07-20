// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { ReviewWorkspace } from '@/components/review/review-workspace';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { SourcesWorkspace } from '@/components/sources/sources-workspace';
import { DocumentLabWorkspace } from '@/components/document-lab/document-lab-workspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('document lab exposes its exact parser settings before upload', () => {
  render(<DocumentLabWorkspace />);
  expect(screen.getByRole('heading', { name: 'Document Lab' })).toBeInTheDocument();
  expect(screen.getByLabelText('테스트 파일')).toBeInTheDocument();
  expect(screen.getByText('Enhanced')).toBeInTheDocument();
  expect(screen.getByText('ocr=force')).toBeInTheDocument();
  expect(screen.getByText("base64_encoding=['footnote']")).toBeInTheDocument();
  expect(screen.getByText("output_formats=['html']")).toBeInTheDocument();
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
  expect(screen.getByRole('button', { name: 'Page 01' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByAltText('원본 페이지 1')).toHaveAttribute('src', responseBody.pages[0].dataUrl);

  fireEvent.click(screen.getByRole('button', { name: 'Page 02' }));
  expect(screen.getByRole('button', { name: 'Page 02' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByAltText('원본 페이지 2')).toHaveAttribute('src', responseBody.pages[1].dataUrl);
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute('sandbox', '');
  expect(screen.getByTitle('변환 HTML 페이지 2')).toHaveAttribute('srcdoc', '<h1>둘째 페이지</h1>');

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

test('document lab locks file controls while parsing and shows an actionable server error', async () => {
  let resolveFetch!: (value: { ok: boolean; json: () => Promise<{ message: string }> }) => void;
  const fetchPromise = new Promise<{ ok: boolean; json: () => Promise<{ message: string }> }>((resolve) => {
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

  resolveFetch({ ok: false, json: async () => ({ message: 'UPSTAGE_API_KEY is required.' }) });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('UPSTAGE_API_KEY is required.');
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

test('question generation exposes source scope and the nine-stage pipeline', () => {
  render(<GenerationWorkspace sources={[]} batches={[]} />);
  expect(screen.getByRole('heading', { name: '질문 생성' })).toBeInTheDocument();
  expect(screen.getByLabelText('교과서 파일')).toBeInTheDocument();
  expect(screen.getByText('9단계 생성 파이프라인')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '문항 생성 시작' })).toBeInTheDocument();
});

test('review workspace keeps question, rubric, and evidence visible together', () => {
  render(<ReviewWorkspace questions={[]} />);
  expect(screen.getByRole('heading', { name: '질문 검수' })).toBeInTheDocument();
  expect(screen.getByText('문항·모범 답안')).toBeInTheDocument();
  expect(screen.getByText('원자 채점 기준')).toBeInTheDocument();
  expect(screen.getByText('교과서 근거')).toBeInTheDocument();
});

test('dataset workspace shows exact target distributions and immutable versions', () => {
  render(<DatasetWorkspace approvedQuestionIds={Array.from({ length: 382 }, (_, index) => `q-${index}`)} versions={[]} />);
  expect(screen.getByRole('heading', { name: '데이터셋 관리' })).toBeInTheDocument();
  expect(screen.getByText('핵심 개념 이해')).toBeInTheDocument();
  expect(screen.getByText('150')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '불변 버전' })).toBeInTheDocument();
});
