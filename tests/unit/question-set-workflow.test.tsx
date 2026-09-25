// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReviewWorkspace } from '@/components/review/review-workspace';
import { DatasetWorkspace } from '@/components/datasets/dataset-workspace';
import { RunWorkspace } from '@/components/runs/run-workspace';
import type { AuditQuestion } from '@/server/datasets/audit';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reviewQuestion = {
  id: 'question-1',
  public_id: 'Q-SET-1',
  status: 'IN_REVIEW',
  subject: '과학',
  grade: '중학교 2학년',
  purpose: '선수 관계 적용',
  difficulty: '상',
  question_text: '전하의 이동과 전류의 관계를 설명하시오.',
  answer_text: '전류는 전하의 이동이다.',
  scoring_criteria: [{ key: 'relation', label: '관계 설명', maxScore: 1 }],
  evidence_summary: '전하가 이동하면 전류가 흐른다.',
  quality_scores: {},
};

function auditQuestion(): AuditQuestion {
  return {
    id: 'question-1',
    publicId: 'Q-SET-1',
    ordinal: 1,
    status: 'APPROVED',
    subject: '과학',
    grade: '중학교 2학년',
    chapter: '전기',
    unit: '전류',
    purpose: '선수 관계 적용',
    difficulty: '상',
    questionType: '구조화 서술형',
    evidenceMode: 'GROUNDED',
    revision: 1,
    currentRevision: 1,
    revisionDrift: false,
    questionText: '전하의 이동과 전류의 관계를 설명하시오.',
    answerText: '전류는 전하의 이동이다.',
    answerOptions: [],
    acceptedAnswers: [],
    scoringCriteria: [{ key: 'relation', label: '관계 설명', maxScore: 1 }],
    designSummary: null,
    evidenceSummary: null,
    qualityScores: {},
    benchmarkDesign: null,
    evidence: [],
    generation: {
      batchId: null,
      provider: null,
      model: null,
      promptVersion: null,
      embeddingModel: null,
    },
    createdAt: '2026-07-27T00:00:00Z',
  };
}

function auditListPage(total = 1) {
  const item = auditQuestion();
  return {
    items: [auditListItem(item)],
    page: 1, pageSize: 20, total,
  };
}

function auditListItem(item:AuditQuestion) {
  return {
    id: item.id, publicId: item.publicId, ordinal: item.ordinal, status: item.status,
    subject: item.subject, grade: item.grade, chapter: item.chapter, unit: item.unit,
    purpose: item.purpose, difficulty: item.difficulty, questionType: item.questionType,
    evidenceMode: item.evidenceMode, revision: item.revision, currentRevision: item.currentRevision,
    revisionDrift: item.revisionDrift, questionSummary: item.questionText,
  };
}

function emptyAuditPage(total = 0) {
  return { items: [], page: 1, pageSize: 20, total };
}

function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

test('dataset workspace keeps selected-set JSON export as a direct download', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => emptyAuditPage(),
  })));

  render(<DatasetWorkspace
    questionSets={[{
      id: 'set-1',
      title: '내보낼 세트',
      description: 'React에는 메타데이터만 전달',
      questionCount: 125,
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:00Z',
    }]}
    versions={[]}
  />);

  const exportControl = screen.getByRole('link', {
    name: '선택 세트 JSON',
  });
  expect(exportControl).toHaveAttribute(
    'href',
    '/api/question-sets/set-1/export',
  );
  expect(exportControl).toHaveAttribute('download');
});

test('review approval sends the selected question set with the review decision', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return {
      ok: true,
      json: async () => ({ id: 'question-1', status: 'APPROVED', revision: 1 }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<ReviewWorkspace
    questions={[reviewQuestion]}
    questionSets={[
      { id: 'set-1', title: '과학 선수관계 세트', description: null, questionCount: 2 },
      { id: 'set-2', title: '한국사 인과관계 세트', description: null, questionCount: 3 },
    ]}
  />);

  fireEvent.change(screen.getByLabelText('승인할 질문 세트'), {
    target: { value: 'set-2' },
  });
  fireEvent.click(screen.getByRole('button', { name: '승인' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(request.body))).toMatchObject({
    action: 'APPROVE',
    targetSet: { kind: 'existing', id: 'set-2' },
  });
});

test('review can create a named question set while approving', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return {
      ok: true,
      json: async () => ({
        id: 'question-1',
        status: 'APPROVED',
        revision: 1,
        questionSet: { id: 'set-new', title: '새 과학 세트', questionCount: 1 },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<ReviewWorkspace questions={[reviewQuestion]} questionSets={[]} />);
  fireEvent.click(screen.getByRole('button', { name: '새 세트에 승인' }));
  fireEvent.change(screen.getByLabelText('새 질문 세트 이름'), {
    target: { value: '새 과학 세트' },
  });
  fireEvent.click(screen.getByRole('button', { name: '승인' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(request.body))).toMatchObject({
    action: 'APPROVE',
    targetSet: { kind: 'new', title: '새 과학 세트' },
  });
});

test('review reports request failures and re-enables its actions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network unavailable');
  }));

  render(<ReviewWorkspace
    questions={[reviewQuestion]}
    questionSets={[
      { id: 'set-1', title: '과학 선수관계 세트', description: null, questionCount: 1 },
    ]}
  />);

  const approveButton = screen.getByRole('button', { name: '승인' });
  fireEvent.click(approveButton);

  expect(await screen.findByRole('status')).toHaveTextContent(
    /검수 작업을 저장하지 못했습니다/,
  );
  expect(approveButton).not.toBeDisabled();
});

