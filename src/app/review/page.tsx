import type { Metadata } from 'next';
import {
  ReviewWorkspace,
  type ReviewQuestion,
  type ReviewQuestionSet,
} from '@/components/review/review-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '질문 검수' };
export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const [questions, questionSets] = await Promise.all([
    db.query<ReviewQuestion>(`
      select q.id, q.public_id, q.status, q.subject, q.grade, q.purpose, q.difficulty,
        qr.question_text, qr.answer_text, qr.scoring_criteria, qr.evidence_summary, qr.quality_scores
      from questions q join question_revisions qr
        on qr.question_id = q.id and qr.revision = q.current_revision
      where q.status in ('DRAFT', 'IN_REVIEW', 'HELD') and q.deleted_at is null
      order by q.created_at asc limit 200
    `),
    db.query<ReviewQuestionSet>(`
      select qs.id,qs.title,qs.description,count(qsq.question_id)::integer "questionCount"
      from question_sets qs
      left join question_set_questions qsq on qsq.question_set_id=qs.id
      where qs.deleted_at is null
      group by qs.id
      order by qs.updated_at desc,qs.created_at desc
    `),
  ]);
  return (
    <ReviewWorkspace
      questions={questions.rows}
      questionSets={questionSets.rows}
    />
  );
}

