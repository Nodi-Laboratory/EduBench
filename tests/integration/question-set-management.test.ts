import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { POST as createQuestionSet } from '@/app/api/question-sets/route';
import { DELETE as deleteQuestionSet } from '@/app/api/question-sets/[id]/route';
import { DELETE as removeQuestionFromSet } from '@/app/api/question-sets/[id]/questions/[questionId]/route';
import { POST as publishQuestionSet } from '@/app/api/question-sets/[id]/publish/route';
import { POST as reviewQuestion } from '@/app/api/questions/[id]/review/route';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.end();
});

async function insertReviewQuestion(label: string) {
  const id = randomUUID();
  await db.query(
    `insert into questions(
       id,public_id,status,subject,grade,purpose,difficulty,question_type,evidence_mode
     ) values($1,$2,'IN_REVIEW','과학','중학교 2학년','선수 관계 적용','상','구조화 서술형','GROUNDED')`,
    [id, `SET-${label}-${id.slice(0, 8)}`],
  );
  await db.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,scoring_criteria
     ) values($1,1,$2,$3,'[{"key":"relation","maxScore":1}]'::jsonb)`,
    [id, `${label} 질문`, `${label} 답안`],
  );
  return id;
}

test('approval atomically pins the approved revision into an existing question set', async () => {
  const createResponse = await createQuestionSet(new Request('http://localhost/api/question-sets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '과학 선수관계 세트', description: '통합 테스트' }),
  }));
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json();
  const questionId = await insertReviewQuestion('기존세트');

  const reviewResponse = await reviewQuestion(
    new Request(`http://localhost/api/questions/${questionId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'EDIT_AND_APPROVE',
        questionText: '수정된 선수관계 질문',
        answerText: '수정된 선수관계 답안',
        scoringCriteria: [{ key: 'relation', label: '관계', maxScore: 1 }],
        targetSet: { kind: 'existing', id: created.item.id },
      }),
    }),
    { params: Promise.resolve({ id: questionId }) },
  );

  expect(reviewResponse.status).toBe(200);
  const membership = await db.query<{
    question_revision: number;
    ordinal: number;
  }>(
    `select question_revision,ordinal from question_set_questions
     where question_set_id=$1 and question_id=$2`,
    [created.item.id, questionId],
  );
  expect(membership.rows[0]).toEqual({ question_revision: 2, ordinal: 1 });
  const audit = await db.query<{ metadata: { questionSetId?: string } }>(
    `select metadata from review_actions where question_id=$1 order by created_at desc limit 1`,
    [questionId],
  );
  expect(audit.rows[0]?.metadata.questionSetId).toBe(created.item.id);
});

