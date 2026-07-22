import { NextResponse } from 'next/server';
import { withTransaction } from '@/server/db/transaction';
import { cancelJobWithClient } from '@/server/jobs/queue';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await withTransaction(async (client) => {
    const source = await client.query<{ id: string }>(
      'select id from source_files where id = $1 and deleted_at is null for update', [id],
    );
    if (!source.rows[0]) return null;
    const job = await client.query<{ id: string }>(
      `select id from jobs where kind = 'document.parse' and payload->>'sourceId' = $1
        and state in ('PENDING', 'RETRY_WAIT', 'LEASED') order by created_at desc limit 1 for update`,
      [id],
    );
    if (!job.rows[0]) return { conflict: true } as const;
    if (!await cancelJobWithClient(client, job.rows[0].id)) return { conflict: true } as const;
    await client.query(
      `update source_files set status = 'CANCELLED', failed_stage = null,
         failure_code = null, failure_message = null, updated_at = now() where id = $1`,
      [id],
    );
    return { jobId: job.rows[0].id };
  });
  if (!result) return NextResponse.json({ code: 'SOURCE_NOT_FOUND', message: '교과서 파일을 찾을 수 없습니다.' }, { status: 404 });
  if ('conflict' in result) return NextResponse.json({ code: 'SOURCE_NOT_RUNNING', message: '중단할 작업이 없습니다.' }, { status: 409 });
  return NextResponse.json({ jobId: result.jobId, state: 'CANCELLED' });
}
