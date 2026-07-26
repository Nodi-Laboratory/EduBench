import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '@/server/db/transaction';
import { enqueueJobWithClient } from '@/server/jobs/queue';

export type CompatibleSourceRow = {
  id:string;
  status:string;
  deleted_at:Date | null;
};

type SourceLineageRow = {
  id:string;
  sha256:string;
  original_name:string;
  storage_path:string;
  mime_type:string;
  byte_size:string;
  subject:string | null;
  grade:string | null;
  publisher:string | null;
  status:string;
  source_lineage_id:string;
};

export type SourceReprocessResult = {
  id:string;
  jobId:string | null;
  existing:boolean;
  restored:boolean;
  reprocessedFrom:string | null;
};

export async function compatibleSourceWithCurrentProfiles(
  client:PoolClient,
  sha256:string,
): Promise<CompatibleSourceRow | null> {
  const result = await client.query<CompatibleSourceRow>(
    `select source.id,source.status,source.deleted_at
       from source_files source
      where source.sha256=$1
        and source.document_parse_profile_snapshot_provenance=
              'AT_CREATION_VERIFIED'
        and source.embedding_rag_profile_snapshot_provenance=
              'AT_CREATION_VERIFIED'
        and source.document_parse_profile_hash=(
          select profile.content_hash
            from research_config_active_profiles active
            join research_config_profiles profile
              on profile.id=active.profile_id
           where active.kind='document_parse'
        )
        and source.embedding_rag_profile_hash=(
          select profile.content_hash
            from research_config_active_profiles active
            join research_config_profiles profile
              on profile.id=active.profile_id
           where active.kind='embedding_rag'
        )
      order by (source.deleted_at is null) desc,source.created_at desc
      limit 1
      for update`,
    [sha256],
  );
  return result.rows[0] ?? null;
}

export async function resumeCompatibleSource(
  client:PoolClient,
  source:CompatibleSourceRow,
  metadata:{ originalName:string; subject:string | null; grade:string | null },
): Promise<SourceReprocessResult> {
  const restart = Boolean(
    source.deleted_at
    || ['FAILED', 'CANCELLED'].includes(source.status),
  );
  if (!restart) {
    return {
      id:source.id,
      jobId:null,
      existing:true,
      restored:false,
      reprocessedFrom:null,
    };
  }
  await client.query(
    `update source_files
        set original_name=$2,subject=$3,grade=$4,deleted_at=null,
            status='UPLOADED',failed_stage=null,failure_code=null,
            failure_message=null,updated_at=now()
      where id=$1`,
    [source.id, metadata.originalName, metadata.subject, metadata.grade],
  );
  const job = await enqueueJobWithClient(client, {
    kind:'document.parse',
    payload:{ sourceId:source.id },
    idempotencyKey:`document.parse:${source.id}:restore:${randomUUID()}`,
  });
  return {
    id:source.id,
    jobId:job.id,
    existing:true,
    restored:Boolean(source.deleted_at),
    reprocessedFrom:null,
  };
}

export async function reprocessSourceWithCurrentProfiles(
  sourceId:string,
): Promise<SourceReprocessResult | null> {
  return withTransaction(async (client) => {
    const sourceResult = await client.query<SourceLineageRow>(
      `select id,sha256,original_name,storage_path,mime_type,byte_size,
              subject,grade,publisher,status,source_lineage_id
         from source_files
        where id=$1 and deleted_at is null
        for update`,
      [sourceId],
    );
    const source = sourceResult.rows[0];
    if (!source) return null;
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [source.sha256],
    );

    const compatible = await compatibleSourceWithCurrentProfiles(
      client,
      source.sha256,
    );
    if (compatible) {
      const reused = await resumeCompatibleSource(client, compatible, {
        originalName:source.original_name,
        subject:source.subject,
        grade:source.grade,
      });
      return {
        ...reused,
        reprocessedFrom:compatible.id === sourceId ? null : sourceId,
      };
    }

    const id = randomUUID();
    await client.query(
      `insert into source_files(
         id,sha256,original_name,storage_path,mime_type,byte_size,
         subject,grade,publisher,status,source_lineage_id,
         reprocessed_from_source_file_id
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'UPLOADED',$10,$11
       )`,
      [
        id,
        source.sha256,
        source.original_name,
        source.storage_path,
        source.mime_type,
        source.byte_size,
        source.subject,
        source.grade,
        source.publisher,
        source.source_lineage_id,
        source.id,
      ],
    );
    const job = await enqueueJobWithClient(client, {
      kind:'document.parse',
      payload:{ sourceId:id },
      idempotencyKey:`document.parse:${id}:v1`,
    });
    return {
      id,
      jobId:job.id,
      existing:false,
      restored:false,
      reprocessedFrom:source.id,
    };
  });
}
