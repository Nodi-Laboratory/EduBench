import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { POST as freezeDataset } from '@/app/api/datasets/route';
import { GET as getAudit } from '@/app/api/datasets/audit/route';
import { GET as exportQuestionSet } from '@/app/api/question-sets/[id]/export/route';
import { db } from '@/server/db/pool';
import { migrate } from '@/server/db/migrate';
import {
  openQuestionSetAuditExport,
  getDatasetAuditData,
  getDatasetAuditIndex,
  getDatasetAuditQuestionDetail,
  listDatasetAuditQuestions,
} from '@/server/datasets/audit';
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

test('keeps the audit index and list page bounded while loading raw evidence only for one requested detail', async () => {
  const fixturePrefix = `AUDIT-MEMORY-${randomUUID().slice(0, 8)}`;
  const sourceId = randomUUID();
  const sourceRevisionId = randomUUID();
  const chunkId = randomUUID();
  const rawMarker = `RAW-QUALITY-${randomUUID()}`;
  const evidenceMarker = `EVIDENCE-CONTENT-${randomUUID()}`;
  const questionIds = Array.from({ length: 55 }, () => randomUUID());

  await db.query(
    `insert into source_files(id,sha256,original_name,storage_path,mime_type,byte_size,status)
     values($1,$2,'audit-memory.pdf','fixture','application/pdf',10,'READY')`,
    [sourceId, randomUUID().replaceAll('-', '')],
  );
  await db.query(
    `insert into source_revisions(id,source_file_id,revision,parse_model,parse_request_id)
     values($1,$2,1,'audit-test','audit-request')`,
    [sourceRevisionId, sourceId],
  );
  await db.query(
    `insert into source_chunks(id,source_file_id,source_revision_id,ordinal,content,page_start,chapter,unit)
     values($1,$2,$3,1,$4,12,'감사','메모리')`,
    [chunkId, sourceId, sourceRevisionId, evidenceMarker],
  );
  for (const [index, questionId] of questionIds.entries()) {
    await db.query(
      `insert into questions(
         id,public_id,status,subject,grade,chapter,unit,purpose,difficulty,question_type,evidence_mode,current_revision
       ) values($1,$2,'APPROVED','과학','중2','감사','메모리','선수 관계 적용','상','서술형','GROUNDED',1)`,
      [questionId, `${fixturePrefix}-${String(index + 1).padStart(2, '0')}`],
    );
    await db.query(
      `insert into question_revisions(
         question_id,revision,question_text,answer_text,answer_options,scoring_criteria,accepted_answers,quality_scores
       ) values($1,1,$2,$3,'[]','[]','[]',$4::jsonb)`,
      [
        questionId,
        `메모리 경계 질문 ${index + 1}`,
        `${rawMarker} 정답 ${index + 1}`,
        JSON.stringify({ raw: rawMarker.repeat(20) }),
      ],
    );
  }
  await db.query(
    `insert into question_evidence(question_id,question_revision,source_chunk_id,ordinal,role,quote_text)
     values($1,1,$2,1,'supporting','상세에서만 보여야 하는 인용')`,
    [questionIds[0], chunkId],
  );

  const index = await getDatasetAuditIndex();
  const firstPage = await listDatasetAuditQuestions({
    scope: 'unassigned',
    page: 1,
    pageSize: 500,
    query: fixturePrefix,
  });
  const beyondFinalPage = await listDatasetAuditQuestions({
    scope: 'unassigned',
    page: 3,
    pageSize: 50,
    query: fixturePrefix,
  });

  expect(JSON.stringify(index)).not.toContain(rawMarker);
  expect(index.questionSets.every((set) => !('questions' in set))).toBe(true);
  expect(index.versions.every((version) => !('questions' in version))).toBe(true);
  expect(firstPage).toMatchObject({ page: 1, pageSize: 50, total: 55 });
  expect(firstPage.items).toHaveLength(50);
  expect(firstPage.items[0]).toMatchObject({
    id: questionIds[0],
    questionSummary: '메모리 경계 질문 1',
  });
  expect(JSON.stringify(firstPage)).not.toContain(rawMarker);
  expect(firstPage.items[0]).not.toHaveProperty('qualityScores');
  expect(firstPage.items[0]).not.toHaveProperty('evidence');
  expect(firstPage.items[0]).not.toHaveProperty('answerText');
  expect(beyondFinalPage).toMatchObject({
    page: 3,
    pageSize: 50,
    total: 55,
    items: [],
  });

  const detail = await getDatasetAuditQuestionDetail({
    scope: 'unassigned',
    questionId: questionIds[0]!,
    revision: 1,
  });

  expect(detail).toMatchObject({
    id: questionIds[0],
    answerText: `${rawMarker} 정답 1`,
    qualityScores: { raw: expect.stringContaining(rawMarker) },
    evidence: [{ chunkId, content: evidenceMarker }],
  });

  const listResponse = await getAudit(new Request(
    `http://localhost/api/datasets/audit?scope=unassigned&pageSize=100&query=${encodeURIComponent(fixturePrefix)}`,
  ));
  expect(listResponse.status).toBe(200);
  const listBody = await listResponse.json() as {
    pageSize: number;
    total: number;
    items: Array<Record<string, unknown>>;
  };
  expect(listBody).toMatchObject({ pageSize: 50, total: 55 });
  expect(listBody.items).toHaveLength(50);
  expect(listBody.items[0]).not.toHaveProperty('qualityScores');

  const detailResponse = await getAudit(new Request(
    `http://localhost/api/datasets/audit?scope=unassigned&questionId=${questionIds[0]}&revision=1`,
  ));
  expect(detailResponse.status).toBe(200);
  await expect(detailResponse.json()).resolves.toMatchObject({
    item: { id: questionIds[0], evidence: [{ content: evidenceMarker }] },
  });
});

