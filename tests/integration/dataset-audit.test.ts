import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { POST as freezeDataset } from '@/app/api/datasets/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import { getDatasetAuditData } from '@/server/datasets/audit';
import { seedDatabase } from '../../scripts/seed';

beforeAll(async () => { await migrate(); await seedDatabase(); });
afterAll(async () => { await db.end(); });

test('separates current approved revisions from immutable version revisions and preserves research provenance', async () => {
  const chunkId = randomUUID();
  const batchId = randomUUID();
  const questionId = randomUUID();
  const version = `audit-${randomUUID().slice(0, 8)}`;
  const blueprint = {
    benchmarkType: 'PREREQUISITE_RELATIONSHIP',
    taskType: 'dependency_application',
    targetConcept: '전류',
    prerequisiteConcepts: [{ concept: '전하', role: '전류를 설명하는 선수 개념', evidenceChunkIds: [chunkId] }],
    prerequisiteRelations: [{ fromConcept: '전하', toConcept: '전류', relationType: 'REQUIRES', explanation: '전하의 이동으로 전류를 설명한다.', evidenceChunkIds: [chunkId] }],
    requiredReasoningSteps: ['전하의 이동을 식별한다.', '이동량을 전류 판단에 적용한다.'],
    failureSignals: ['전하의 이동 없이 전류의 크기만 단정한다.'],
  };

  await db.query(
    `insert into generation_batches(id,state,requested_count,conditions,source_scope,generation_model,prompt_version,progress)
     values($1,'COMPLETED',1,'{}','{}','gemini-research','question-v3','{}')`, [batchId],
  );
  await db.query(
    `insert into questions(id,public_id,generation_batch_id,status,subject,grade,chapter,unit,purpose,difficulty,question_type,evidence_mode,current_revision,generator_provider,generator_model,embedding_model)
     values($1,$2,$3,'APPROVED','과학','중2','전기','전류','선수 관계 적용','상','구조화 서술형','GROUNDED',1,'gemini','gemini-research','embedding-query')`,
    [questionId, `AUDIT-Q-${questionId.slice(0, 8)}`, batchId],
  );
  await db.query(
    `insert into question_revisions(question_id,revision,question_text,answer_text,answer_options,scoring_criteria,accepted_answers,design_summary,evidence_summary,quality_scores)
     values($1,1,'고정된 질문','고정된 정답','[]','[{"key":"accuracy","label":"정확성","maxScore":1}]','["고정된 정답"]','설계 의도','근거 요약',$2::jsonb)`,
    [questionId, JSON.stringify({ benchmarkDesign: blueprint, pipelineComplete: true })],
  );

  const frozen = await freezeDataset(new Request('http://localhost/api/datasets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version, title: '연구 감사 버전', description: '고정 revision 검증', questionIds: [questionId] }),
  }));
  expect(frozen.status).toBe(201);

  await db.query(
    `insert into question_revisions(question_id,revision,question_text,answer_text,scoring_criteria,accepted_answers,quality_scores)
     values($1,2,'현재 작업 질문','현재 작업 정답','[]','[]',$2::jsonb)`,
    [questionId, JSON.stringify({ benchmarkDesign: blueprint })],
  );
  await db.query('update questions set current_revision=2 where id=$1', [questionId]);

  const audit = await getDatasetAuditData();
  const working = audit.workingQuestions.find((question) => question.id === questionId);
  const immutableVersion = audit.versions.find((entry) => entry.version === version);
  const immutable = immutableVersion?.questions[0];

  expect(immutableVersion?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  expect(working?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  expect(working).toMatchObject({ revision: 2, questionText: '현재 작업 질문', revisionDrift: false });
  expect(immutable).toMatchObject({
    revision: 1, currentRevision: 2, revisionDrift: true, questionText: '고정된 질문',
    generation: { provider: 'gemini', model: 'gemini-research', promptVersion: 'question-v3' },
    benchmarkDesign: {
      targetConcept: '전류',
      prerequisiteConcepts: [{ concept: '전하' }],
      prerequisiteRelations: [{ fromConcept: '전하', toConcept: '전류' }],
      requiredReasoningSteps: ['전하의 이동을 식별한다.', '이동량을 전류 판단에 적용한다.'],
      failureSignals: ['전하의 이동 없이 전류의 크기만 단정한다.'],
    },
  });
  expect(immutable?.evidence).toEqual([]);
});
