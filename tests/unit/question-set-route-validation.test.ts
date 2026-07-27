import { expect, test, vi } from 'vitest';

vi.mock('@/server/question-sets/service', () => ({
  softDeleteQuestionSet: vi.fn(async () => ({ id: 'set-id' })),
  removeQuestionFromSet: vi.fn(async () => ({ removedQuestionId: 'question-id' })),
  publishQuestionSet: vi.fn(async () => ({
    id: 'dataset-id',
    version: 'science-v1',
    title: '과학 데이터셋',
    questionCount: 1,
    contentHash: 'a'.repeat(64),
    existing: false,
  })),
}));

import { DELETE as deleteQuestionSet } from '@/app/api/question-sets/[id]/route';
import { DELETE as removeQuestionFromSet } from '@/app/api/question-sets/[id]/questions/[questionId]/route';
import { POST as publishQuestionSet } from '@/app/api/question-sets/[id]/publish/route';

const validUuid = '11111111-1111-4111-8111-111111111111';

test.each([
  {
    name: 'question-set deletion id',
    invoke: () => deleteQuestionSet(
      new Request('http://localhost/api/question-sets/not-a-uuid', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    ),
  },
  {
    name: 'question-set member parent id',
    invoke: () => removeQuestionFromSet(
      new Request(`http://localhost/api/question-sets/not-a-uuid/questions/${validUuid}`, {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({
          id: 'not-a-uuid',
          questionId: validUuid,
        }),
      },
    ),
  },
  {
    name: 'question-set member question id',
    invoke: () => removeQuestionFromSet(
      new Request(`http://localhost/api/question-sets/${validUuid}/questions/not-a-uuid`, {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({
          id: validUuid,
          questionId: 'not-a-uuid',
        }),
      },
    ),
  },
  {
    name: 'question-set publication id',
    invoke: () => publishQuestionSet(
      new Request('http://localhost/api/question-sets/not-a-uuid/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 'science-v1',
          title: '과학 데이터셋',
        }),
      }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    ),
  },
])('returns 400 JSON for a malformed $name', async ({ invoke }) => {
  const response = await invoke();

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    code: 'INVALID_QUESTION_SET_PATH',
    issues: expect.any(Array),
  });
});