test('dataset workspace creates, deletes, and removes questions from editable sets', async () => {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/datasets/audit')) {
      return { ok: true, json: async () => auditListPage(1) };
    }
    if (input === '/api/question-sets' && init?.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          item: {
            id: 'set-new',
            title: '신규 연구 세트',
            description: null,
            questionCount: 0,
            createdAt: '2026-07-27T00:00:00Z',
            updatedAt: '2026-07-27T00:00:00Z',
            questions: [],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));

  render(<DatasetWorkspace
    approvedQuestionIds={[]}
    workingDistribution={{ capabilities: {}, responseFormats: {}, evidenceModes: {} }}
    workingQuestions={[]}
    questionSets={[{
      id: 'set-1',
      title: '과학 선수관계 세트',
      description: '전기 단원',
      questionCount: 1,
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:00Z',
      questions: [auditQuestion()],
    }]}
    versions={[]}
  />);

  expect(screen.getByRole('heading', { name: '편집 가능한 질문 세트' })).toBeInTheDocument();
  expect(await screen.findByText(/Q-SET-1/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Q-SET-1 세트에서 제거' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/question-sets/set-1/questions/question-1',
    { method: 'DELETE' },
  ));
  expect(screen.getByRole('tab', { name: '미분류 승인 문항 (1)' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '과학 선수관계 세트 삭제' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/question-sets/set-1',
    { method: 'DELETE' },
  ));

  fireEvent.change(screen.getByLabelText('새 질문 세트 이름'), {
    target: { value: '신규 연구 세트' },
  });
  fireEvent.click(screen.getByRole('button', { name: '질문 세트 생성' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/question-sets',
    expect.objectContaining({ method: 'POST' }),
  ));
});

test('removing a question keeps it classified while another active set contains it', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/datasets/audit')) {
      return { ok: true, json: async () => auditListPage(0) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<DatasetWorkspace
    approvedQuestionIds={[]}
    workingDistribution={{ capabilities: {}, responseFormats: {}, evidenceModes: {} }}
    workingQuestions={[]}
    questionSets={[
      {
        id: 'set-1',
        title: '선택 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        questions: [auditQuestion()],
      },
      {
        id: 'set-2',
        title: '다른 활성 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        questions: [auditQuestion()],
      },
    ]}
    versions={[]}
  />);

  fireEvent.click(await screen.findByRole('button', { name: 'Q-SET-1 세트에서 제거' }));

  await screen.findByText('Q-SET-1 문항을 세트에서 제거했습니다.');
  expect(screen.getByRole('tab', { name: '미분류 승인 문항 (0)' })).toBeInTheDocument();
});

test('removing a question refreshes the current first page and totals', async () => {
  let setPageReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('scope=set')) {
      setPageReads += 1;
      return {
        ok: true,
        json: async () => setPageReads === 1
          ? auditListPage(1)
          : emptyAuditPage(),
      };
    }
    if (url.includes('scope=unassigned')) {
      return { ok: true, json: async () => emptyAuditPage(1) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<DatasetWorkspace
    unassignedQuestionCount={0}
    questionSets={[{
      id: 'set-1',
      title: '첫 페이지 세트',
      description: null,
      questionCount: 1,
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:00Z',
    }]}
    versions={[]}
  />);

  fireEvent.click(await screen.findByRole(
    'button',
    { name: 'Q-SET-1 세트에서 제거' },
  ));

  await screen.findByText('Q-SET-1 문항을 세트에서 제거했습니다.');
  await waitFor(() => {
    expect(screen.queryByRole(
      'button',
      { name: 'Q-SET-1 세트에서 제거' },
    )).not.toBeInTheDocument();
  });
  expect(screen.getByRole(
    'tab',
    { name: '현재 질문 세트 (0)' },
  )).toBeInTheDocument();
  expect(screen.getByRole(
    'tab',
    { name: '미분류 승인 문항 (1)' },
  )).toBeInTheDocument();
  expect(screen.getByText('1 / 1 · 0문항')).toBeInTheDocument();
});

