// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { SettingsWorkspace } from '@/components/settings/settings-workspace';
import type { AuditQuestion, DatasetAuditVersion, QuestionSetAudit } from '@/server/datasets/audit';

afterEach(cleanup);

function question(overrides: Partial<AuditQuestion> = {}): AuditQuestion {
  return {
    id: 'question-1', publicId: 'Q-RESEARCH-1', ordinal: null, status: 'APPROVED', subject: '과학', grade: '중2',
    chapter: '전기', unit: '전류', purpose: '선수 관계 적용', difficulty: '상', questionType: '구조화 서술형',
    evidenceMode: 'GROUNDED', revision: 2, currentRevision: 2, revisionDrift: false,
    questionText: '전하의 이동을 이용해 전류를 설명하시오.', answerText: '전류는 전하의 이동이다.',
    answerOptions: [], acceptedAnswers: ['전하의 이동'],
    scoringCriteria: [{ key: 'prerequisite_application', label: '선수 개념 적용', maxScore: 1 }],
    designSummary: '전하에서 전류로 이어지는 선수관계를 측정한다.', evidenceSummary: '전하 이동에 관한 교과서 설명',
    qualityScores: { pipelineComplete: true },
    benchmarkDesign: {
      benchmarkType: 'PREREQUISITE_RELATIONSHIP', taskType: 'dependency_application', targetConcept: '전류',
      prerequisiteConcepts: [{ concept: '전하', role: '전류 이해에 선행', evidenceChunkIds: ['chunk-1'] }],
      prerequisiteRelations: [{ fromConcept: '전하', toConcept: '전류', relationType: 'REQUIRES', explanation: '전하 이동이 전류를 이룬다.', evidenceChunkIds: ['chunk-1'] }],
      requiredReasoningSteps: ['전하의 이동을 확인한다.', '이를 전류 개념에 적용한다.'],
      failureSignals: ['전하를 언급하지 않고 전류만 정의한다.'],
    },
    evidence: [{
      chunkId: 'chunk-1', ordinal: 1, role: 'prerequisite', quote: '전하가 이동하면 전류가 흐른다.',
      content: '전하가 이동하면 전류가 흐른다.', sourceName: 'science.pdf', pageStart: 12, pageEnd: 13,
      chapter: '전기', unit: '전류', sourceRevision: 1, parseModel: 'document-parse', parseRequestId: 'parse-1',
    }],
    generation: { batchId: 'batch-1', provider: 'gemini', model: 'gemini-2.5-pro', promptVersion: 'question-v3', embeddingModel: 'embedding-query' },
    createdAt: '2026-07-22T00:00:00Z', ...overrides,
  };
}

test('dataset workspace exposes working and immutable question research audits', () => {
  const pinned = question({ ordinal: 1, revision: 1, currentRevision: 2, revisionDrift: true, questionText: '고정 revision 질문' });
  const versions: DatasetAuditVersion[] = [{
    id: 'dataset-1', version: 'research-v1', status: 'PUBLISHED', title: '연구 데이터셋', description: '재현성 검증 버전',
    questionCount: 1, distribution: { capabilities: { '선수 관계 적용': 1 } }, contentHash: 'abcdef1234567890',
    parentVersion: null, publishedAt: '2026-07-22T00:00:00Z', questions: [pinned],
  }];
  const questionSets: QuestionSetAudit[] = [{
    id: 'set-1', title: '과학 선수관계 세트', description: '검수된 편집 세트',
    questionCount: 1, createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
    questions: [question({ ordinal: 1 })],
  }];
  render(<DatasetWorkspace
    approvedQuestionIds={['question-1']}
    workingDistribution={{ capabilities: { '선수 관계 적용': 1 }, responseFormats: { '구조화 서술형': 1 }, evidenceModes: { GROUNDED: 1 } }}
    workingQuestions={[]}
    questionSets={questionSets}
    versions={versions}
  />);

  expect(screen.getByRole('heading', { name: '문항 연구 감사' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /현재 질문 세트/ })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('문항 검색'), { target: { value: '전하' } });
  expect(screen.getByText(/Q-RESEARCH-1/)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/Q-RESEARCH-1/));
  expect(screen.getByText('선수관계 청사진')).toBeInTheDocument();
  expect(screen.getByText('필수 추론 단계')).toBeInTheDocument();
  expect(screen.getByText('교과서 근거')).toBeInTheDocument();
  expect(screen.getByText('생성 provenance')).toBeInTheDocument();
  expect(screen.getByText('science.pdf')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /불변 버전/ }));
  expect(screen.getAllByText('research-v1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('고정 revision 질문').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/고정 revision 1/).length).toBeGreaterThan(0);
  expect(screen.getByText(/현재 revision 2와 다릅니다/)).toBeInTheDocument();
});

test('settings workspace explains score profile metrics, judge flow, and run provenance', () => {
  render(<SettingsWorkspace providers={[]} prices={[]} mockMode={false} scores={[{
    version: 'research-score-v1', title: '선수관계 연구 채점',
    metrics: ['accuracy', 'faithfulness', 'custom_metric'],
    rubric_prompt: '교과서 근거와 benchmarkDesign을 대조하여 각 지표를 절대평가한다.',
    judge_provider: 'gemini', judge_model: 'gemini-2.5-pro', content_hash: 'profile-hash-123',
    created_at: '2026-07-22T00:00:00Z', run_count: 1,
    recent_runs: [{ id: 'run-1', publicId: 'RUN-RESEARCH-1', title: '연구 실행', state: 'COMPLETED', createdAt: '2026-07-22T01:00:00Z' }],
  }]}/>);

  expect(screen.getByRole('heading', { name: '채점 프로필 연구 감사' })).toBeInTheDocument();
  fireEvent.click(screen.getAllByText('research-score-v1')[0]!);
  expect(screen.getByText('평가 처리 흐름')).toBeInTheDocument();
  expect(screen.getAllByText('결정론적 검사').length).toBeGreaterThan(0);
  expect(screen.getByText('교과서 충실성')).toBeInTheDocument();
  expect(screen.getByText('선수 관계 방향 정확성')).toBeInTheDocument();
  expect(screen.getByText('사용자 정의')).toBeInTheDocument();
  expect(screen.getByText(/선수→목표 관계의 방향/)).toBeInTheDocument();
  expect(screen.getByText('전체 Judge 루브릭 프롬프트')).toBeInTheDocument();
  expect(screen.getByText('교과서 근거와 benchmarkDesign을 대조하여 각 지표를 절대평가한다.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /RUN-RESEARCH-1/ })).toHaveAttribute('href', '/runs/run-1');
});
