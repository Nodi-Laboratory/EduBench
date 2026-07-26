import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { enqueueJobWithClient } from '@/server/jobs/queue';
import { GENERATION_STAGES } from '@/domain/generation';
import {
  hashResearchConfigDefinition,
  parseResearchConfigDefinition,
} from '@/domain/research-config';
import { DomainError } from '@/domain/errors';

const generationSchema = z.object({
  subject: z.string().trim().min(1),
  grade: z.string().trim().min(1),
  sourceFileIds: z.array(z.uuid()).min(1),
  tocEntryIds: z.array(z.uuid()).default([]),
  purpose: z.string().trim().min(1),
  questionType: z.string().trim().min(1),
  difficulty: z.enum(['하', '중', '상']),
  direction: z.string().trim().min(3).max(2000),
  chunkCount: z.number().int().min(3).max(30),
  crossUnit: z.boolean(),
  requestedCount: z.number().int().min(1).max(100),
  executionMode: z.enum(['sequential', 'parallel']).default('sequential'),
});

export async function GET() {
  const result = await db.query(
    `select id, state, requested_count, conditions, source_scope, generation_model,
       prompt_version, progress,
       question_generation_profile_id,question_generation_profile_hash,
       question_generation_profile_snapshot,
       question_generation_profile_snapshot_provenance,
       embedding_rag_profile_id,embedding_rag_profile_hash,
       embedding_rag_profile_snapshot,
       embedding_rag_profile_snapshot_provenance,
       created_at,updated_at
     from generation_batches order by created_at desc limit 100`,
  );
  return NextResponse.json({ items: result.rows });
}