test('deleting a set keeps shared questions classified by remaining active sets', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('scope=unassigned')) {
      return { ok: true, json: async () => emptyAuditPage() };
    }
    if (url.startsWith('/api/datasets/audit')) {
      return { ok: true, json: async () => auditListPage(1) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));

  render(<DatasetWorkspace
    approvedQuestionIds={[]}
    workingDistribution={{ capabilities: {}, responseFormats: {}, evidenceModes: {} }}
    workingQuestions={[]}
    questionSets={[
      {
        id: 'set-1',
        title: '삭제 대상 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        questions: [auditQuestion()],
      },
      {
        id: 'set-2',
        title: '유지할 활성 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        questions: [auditQuestion()],
      },
    ]}
    versions={[]}
  />);

  fireEvent.click(screen.getByRole('button', { name: '삭제 대상 세트 삭제' }));

  await screen.findByText('질문 세트 “삭제 대상 세트”을 삭제했습니다.');
  expect(screen.getByRole('tab', { name: '미분류 승인 문항 (0)' })).toBeInTheDocument();
  expect(screen.getByText(/Q-SET-1/)).toBeInTheDocument();
});

test('deleting another set refreshes the current scope and unassigned total', async () => {
  let setPageReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('scope=set')) {
      setPageReads += 1;
      return {
        ok: true,
        json: async () => setPageReads === 1
          ? auditListPage(1)
          : emptyAuditPage(),
      };
    }
    if (url.includes('scope=unassigned')) {
      return { ok: true, json: async () => emptyAuditPage(2) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));

  render(<DatasetWorkspace
    unassignedQuestionCount={0}
    questionSets={[
      {
        id: 'set-1',
        title: '현재 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      },
      {
        id: 'set-2',
        title: '삭제할 다른 세트',
        description: null,
        questionCount: 1,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
      },
    ]}
    versions={[]}
  />);

  await screen.findByText(/Q-SET-1/);
  fireEvent.click(screen.getByRole(
    'button',
    { name: '삭제할 다른 세트 삭제' },
  ));

  await screen.findByText('질문 세트 “삭제할 다른 세트”을 삭제했습니다.');
  await waitFor(() => {
    expect(screen.queryByRole(
      'button',
      { name: 'Q-SET-1 세트에서 제거' },
    )).not.toBeInTheDocument();
  });
  expect(screen.getByRole(
    'tab',
    { name: '미분류 승인 문항 (2)' },
  )).toBeInTheDocument();
  expect(screen.getByText('1 / 1 · 0문항')).toBeInTheDocument();
});

test('dataset reports response parsing failures and re-enables set creation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => {
      throw new Error('invalid JSON');
    },
  })));

  render(<DatasetWorkspace
    approvedQuestionIds={[]}
    workingDistribution={{ capabilities: {}, responseFormats: {}, evidenceModes: {} }}
    workingQuestions={[]}
    questionSets={[]}
    versions={[]}
  />);

  fireEvent.change(screen.getByLabelText('새 질문 세트 이름'), {
    target: { value: '복구 가능한 세트' },
  });
  const createButton = screen.getByRole('button', { name: '질문 세트 생성' });
  fireEvent.click(createButton);

  expect(await screen.findByRole('status')).toHaveTextContent(
    /질문 세트를 만들지 못했습니다/,
  );
  expect(createButton).not.toBeDisabled();
});