test.each([
  'scope=set',
  'scope=version',
  `scope=set&questionId=${randomUUID()}&revision=1`,
  `scope=version&questionId=${randomUUID()}&revision=1`,
])('rejects scoped audit query without scopeId: %s', async (query) => {
  const response = await getAudit(new Request(
    `http://localhost/api/datasets/audit?${query}`,
  ));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    code: 'INVALID_DATASET_AUDIT_QUERY',
  });
});

test('searches every legacy audit field before count and pagination', async () => {
  const suffix = randomUUID().slice(0, 8);
  const questionId = randomUUID();
  const markers = {
    publicId: `SEARCH-PUBLIC-${suffix}`,
    question: `질문검색-${suffix}`,
    answer: `답안검색-${suffix}`,
    subject: `과목검색-${suffix}`,
    grade: `학년검색-${suffix}`,
    chapter: `대단원검색-${suffix}`,
    unit: `소단원검색-${suffix}`,
    purpose: `목적검색-${suffix}`,
    targetConcept: `목표개념검색-${suffix}`,
  };
  await db.query(
    `insert into questions(
       id,public_id,status,subject,grade,chapter,unit,purpose,difficulty,
       question_type,evidence_mode,current_revision
     ) values($1,$2,'APPROVED',$3,$4,$5,$6,$7,'상','서술형','GROUNDED',1)`,
    [
      questionId,
      markers.publicId,
      markers.subject,
      markers.grade,
      markers.chapter,
      markers.unit,
      markers.purpose,
    ],
  );
  await db.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,scoring_criteria,
       accepted_answers,quality_scores
     ) values($1,1,$2,$3,'[]'::jsonb,'[]'::jsonb,$4::jsonb)`,
    [
      questionId,
      markers.question,
      markers.answer,
      JSON.stringify({
        benchmarkDesign: { targetConcept: markers.targetConcept },
      }),
    ],
  );

  for (const query of Object.values(markers)) {
    const result = await listDatasetAuditQuestions({
      scope: 'unassigned',
      page: 1,
      pageSize: 1,
      query,
    });
    expect(result).toMatchObject({
      total: 1,
      items: [{ id: questionId }],
    });
  }

  const afterFinalPage = await listDatasetAuditQuestions({
    scope: 'unassigned',
    page: 2,
    pageSize: 1,
    query: markers.answer,
  });
  expect(afterFinalPage).toMatchObject({
    page: 2,
    pageSize: 1,
    total: 1,
    items: [],
  });
});

test('downloads the selected question set with the legacy JSON shape', async () => {
  const setId = randomUUID();
  const questionId = randomUUID();
  const publicId = `EXPORT-Q-${questionId.slice(0, 8)}`;
  await db.query(
    `insert into question_sets(id,title,description)
     values($1,'내보내기 동등성 세트','전체 문항 JSON 계약')`,
    [setId],
  );
  await db.query(
    `insert into questions(
       id,public_id,status,subject,grade,chapter,unit,purpose,difficulty,
       question_type,evidence_mode,current_revision
     ) values(
       $1,$2,'APPROVED','과학','중학교 2학년','전기','전류',
       '선수 관계 적용','상','구조화 서술형','GROUNDED',1
     )`,
    [questionId, publicId],
  );
  await db.query(
    `insert into question_revisions(
       question_id,revision,question_text,answer_text,answer_options,
       scoring_criteria,accepted_answers,design_summary,evidence_summary,
       quality_scores
     ) values(
       $1,1,'내보낼 질문','내보낼 답안','["A","B"]'::jsonb,
       '[{"key":"accuracy","maxScore":1}]'::jsonb,'["정답"]'::jsonb,
       '설계 요약','근거 요약',$2::jsonb
     )`,
    [
      questionId,
      JSON.stringify({
        benchmarkDesign: {
          benchmarkType: 'PREREQUISITE_RELATIONSHIP',
          taskType: 'dependency_application',
          targetConcept: '전류',
          prerequisiteConcepts: [],
          prerequisiteRelations: [],
          requiredReasoningSteps: [],
          failureSignals: [],
        },
      }),
    ],
  );
  await db.query(
    `insert into question_set_questions(
       question_set_id,question_id,question_revision,ordinal
     ) values($1,$2,1,1)`,
    [setId, questionId],
  );

  const response = await exportQuestionSet(
    new Request(`http://localhost/api/question-sets/${setId}/export`),
    { params: Promise.resolve({ id: setId }) },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename="edubench-question-set-${setId}.json"`,
  );

  const body = await response.json() as {
    exportedAt: string;
    questionSet: Record<string, unknown>;
  };
  expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const legacy = await getDatasetAuditData();
  expect(body.questionSet).toEqual(
    legacy.questionSets.find((item) => item.id === setId),
  );
  expect(body.questionSet).toMatchObject({
    id: setId,
    questionCount: 1,
    questions: [{
      id: questionId,
      publicId,
      ordinal: 1,
      questionText: '내보낼 질문',
      answerText: '내보낼 답안',
      benchmarkDesign: { targetConcept: '전류' },
    }],
  });
});

test('streams a question set incrementally from one repeatable-read snapshot', async () => {
  const setId = randomUUID();
  const questionIds = Array.from({ length: 3 }, () => randomUUID());
  const publicPrefix = `STREAM-Q-${randomUUID().slice(0, 8)}`;
  await db.query(
    `insert into question_sets(id,title,description)
     values($1,'스트리밍 스냅샷','배치 사이 변경을 섞지 않는다')`,
    [setId],
  );
  for (const [index, questionId] of questionIds.entries()) {
    await db.query(
      `insert into questions(
         id,public_id,status,subject,grade,purpose,difficulty,
         question_type,evidence_mode,current_revision
       ) values(
         $1,$2,'APPROVED','과학','중학교 2학년','선수 관계 적용',
         '상','서술형','GROUNDED',1
       )`,
      [questionId, `${publicPrefix}-${index + 1}`],
    );
    await db.query(
      `insert into question_revisions(
         question_id,revision,question_text,answer_text,
         answer_options,scoring_criteria,accepted_answers,quality_scores
       ) values($1,1,$2,$3,'[]','[]','[]','{}')`,
      [
        questionId,
        `스냅샷 질문 ${index + 1}`,
        `스냅샷 답안 ${index + 1}`,
      ],
    );
    await db.query(
      `insert into question_set_questions(
         question_set_id,question_id,question_revision,ordinal
       ) values($1,$2,1,$3)`,
      [setId, questionId, index + 1],
    );
  }

  const exportStream = await openQuestionSetAuditExport(setId, {
    batchSize:2,
    exportedAt:'2026-07-30T00:00:00.000Z',
  });
  if (!exportStream) throw new Error('질문 세트 스트림을 열지 못했습니다.');
  const reader = exportStream.body.getReader();
  const decoder = new TextDecoder();
  const chunks:string[] = [];

  for (let index = 0; index < 3; index += 1) {
    const next = await reader.read();
    expect(next.done).toBe(false);
    chunks.push(decoder.decode(next.value, { stream:true }));
  }
  await db.query(
    `update question_revisions
        set question_text='스트림 도중 바뀐 질문'
      where question_id=$1 and revision=1`,
    [questionIds[2]],
  );
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(decoder.decode(next.value, { stream:true }));
  }
  chunks.push(decoder.decode());

  expect(chunks.length).toBeGreaterThan(3);
  const body = JSON.parse(chunks.join('')) as {
    exportedAt:string;
    questionSet:{ questions:Array<{ questionText:string }> };
  };
  expect(body.exportedAt).toBe('2026-07-30T00:00:00.000Z');
  expect(body.questionSet.questions.map((question) => question.questionText))
    .toEqual([
      '스냅샷 질문 1',
      '스냅샷 질문 2',
      '스냅샷 질문 3',
    ]);
});

test('returns audit count and page rows from the same snapshot during a concurrent insert', async () => {
  const prefix = `AUDIT-SNAPSHOT-${randomUUID().slice(0, 8)}`;
  const originalQuestionId = randomUUID();
  const insertedQuestionId = randomUUID();
  const insertQuestion = async (
    client:Pick<PoolClient, 'query'>,
    questionId:string,
    ordinal:number,
  ) => {
    await client.query(
      `insert into questions(
         id,public_id,status,subject,grade,purpose,difficulty,
         question_type,evidence_mode,current_revision
       ) values(
         $1,$2,'APPROVED','과학','중학교 2학년','선수 관계 적용',
         '상','서술형','GROUNDED',1
       )`,
      [questionId, `${prefix}-${ordinal}`],
    );
    await client.query(
      `insert into question_revisions(
         question_id,revision,question_text,answer_text,
         answer_options,scoring_criteria,accepted_answers,quality_scores
       ) values($1,1,$2,'답안','[]','[]','[]','{}')`,
      [questionId, `${prefix} 질문 ${ordinal}`],
    );
  };
  await insertQuestion(db, originalQuestionId, 1);

  const writer = await db.connect();
  let inserted = false;
  const insertBetweenReads = async () => {
    if (inserted) return;
    inserted = true;
    await writer.query('begin');
    try {
      await insertQuestion(writer, insertedQuestionId, 2);
      await writer.query('commit');
    } catch (error) {
      await writer.query('rollback');
      throw error;
    }
  };
  const withSnapshot = async <T>(
    work:(client:PoolClient)=>Promise<T>,
  ):Promise<T> => {
    const client = await db.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const originalQuery = client.query.bind(client);
      const wrappedQuery = async (queryText:string, values?:unknown[]) => {
        const result = await originalQuery(queryText, values);
        if (queryText.includes('select count(*) total')) {
          await insertBetweenReads();
        }
        return result;
      };
      const wrappedClient = new Proxy(client, {
        get(target, property) {
          if (property === 'query') return wrappedQuery;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
      const result = await work(wrappedClient);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };

  try {
    const page = await listDatasetAuditQuestions(
      {
        scope:'unassigned',
        page:1,
        pageSize:10,
        query:prefix,
      },
      {
        withSnapshot,
      },
    );
    expect(inserted).toBe(true);
    expect(page).toMatchObject({
      total:1,
      items:[{ id:originalQuestionId }],
    });
  } finally {
    writer.release();
  }
});
