import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { seedDatabase } from '../../scripts/seed';
import { POST as reviewQuestion } from '@/app/api/questions/[id]/review/route';
import { POST as freezeDataset } from '@/app/api/datasets/route';

beforeAll(async () => {
  await migrate();
  await seedDatabase();
});

afterAll(async () => {
  await db.end();
});

test('edit-and-approve creates a new revision and an audit action', async () => {
  const questionId = randomUUID();
  const publicId = `TEST-Q-${questionId.slice(0, 8)}`;
  await db.query(
    `insert into questions(
       id, public_id, status, subject, grade, purpose, difficulty, question_type, evidence_mode
     ) values ($1, $2, 'IN_REVIEW', '과학', '중학교 2학년', '핵심 개념 이해', '중', '서술형', 'GROUNDED')`,
    [questionId, publicId],
  );
  await db.query(
    `insert into question_revisions(
       question_id, revision, question_text, answer_text, scoring_criteria
     ) values ($1, 1, '초안 질문', '초안 답안', '[{"key":"concept","maxScore":1}]')`,
    [questionId],
  );

  const response = await reviewQuestion(
    new Request(`http://localhost/api/questions/${questionId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'EDIT_AND_APPROVE',
        questionText: '수정된 질문',
        answerText: '수정된 답안',
        scoringCriteria: [{ key: 'concept', label: '핵심 개념', maxScore: 1 }],
        note: '표현 편향 제거',
      }),
    }),
    { params: Promise.resolve({ id: questionId }) },
  );

  expect(response.status).toBe(200);
  const stored = await db.query<{ status: string; current_revision: number }>(
    'select status, current_revision from questions where id = $1', [questionId],
  );
  const revision = await db.query<{ question_text: string }>(
    'select question_text from question_revisions where question_id = $1 and revision = 2', [questionId],
  );
  expect(stored.rows[0]).toEqual({ status: 'APPROVED', current_revision: 2 });
  expect(revision.rows[0]?.question_text).toBe('수정된 질문');
});

test('freezes the available approved real questions with their actual count and stable hash', async () => {
  const ids: string[] = [];
  for (const purpose of ['핵심 개념 이해', '개념 적용·문제풀이']) {
    const id = randomUUID();
    ids.push(id);
    await db.query(
      `insert into questions(id,public_id,status,subject,grade,purpose,difficulty,question_type,evidence_mode)
       values($1,$2,'APPROVED','과학','고등학교 1학년',$3,'중','구조화 서술형','GROUNDED')`,
      [id, `REAL-Q-${id.slice(0, 8)}`, purpose],
    );
    await db.query(
      `insert into question_revisions(question_id,revision,question_text,answer_text,scoring_criteria)
       values($1,1,$2,'실제 답안','[{"key":"accuracy","maxScore":1}]')`,
      [id, `${purpose} 실제 질문`],
    );
  }
  const version = `test-${randomUUID().slice(0, 8)}`;
  const requestBody = { version, title: '통합 테스트 데이터셋', questionIds: ids };

  const first = await freezeDataset(new Request('http://localhost/api/datasets', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  }));
  const second = await freezeDataset(new Request('http://localhost/api/datasets', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  }));
  const firstBody = await first.json();
  const secondBody = await second.json();

  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  expect(secondBody).toMatchObject({ id: firstBody.id, contentHash: firstBody.contentHash, existing: true });
  const stored = await db.query<{ question_count: number; distribution: { capabilities: Record<string, number> } }>(
    'select question_count,distribution from dataset_versions where id=$1', [firstBody.id],
  );
  expect(stored.rows[0]?.question_count).toBe(2);
  expect(stored.rows[0]?.distribution.capabilities).toMatchObject({ '핵심 개념 이해': 1, '개념 적용·문제풀이': 1 });
  await expect(db.query(
    `update dataset_versions set title = '변조' where id = $1`, [firstBody.id],
  )).rejects.toThrow(/immutable/i);
});
