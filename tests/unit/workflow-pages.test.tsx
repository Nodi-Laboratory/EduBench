// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { GenerationWorkspace } from '@/components/generation/generation-workspace';
import { ReviewWorkspace } from '@/components/review/review-workspace';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { SourcesWorkspace } from '@/components/sources/sources-workspace';

afterEach(cleanup);

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
  render(<DatasetWorkspace approvedCount={382} versions={[]} />);
  expect(screen.getByRole('heading', { name: '데이터셋 관리' })).toBeInTheDocument();
  expect(screen.getByText('핵심 개념 이해')).toBeInTheDocument();
  expect(screen.getByText('150')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '불변 버전' })).toBeInTheDocument();
});
