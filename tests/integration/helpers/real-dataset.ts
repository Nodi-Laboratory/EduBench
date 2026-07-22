import { randomUUID } from 'node:crypto';
import { db } from '@/server/db/pool';

export async function createRealPublishedDataset(questionCount = 5): Promise<string> {
  const datasetId = randomUUID();
  const marker = randomUUID().slice(0, 8);
  await db.query(
    `insert into dataset_versions(id,version,status,title,question_count,distribution,content_hash,published_at)
     values($1,$2,'DRAFT',$3,$4,$5::jsonb,$6,now())`,
    [datasetId, `integration-${marker}`, `실제 문항 테스트 데이터셋 ${marker}`, questionCount,
      JSON.stringify({ capabilities: { '핵심 개념 이해': questionCount }, responseFormats: { '구조화 서술형': questionCount }, evidenceModes: { GROUNDED: questionCount } }),
      randomUUID().replaceAll('-', '')],
  );
  for (let index = 1; index <= questionCount; index += 1) {
    const questionId = randomUUID();
    await db.query(
      `insert into questions(id,public_id,status,subject,grade,purpose,difficulty,question_type,evidence_mode,generator_provider,generator_model)
       values($1,$2,'APPROVED','과학','고등학교 1학년','핵심 개념 이해','중','구조화 서술형','GROUNDED','gemini','integration-real')`,
      [questionId, `REAL-${marker}-${index}`],
    );
    await db.query(
      `insert into question_revisions(question_id,revision,question_text,answer_text,scoring_criteria,accepted_answers,quality_scores)
       values($1,1,$2,'정답입니다.','[{"key":"accuracy","label":"정확성","maxScore":1}]','["정답입니다."]','{}')`,
      [questionId, `실제 테스트 질문 ${index}`],
    );
    await db.query(
      `insert into dataset_questions(dataset_version_id,question_id,question_revision,ordinal) values($1,$2,1,$3)`,
      [datasetId, questionId, index],
    );
  }
  await db.query(`update dataset_versions set status='PUBLISHED' where id=$1`, [datasetId]);
  return datasetId;
}
