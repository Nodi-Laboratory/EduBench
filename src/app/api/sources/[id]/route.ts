import { NextResponse } from 'next/server';
import { withTransaction } from '@/server/db/transaction';
import { cancelJobWithClient } from '@/server/jobs/queue';

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const removed = await withTransaction(async (client) => {
    const source = await client.query<{ id: string }>(
      'select id from source_files where id = $1 and deleted_at is null for update', [id],
    );
    if (!source.rows[0]) return false;
    const jobs = await client.query<{ id: string }>(
      `select id from jobs where kind = 'document.parse' and payload->>'sourceId' = $1
        and state in ('PENDING','RETRY_WAIT','LEASED') for update`, [id],
    );
    for (const job of jobs.rows) await cancelJobWithClient(client, job.id);
    await client.query(
      `update source_files set deleted_at = now(), status = 'DELETED', updated_at = now() where id = $1`, [id],
    );
    return true;
  });
  if (!removed) return NextResponse.json({ code: 'SOURCE_NOT_FOUND', message: '등록 자료를 찾을 수 없습니다.' }, { status: 404 });
  return NextResponse.json({ id, deleted: true, recoverable: true });
}