export async function POST(request: Request) {
  const parsed = generationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_GENERATION_INPUT', issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  if (new Set(input.sourceFileIds).size !== input.sourceFileIds.length) {
    return NextResponse.json({ code: 'DUPLICATE_SOURCE_SCOPE', message: '교과서 파일 선택이 중복되었습니다.' }, { status: 400 });
  }
  if (new Set(input.tocEntryIds).size !== input.tocEntryIds.length) {
    return NextResponse.json({ code: 'DUPLICATE_TOC_SCOPE', message: '목차 선택이 중복되었습니다.' }, { status: 400 });
  }
  const sources = await db.query<{ id: string; status: string }>(
    'select id, status from source_files where id = any($1::uuid[]) and deleted_at is null',
    [input.sourceFileIds],
  );
  if (sources.rowCount !== input.sourceFileIds.length || sources.rows.some((source) => source.status !== 'READY')) {
    return NextResponse.json({ code: 'SOURCE_NOT_READY', message: '처리가 완료된 교과서만 질문 생성에 사용할 수 있습니다.' }, { status: 409 });
  }
  const revisions = await db.query<{ id: string; source_file_id: string; revision: number }>(
    `select distinct on (source_file_id) id, source_file_id, revision
       from source_revisions
      where source_file_id = any($1::uuid[])
      order by source_file_id, revision desc`,
    [input.sourceFileIds],
  );
  if (revisions.rowCount !== input.sourceFileIds.length) {
    return NextResponse.json({ code: 'SOURCE_REVISION_NOT_FOUND', message: '교과서의 처리 리비전을 찾을 수 없습니다.' }, { status: 409 });
  }
  const revisionBySource = new Map(revisions.rows.map((revision) => [revision.source_file_id, revision]));
  const sourceRevisionIds = input.sourceFileIds.map((sourceId) => revisionBySource.get(sourceId)!.id);
  const tocEntries = input.tocEntryIds.length ? await db.query<{
    id: string;
    source_file_id: string;
    source_revision_id: string | null;
    title: string;
    mapping_status: string;
    mapped_chunk_count: number;
  }>(
    `select entry.id, entry.source_file_id, entry.source_revision_id, entry.title,
            entry.mapping_status, count(distinct chunk.id)::int as mapped_chunk_count
       from source_toc_entries entry
       left join source_chunk_toc_entries mapping on mapping.source_toc_entry_id = entry.id
        and mapping.source_revision_id = entry.source_revision_id
       left join source_chunks chunk on chunk.id = mapping.source_chunk_id
        and chunk.source_revision_id = mapping.source_revision_id
      where entry.id = any($1::uuid[])
      group by entry.id`,
    [input.tocEntryIds],
  ) : { rows: [], rowCount: 0 };
  if (tocEntries.rowCount !== input.tocEntryIds.length
    || tocEntries.rows.some((entry) =>
      !input.sourceFileIds.includes(entry.source_file_id)
      || revisionBySource.get(entry.source_file_id)?.id !== entry.source_revision_id)) {
    return NextResponse.json({ code: 'INVALID_TOC_SCOPE', message: '선택한 목차가 교과서 범위와 일치하지 않습니다.' }, { status: 400 });
  }
  if (tocEntries.rows.some((entry) => entry.mapping_status !== 'MAPPED' || entry.mapped_chunk_count < 1)) {
    return NextResponse.json({
      code: 'GENERATION_TOC_SCOPE_EMPTY',
      message: '선택한 목차가 현재 교과서 리비전의 청크에 연결되지 않았습니다. 목차 매핑을 확인해 주세요.',
    }, { status: 409 });
  }

  const id = randomUUID();
  const progress = {
    currentStage: 0,
    completedQuestions: 0,
    failedQuestions: 0,
    stages: GENERATION_STAGES.map((label, index) => ({ index: index + 1, label, state: 'PENDING' })),
  };
  const conditions = {
    subject: input.subject,
    grade: input.grade,
    units: tocEntries.rows.map((entry) => entry.title),
    purpose: input.purpose,
    questionType: input.questionType,
    difficulty: input.difficulty,
    direction: input.direction,
    chunkCount: input.chunkCount,
    crossUnit: input.crossUnit,
    executionMode: input.executionMode,
  };
  try {
    const created = await withTransaction(async (client) => {
      const activeProfiles = await client.query<{
        id:string;
        kind:string;
        definition:unknown;
        content_hash:string;
      }>(
        `select profile.id,profile.kind,profile.definition,
           profile.content_hash
         from research_config_active_profiles active
         join research_config_profiles profile
           on profile.id=active.profile_id and profile.kind=active.kind
         where active.kind=any($1::text[])
         for share of active,profile`,
        [['question_generation', 'embedding_rag']],
      );
      const activeByKind = new Map(
        activeProfiles.rows.map((profile) => [profile.kind, profile]),
      );
      const generationProfile = activeByKind.get('question_generation');
      const embeddingProfile = activeByKind.get('embedding_rag');
      if (!generationProfile || !embeddingProfile) {
        throw new DomainError(
          'RESEARCH_CONFIG_ACTIVE_PROFILE_MISSING',
          '질문 생성 및 임베딩/RAG 활성 연구 설정이 필요합니다.',
        );
      }
      const generationDefinition = parseResearchConfigDefinition(
        generationProfile.definition,
      );
      const embeddingDefinition = parseResearchConfigDefinition(
        embeddingProfile.definition,
      );
      if (
        generationDefinition.kind !== 'question_generation'
        || embeddingDefinition.kind !== 'embedding_rag'
        || hashResearchConfigDefinition(generationDefinition)
             !== generationProfile.content_hash
        || hashResearchConfigDefinition(embeddingDefinition)
             !== embeddingProfile.content_hash
      ) {
        throw new DomainError(
          'RESEARCH_CONFIG_PROFILE_INTEGRITY_ERROR',
          '활성 연구 설정 정의와 해시가 일치하지 않습니다.',
        );
      }
      const compatibleSources = await client.query<{ count:number }>(
        `select count(*)::int count
         from source_files
         where id=any($1::uuid[])
           and deleted_at is null
           and status='READY'
           and embedding_rag_profile_hash=$2
           and embedding_rag_profile_snapshot_provenance=
                 'AT_CREATION_VERIFIED'`,
        [input.sourceFileIds, embeddingProfile.content_hash],
      );
      if (compatibleSources.rows[0]?.count !== input.sourceFileIds.length) {
        throw new DomainError(
          'GENERATION_VECTOR_SPACE_MISMATCH',
          '선택한 교과서가 현재 활성 임베딩/RAG 설정과 다릅니다. 교과서를 현재 설정으로 다시 처리하십시오.',
        );
      }

      await client.query(
        `insert into generation_batches(
           id,state,requested_count,conditions,source_scope,generation_model,
           prompt_version,progress
         ) values(
           $1,'QUEUED',$2,$3::jsonb,$4::jsonb,$5,
           'question-generation-v1',$6::jsonb
         )`,
        [
          id,
          input.requestedCount,
          JSON.stringify(conditions),
          JSON.stringify({
            sourceFileIds:input.sourceFileIds,
            sourceRevisionIds,
            tocEntryIds:input.tocEntryIds,
          }),
          generationDefinition.settings.model,
          JSON.stringify(progress),
        ],
      );
      await client.query(
        `insert into generation_items(generation_batch_id,ordinal)
         select $1,ordinal
         from generate_series(1,$2::int) ordinal`,
        [id, input.requestedCount],
      );
      const job = await enqueueJobWithClient(client, {
        kind:'question.generate',
        payload:{ batchId:id },
        idempotencyKey:`question.generate:${id}:v1`,
        maxAttempts:3,
      });
      return {
        job,
        generationProfileId:generationProfile.id,
        generationProfileHash:generationProfile.content_hash,
        embeddingProfileId:embeddingProfile.id,
        embeddingProfileHash:embeddingProfile.content_hash,
      };
    });
    return NextResponse.json({
      id,
      jobId:created.job.id,
      state:'QUEUED',
      progress,
      generationProfileId:created.generationProfileId,
      generationProfileHash:created.generationProfileHash,
      embeddingProfileId:created.embeddingProfileId,
      embeddingProfileHash:created.embeddingProfileHash,
    }, { status:201 });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { code:error.code, message:error.message },
        { status:409 },
      );
    }
    throw error;
  }
}
