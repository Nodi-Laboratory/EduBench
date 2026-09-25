import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/server/db/pool';
import { enqueueJobWithClient } from '@/server/jobs/queue';
import { storeSourceFile } from '@/server/files/storage';
import { withTransaction } from '@/server/db/transaction';
import {
  compatibleSourceWithCurrentProfiles,
  resumeCompatibleSource,
  type SourceReprocessResult,
} from '@/server/sources/reprocessing';

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
  current_job_id: string | null;
  current_job_state: string | null;
  source_lineage_id: string;
  reprocessed_from_source_file_id: string | null;
  reprocess_required: boolean;
};

export async function GET() {
  const result = await db.query<SourceRow>(
    `with active_source_profiles as (
       select
         max(profile.content_hash) filter(
           where active.kind='document_parse'
         ) document_parse_hash,
         max(profile.content_hash) filter(
           where active.kind='embedding_rag'
         ) embedding_rag_hash
       from research_config_active_profiles active
       join research_config_profiles profile on profile.id=active.profile_id
       where active.kind in ('document_parse','embedding_rag')
     )
     select s.id, s.sha256, s.original_name, s.mime_type, s.byte_size, s.subject, s.grade,
       s.status, s.failed_stage, s.failure_code, s.created_at, s.updated_at,
       s.source_lineage_id,s.reprocessed_from_source_file_id,
       j.id as current_job_id, j.state as current_job_state,
       not coalesce(
         s.document_parse_profile_snapshot_provenance='AT_CREATION_VERIFIED'
         and s.embedding_rag_profile_snapshot_provenance='AT_CREATION_VERIFIED'
         and s.document_parse_profile_hash=active.document_parse_hash
         and s.embedding_rag_profile_hash=active.embedding_rag_hash,
         false
       ) reprocess_required
     from source_files s
     cross join active_source_profiles active
     left join lateral (
       select id, state from jobs where kind = 'document.parse' and payload->>'sourceId' = s.id::text
       order by created_at desc limit 1
     ) j on true
     where s.deleted_at is null
     order by s.created_at desc limit 200`,
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
  const subject = form.get('subject')?.toString() || null;
  const grade = form.get('grade')?.toString() || null;
  const result = await withTransaction(async (client) => {
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [sha256],
    );
    const compatible = await compatibleSourceWithCurrentProfiles(
      client,
      sha256,
    );
    if (compatible) {
      return {
        ...(await resumeCompatibleSource(client, compatible, {
          originalName:file.name,
          subject,
          grade,
        })),
        created:false,
      };
    }

    const predecessor = await client.query<{
      id:string;
      source_lineage_id:string;
    }>(
      `select id,source_lineage_id
         from source_files
        where sha256=$1
        order by created_at desc
        limit 1
        for update`,
      [sha256],
    );
    const previous = predecessor.rows[0] ?? null;
    const id = randomUUID();
    const storagePath = await storeSourceFile(sha256, bytes);
    await client.query(
      `insert into source_files(
         id,sha256,original_name,storage_path,mime_type,byte_size,
         subject,grade,status,source_lineage_id,
         reprocessed_from_source_file_id
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,'UPLOADED',
         coalesce($9::uuid,gen_random_uuid()),$10
       )`,
      [
        id,
        sha256,
        file.name,
        storagePath,
        file.type,
        bytes.byteLength,
        subject,
        grade,
        previous?.source_lineage_id ?? null,
        previous?.id ?? null,
      ],
    );
    const job = await enqueueJobWithClient(client, {
      kind: 'document.parse', payload: { sourceId: id }, idempotencyKey: `document.parse:${id}:v1`,
    });
    return {
      id,
      jobId:job.id,
      existing:false,
      restored:false,
      reprocessedFrom:previous?.id ?? null,
      created:true,
    };
  });
  const body: SourceReprocessResult = {
    id:result.id,
    jobId:result.jobId,
    existing:result.existing,
    restored:result.restored,
    reprocessedFrom:result.reprocessedFrom,
  };
  return NextResponse.json(body, { status:result.created ? 201 : 200 });
}