test('switching and closing dataset question details aborts stale requests and evicts prior detail', async () => {
  const firstQuestion = {
    ...auditQuestion(),
    questionText:'첫 문항 요약',
  };
  const secondQuestion = {
    ...auditQuestion(),
    id:'question-2',
    publicId:'Q-SET-2',
    ordinal:2,
    questionText:'둘째 문항 요약',
  };
  const listPage = {
    items:[auditListItem(firstQuestion), auditListItem(secondQuestion)],
    page:1,
    pageSize:20,
    total:2,
  };
  const firstRequest = deferred<{
    ok:boolean;
    json:() => Promise<{ item:AuditQuestion }>;
  }>();
  const secondRequest = deferred<{
    ok:boolean;
    json:() => Promise<{ item:AuditQuestion }>;
  }>();
  let secondDetailCalls = 0;
  const fetchMock = vi.fn((
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    const url = String(input);
    if (url.includes('questionId=question-1')) return firstRequest.promise;
    if (url.includes('questionId=question-2')) {
      secondDetailCalls += 1;
      return secondDetailCalls === 1
        ? secondRequest.promise
        : Promise.resolve({
          ok:true,
          json:async () => ({
            item:{ ...secondQuestion, questionText:'FRESH-DATASET-DETAIL' },
          }),
        });
    }
    void init;
    return Promise.resolve({ ok:true, json:async () => listPage });
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<DatasetWorkspace
    questionSets={[{
      id:'set-1',
      title:'감사 세트',
      description:null,
      questionCount:2,
      createdAt:'2026-07-27T00:00:00Z',
      updatedAt:'2026-07-27T00:00:00Z',
    }]}
    versions={[]}
  />);

  await screen.findByText(/Q-SET-1/);
  fireEvent.click(screen.getByText(/Q-SET-1/));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('questionId=question-1'),
  )).toBe(true));
  const firstCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('questionId=question-1'),
  )!;
  const firstSignal = firstCall[1]?.signal as AbortSignal | undefined;
  expect(firstSignal).toBeInstanceOf(AbortSignal);

  fireEvent.click(screen.getByText(/Q-SET-2/));
  await waitFor(() => expect(secondDetailCalls).toBe(1));
  expect(firstSignal?.aborted).toBe(true);
  const secondCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('questionId=question-2'),
  )!;
  const secondSignal = secondCall[1]?.signal as AbortSignal | undefined;
  expect(secondSignal).toBeInstanceOf(AbortSignal);

  fireEvent.click(screen.getByText(/Q-SET-2/));
  await waitFor(() => expect(secondSignal?.aborted).toBe(true));

  await act(async () => {
    firstRequest.resolve({
      ok:true,
      json:async () => ({
        item:{ ...firstQuestion, questionText:'STALE-FIRST-DETAIL' },
      }),
    });
    secondRequest.resolve({
      ok:true,
      json:async () => ({
        item:{ ...secondQuestion, questionText:'STALE-SECOND-DETAIL' },
      }),
    });
    await Promise.resolve();
  });
  expect(screen.queryByText('STALE-FIRST-DETAIL')).not.toBeInTheDocument();
  expect(screen.queryByText('STALE-SECOND-DETAIL')).not.toBeInTheDocument();

  fireEvent.click(screen.getByText(/Q-SET-2/));
  expect(await screen.findByText('FRESH-DATASET-DETAIL')).toBeInTheDocument();
  expect(secondDetailCalls).toBe(2);
});

test.each(['page', 'filter'] as const)(
  'changing the dataset %s aborts the active question detail request',
  async (change) => {
    const question = auditQuestion();
    const detailRequest = deferred<{
      ok:boolean;
      json:() => Promise<{ item:AuditQuestion }>;
    }>();
    const listPage = {
      items:[auditListItem(question)],
      page:1,
      pageSize:20,
      total:21,
    };
    const fetchMock = vi.fn((
      input:RequestInfo | URL,
      init?:RequestInit,
    ) => {
      void init;
      if (String(input).includes('questionId=question-1')) {
        return detailRequest.promise;
      }
      return Promise.resolve({ ok:true, json:async () => listPage });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DatasetWorkspace
      questionSets={[{
        id:'set-1',
        title:'감사 세트',
        description:null,
        questionCount:21,
        createdAt:'2026-07-27T00:00:00Z',
        updatedAt:'2026-07-27T00:00:00Z',
      }]}
      versions={[]}
    />);
    await screen.findByText(/Q-SET-1/);
    fireEvent.click(screen.getByText(/Q-SET-1/));
    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url).includes('questionId=question-1'),
    )).toBe(true));
    const detailCall = fetchMock.mock.calls.find(
      ([url]) => String(url).includes('questionId=question-1'),
    )!;
    const signal = detailCall[1]?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);

    if (change === 'page') {
      fireEvent.click(screen.getByRole('button', { name:'다음' }));
    } else {
      fireEvent.change(screen.getByLabelText('문항 검색'), {
        target:{ value:'새 필터' },
      });
    }
    await waitFor(() => expect(signal?.aborted).toBe(true));
  },
);

