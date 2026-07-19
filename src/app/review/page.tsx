import type { Metadata } from 'next';
import { ReviewWorkspace, type ReviewQuestion } from '@/components/review/review-workspace';
import { db } from '@/server/db/pool';

export const metadata: Metadata = { title: '질문 검수' };
export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const result = await db.query<ReviewQuestion>(`
    select q.id, q.public_id, q.status, q.subject, q.grade, q.purpose, q.difficulty,
      qr.question_text, qr.answer_text, qr.scoring_criteria, qr.evidence_summary
    from questions q join question_revisions qr
      on qr.question_id = q.id and qr.revision = q.current_revision
    where q.status in ('DRAFT', 'IN_REVIEW', 'HELD') and q.deleted_at is null
    order by q.created_at asc limit 200
  `);
  return <ReviewWorkspace questions={result.rows} />;
}