test('a new set can be created during approval', async () => {
  const questionId = await insertReviewQuestion('새세트');
  const reviewResponse = await reviewQuestion(
    new Request(`http://localhost/api/questions/${questionId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'APPROVE',
        targetSet: { kind: 'new', title: '승인 중 만든 세트' },
      }),
    }),
    { params: Promise.resolve({ id: questionId }) },
  );
  expect(reviewResponse.status).toBe(200);
  const body = await reviewResponse.json();
  expect(body.questionSet).toMatchObject({ title: '승인 중 만든 세트', questionCount: 1 });
});

test('approval rolls back a newly created set and membership when audit persistence fails', async () => {
  const failedQuestionId = await insertReviewQuestion('롤백');
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_review_audit_failure_${suffix}`;
  const triggerName = `test_review_audit_failure_trigger_${suffix}`;
  const countBefore = await db.query<{ count: string }>(
    `select count(*) from question_sets where title='생기면 안 되는 세트'`,
  );
  try {
    await db.query(`
      create function ${functionName}()
      returns trigger language plpgsql as $$
      begin
        if new.question_id = '${failedQuestionId}'::uuid then
          raise exception 'forced review action persistence failure';
        end if;
        return new;
      end
      $$;
      create trigger ${triggerName}
      before insert on review_actions
      for each row execute function ${functionName}();
    `);
    await expect(reviewQuestion(
      new Request(`http://localhost/api/questions/${failedQuestionId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'APPROVE',
          targetSet: { kind: 'new', title: '생기면 안 되는 세트' },
        }),
      }),
      { params: Promise.resolve({ id: failedQuestionId }) },
    )).rejects.toThrow(/forced review action persistence failure/);

    const countAfter = await db.query<{ count: string }>(
      `select count(*) from question_sets where title='생기면 안 되는 세트'`,
    );
    const question = await db.query<{
      status: string;
      current_revision: number;
    }>(
      'select status,current_revision from questions where id=$1',
      [failedQuestionId],
    );
    const audit = await db.query<{ count: string }>(
      'select count(*) from review_actions where question_id=$1',
      [failedQuestionId],
    );
    expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count);
    expect(question.rows[0]).toEqual({
      status: 'IN_REVIEW',
      current_revision: 1,
    });
    expect(audit.rows[0]?.count).toBe('0');
  } finally {
    await db.query(`drop trigger if exists ${triggerName} on review_actions`);
    await db.query(`drop function if exists ${functionName}()`);
  }
});

test('editable set membership can change without mutating its published dataset snapshot', async () => {
  const createResponse = await createQuestionSet(new Request('http://localhost/api/question-sets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '발행 테스트 세트' }),
  }));
  const setId = (await createResponse.json()).item.id as string;
  const firstQuestionId = await insertReviewQuestion('발행1');
  const secondQuestionId = await insertReviewQuestion('발행2');
  for (const questionId of [firstQuestionId, secondQuestionId]) {
    const response = await reviewQuestion(
      new Request(`http://localhost/api/questions/${questionId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'APPROVE',
          targetSet: { kind: 'existing', id: setId },
        }),
      }),
      { params: Promise.resolve({ id: questionId }) },
    );
    expect(response.status).toBe(200);
  }

  const version = `set-publish-${randomUUID().slice(0, 8)}`;
  const publishResponse = await publishQuestionSet(
    new Request(`http://localhost/api/question-sets/${setId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, title: '발행된 통합 테스트 데이터셋' }),
    }),
    { params: Promise.resolve({ id: setId }) },
  );
  expect(publishResponse.status).toBe(201);
  const published = await publishResponse.json();
  expect(published).toMatchObject({ version, questionCount: 2 });

  const removeResponse = await removeQuestionFromSet(
    new Request(`http://localhost/api/question-sets/${setId}/questions/${firstQuestionId}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id: setId, questionId: firstQuestionId }) },
  );
  expect(removeResponse.status).toBe(200);
  const remainingSetItems = await db.query<{ count: string }>(
    'select count(*) from question_set_questions where question_set_id=$1',
    [setId],
  );
  const snapshotItems = await db.query<{ count: string }>(
    'select count(*) from dataset_questions where dataset_version_id=$1',
    [published.id],
  );
  expect(remainingSetItems.rows[0]?.count).toBe('1');
  expect(snapshotItems.rows[0]?.count).toBe('2');

  const deleteResponse = await deleteQuestionSet(
    new Request(`http://localhost/api/question-sets/${setId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: setId }) },
  );
  expect(deleteResponse.status).toBe(200);
  const deleted = await db.query<{ deleted_at: string | null }>(
    'select deleted_at::text from question_sets where id=$1',
    [setId],
  );
  expect(deleted.rows[0]?.deleted_at).not.toBeNull();
  expect(snapshotItems.rows[0]?.count).toBe('2');
});

test('concurrent publishes of the same manifest return one created and one existing dataset', async () => {
  const firstSetResponse = await createQuestionSet(new Request('http://localhost/api/question-sets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '동시 발행 원본 세트' }),
  }));
  const secondSetResponse = await createQuestionSet(new Request('http://localhost/api/question-sets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '동시 발행 복제 세트' }),
  }));
  const firstSetId = (await firstSetResponse.json()).item.id as string;
  const secondSetId = (await secondSetResponse.json()).item.id as string;
  const questionId = await insertReviewQuestion('동시발행');
  const approval = await reviewQuestion(
    new Request(`http://localhost/api/questions/${questionId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'APPROVE',
        targetSet: { kind: 'existing', id: firstSetId },
      }),
    }),
    { params: Promise.resolve({ id: questionId }) },
  );
  expect(approval.status).toBe(200);
  await db.query(
    `insert into question_set_questions(
       question_set_id,question_id,question_revision,ordinal
     )
     select $1,question_id,question_revision,ordinal
       from question_set_questions
      where question_set_id=$2`,
    [secondSetId, firstSetId],
  );

  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_publish_race_${suffix}`;
  const triggerName = `test_publish_race_trigger_${suffix}`;
  const advisoryClass = 82_623_642;
  const advisoryObject = Math.floor(Math.random() * 1_000_000_000) + 1;
  const blocker = await db.connect();
  let advisoryLocked = false;
  try {
    await blocker.query(
      'select pg_advisory_lock($1,$2)',
      [advisoryClass, advisoryObject],
    );
    advisoryLocked = true;
    await db.query(`
      create function ${functionName}()
      returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(${advisoryClass},${advisoryObject});
        return new;
      end
      $$;
      create trigger ${triggerName}
      before insert on dataset_versions
      for each row execute function ${functionName}();
    `);

    const version = `set-race-${randomUUID().slice(0, 8)}`;
    const publish = (setId: string) => publishQuestionSet(
      new Request(`http://localhost/api/question-sets/${setId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, title: '동시 발행 데이터셋' }),
      }),
      { params: Promise.resolve({ id: setId }) },
    );
    const pending = Promise.allSettled([
      publish(firstSetId),
      publish(secondSetId),
    ]);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiting = await blocker.query<{ count: string }>(
        `select count(*) count
           from pg_locks
          where locktype='advisory'
            and classid=$1
            and objid=$2
            and granted=false`,
        [advisoryClass, advisoryObject],
      );
      if (Number(waiting.rows[0]?.count) === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const waiting = await blocker.query<{ count: string }>(
      `select count(*) count
         from pg_locks
        where locktype='advisory'
          and classid=$1
          and objid=$2
          and granted=false`,
      [advisoryClass, advisoryObject],
    );
    expect(waiting.rows[0]?.count).toBe('2');

    await blocker.query(
      'select pg_advisory_unlock($1,$2)',
      [advisoryClass, advisoryObject],
    );
    advisoryLocked = false;
    const settled = await pending;
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    const statuses = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value.status;
    }).sort();
    expect(statuses).toEqual([200, 201]);
    const datasetCount = await db.query<{ count: string }>(
      'select count(*) from dataset_versions where version=$1',
      [version],
    );
    expect(datasetCount.rows[0]?.count).toBe('1');
  } finally {
    if (advisoryLocked) {
      await blocker.query(
        'select pg_advisory_unlock($1,$2)',
        [advisoryClass, advisoryObject],
      );
    }
    await db.query(`drop trigger if exists ${triggerName} on dataset_versions`);
    await db.query(`drop function if exists ${functionName}()`);
    blocker.release();
  }
});