test('unmounting the dataset workspace aborts the active question detail request', async () => {
  const detailRequest = deferred<{
    ok:boolean;
    json:() => Promise<{ item:AuditQuestion }>;
  }>();
  const fetchMock = vi.fn((
    input:RequestInfo | URL,
    init?:RequestInit,
  ) => {
    void init;
    if (String(input).includes('questionId=question-1')) {
      return detailRequest.promise;
    }
    return Promise.resolve({ ok:true, json:async () => auditListPage() });
  });
  vi.stubGlobal('fetch', fetchMock);

  const { unmount } = render(<DatasetWorkspace
    questionSets={[{
      id:'set-1',
      title:'감사 세트',
      description:null,
      questionCount:1,
      createdAt:'2026-07-27T00:00:00Z',
      updatedAt:'2026-07-27T00:00:00Z',
    }]}
    versions={[]}
  />);
  await screen.findByText(/Q-SET-1/);
  fireEvent.click(screen.getByText(/Q-SET-1/));
  await waitFor(() => expect(fetchMock.mock.calls.some(
    ([url]) => String(url).includes('questionId=question-1'),
  )).toBe(true));
  const detailCall = fetchMock.mock.calls.find(
    ([url]) => String(url).includes('questionId=question-1'),
  )!;
  const signal = detailCall[1]?.signal as AbortSignal | undefined;
  expect(signal).toBeInstanceOf(AbortSignal);

  unmount();
  expect(signal?.aborted).toBe(true);
});

test('run setup updates the question limit and manifest when another dataset is selected', () => {
  render(<RunWorkspace
    datasets={[
      {
        id: 'dataset-1',
        version: 'science-v1',
        title: '과학 데이터셋',
        description: '과학 10문항',
        question_count: 10,
        content_hash: 'a'.repeat(64),
        published_at: '2026-07-26T00:00:00Z',
      },
      {
        id: 'dataset-2',
        version: 'history-v1',
        title: '한국사 데이터셋',
        description: '한국사 24문항',
        question_count: 24,
        content_hash: 'b'.repeat(64),
        published_at: '2026-07-27T00:00:00Z',
      },
    ]}
    scoreProfiles={[{ id: 'profile-1', version: 'score-v1', title: '평가' }]}
    providers={[{
      provider_key: 'gemini',
      display_name: 'Gemini',
      protocol: 'gemini',
      modelId: 'gemini-test',
      configured: true,
      requestIntervalMs: 0,
    }]}
    modelProfile={{
      id: 'model-profile-1',
      version: 'benchmark-models-v1',
      contentHash: 'c'.repeat(64),
    }}
    initialRuns={[]}
  />);

  fireEvent.change(screen.getByLabelText('사용 데이터셋'), {
    target: { value: 'dataset-2' },
  });
  expect(screen.getByLabelText('문항 수')).toHaveValue(24);
  expect(screen.getByText('한국사 24문항')).toBeInTheDocument();
  expect(screen.getByText('history-v1')).toBeInTheDocument();
});

test('run setup cannot submit when there is no published dataset', () => {
  render(<RunWorkspace
    datasets={[]}
    scoreProfiles={[{ id: 'profile-1', version: 'score-v1', title: '평가' }]}
    providers={[{
      provider_key: 'gemini',
      display_name: 'Gemini',
      protocol: 'gemini',
      modelId: 'gemini-test',
      configured: true,
      requestIntervalMs: 0,
    }]}
    modelProfile={{
      id: 'model-profile-1',
      version: 'benchmark-models-v1',
      contentHash: 'c'.repeat(64),
    }}
    initialRuns={[]}
  />);

  expect(screen.getByText(/실행 가능한 데이터셋이 없습니다/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '실행 초안 생성' })).toBeDisabled();
});

test('run setup reports request failures and allows retrying submission', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network unavailable');
  }));

  render(<RunWorkspace
    datasets={[{
      id: 'dataset-1',
      version: 'science-v1',
      title: '과학 데이터셋',
      question_count: 10,
    }]}
    scoreProfiles={[{ id: 'profile-1', version: 'score-v1', title: '평가' }]}
    providers={[{
      provider_key: 'gemini',
      display_name: 'Gemini',
      protocol: 'gemini',
      modelId: 'gemini-test',
      configured: true,
      requestIntervalMs: 0,
    }]}
    modelProfile={{
      id: 'model-profile-1',
      version: 'benchmark-models-v1',
      contentHash: 'c'.repeat(64),
    }}
    initialRuns={[]}
  />);

  fireEvent.click(screen.getByRole('button', { name: '실행 초안 생성' }));

  expect(await screen.findByText(/실행을 만들지 못했습니다/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '실행 초안 생성' })).not.toBeDisabled();
});
