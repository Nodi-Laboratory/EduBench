import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/server/db/pool';
import { enqueueJob, enqueueJobWithClient } from '@/server/jobs/queue';
import { storeSourceFile } from '@/server/files/storage';
import { withTransaction } from '@/server/db/transaction';

type SourceRow = {
  id: string;
  sha256: string;
  original_name: string;
  mime_type: string;
  byte_size: string;
  subject: string | null;
  grade: string | null;
  status: string;
  failed_stage: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function GET() {
  const result = await db.query<SourceRow>(
    `select id, sha256, original_name, mime_type, byte_size, subject, grade,
       status, failed_stage, failure_code, created_at, updated_at
     from source_files where deleted_at is null
     order by created_at desc limit 200`,
  );
  return NextResponse.json({ items: result.rows });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ code: 'FILE_REQUIRED', message: 'PDF 파일을 선택하세요.' }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (file.type !== 'application/pdf' || magic !== '%PDF-') {
    return NextResponse.json({ code: 'PDF_REQUIRED', message: '유효한 PDF 파일만 등록할 수 있습니다.' }, { status: 400 });
  }
  if (bytes.byteLength > 100 * 1024 * 1024) {
    return NextResponse.json({ code: 'FILE_TOO_LARGE', message: 'PDF는 100MB 이하여야 합니다.' }, { status: 413 });
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await db.query<{ id: string }>('select id from source_files where sha256 = $1', [sha256]);
  if (existing.rows[0]) {
    await enqueueJob({
      kind: 'document.parse',
      payload: { sourceId: existing.rows[0].id },
      idempotencyKey: `document.parse:${existing.rows[0].id}:v1`,
    });
    return NextResponse.json({ id: existing.rows[0].id, existing: true });
  }

  const id = randomUUID();
  const storagePath = await storeSourceFile(id, bytes);
  const job = await withTransaction(async (client) => {
    await client.query(
      `insert into source_files(
         id, sha256, original_name, storage_path, mime_type, byte_size, subject, grade, status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'UPLOADED')`,
      [id, sha256, file.name, storagePath, file.type, bytes.byteLength,
        form.get('subject')?.toString() || null, form.get('grade')?.toString() || null],
    );
    return enqueueJobWithClient(client, {
      kind: 'document.parse', payload: { sourceId: id }, idempotencyKey: `document.parse:${id}:v1`,
    });
  });
  return NextResponse.json({ id, jobId: job.id, existing: false }, { status: 201 });
}
