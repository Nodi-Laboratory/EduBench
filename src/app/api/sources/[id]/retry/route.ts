import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { withRequestProviderKeys } from '@/server/providers/credentials';
import { withTransaction } from '@/server/db/transaction';
import { enqueueJobWithClient } from '@/server/jobs/queue';

async function handlePost(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await withTransaction(async (client) => {
    const source = await client.query<{ status: string }>('select status from source_files where id = $1 and deleted_at is null for update', [id]);
    if (!source.rows[0]) return null;
    if (!['FAILED', 'CANCELLED'].includes(source.rows[0].status)) return { conflict:true } as const;
    const queued = await enqueueJobWithClient(client, { kind:'document.parse', payload:{ sourceId:id }, idempotencyKey:`document.parse:${id}:retry:${randomUUID()}` });
    await client.query("update source_files set status='UPLOADED', failed_stage=null, failure_code=null, failure_message=null, updated_at=now() where id=$1", [id]);
    return queued;
  });
  if (!job) return NextResponse.json({ code:'SOURCE_NOT_FOUND', message:'교과서 파일을 찾을 수 없습니다.' }, { status:404 });
  if ('conflict' in job) return NextResponse.json({ code:'SOURCE_NOT_RESTARTABLE', message:'실패하거나 중단된 자료만 재실행할 수 있습니다.' }, { status:409 });
  return NextResponse.json({ jobId:job.id, state:'UPLOADED' });
}

export function POST(...args: Parameters<typeof handlePost>) {
  return withRequestProviderKeys(args[0], () => handlePost(...args));
}
