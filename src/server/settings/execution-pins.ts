import {
  hashResearchConfigDefinition,
  parseResearchConfigDefinition,
  type ResearchConfigDefinition,
  type ResearchConfigKind,
} from '@/domain/research-config';
import { DomainError } from '@/domain/errors';
import { db } from '@/server/db/pool';

export type ResearchConfigDefinitionFor<K extends ResearchConfigKind> =
  Extract<ResearchConfigDefinition, { kind:K }>;

export type VerifiedResearchConfigPin<K extends ResearchConfigKind> = {
  profileId:string;
  definition:ResearchConfigDefinitionFor<K>;
  contentHash:string;
  provenance:'AT_CREATION_VERIFIED';
};

export type ResearchConfigPinInput = {
  profileId:unknown;
  definition:unknown;
  contentHash:unknown;
  provenance:unknown;
};

type SourcePinRow = {
  document_parse_profile_id:unknown;
  document_parse_profile_snapshot:unknown;
  document_parse_profile_hash:unknown;
  document_parse_profile_snapshot_provenance:unknown;
  embedding_rag_profile_id:unknown;
  embedding_rag_profile_snapshot:unknown;
  embedding_rag_profile_hash:unknown;
  embedding_rag_profile_snapshot_provenance:unknown;
};

type GenerationPinRow = {
  question_generation_profile_id:unknown;
  question_generation_profile_snapshot:unknown;
  question_generation_profile_hash:unknown;
  question_generation_profile_snapshot_provenance:unknown;
  embedding_rag_profile_id:unknown;
  embedding_rag_profile_snapshot:unknown;
  embedding_rag_profile_hash:unknown;
  embedding_rag_profile_snapshot_provenance:unknown;
};

type BenchmarkPinRow = {
  benchmark_models_profile_id:unknown;
  benchmark_models_profile_snapshot:unknown;
  benchmark_models_profile_hash:unknown;
  benchmark_models_profile_snapshot_provenance:unknown;
};

function integrityError(
  expectedKind: ResearchConfigKind,
  reason: string,
): DomainError {
  return new DomainError(
    'RESEARCH_CONFIG_PIN_INTEGRITY_ERROR',
    '고정된 연구 설정 프로필의 정의 또는 해시가 올바르지 않습니다.',
    { expectedKind, reason },
  );
}

export function verifyResearchConfigPin<K extends ResearchConfigKind>(
  expectedKind: K,
  pin: ResearchConfigPinInput,
): VerifiedResearchConfigPin<K> {
  if (pin.provenance !== 'AT_CREATION_VERIFIED') {
    throw new DomainError(
      'RESEARCH_CONFIG_PIN_UNVERIFIED',
      '이 작업은 연구 설정 고정 이전에 생성되어 실행 설정을 검증할 수 없습니다.',
      { expectedKind, provenance:pin.provenance ?? null },
    );
  }
  if (
    typeof pin.profileId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(pin.profileId)
  ) {
    throw integrityError(expectedKind, 'profile_id');
  }
  if (
    typeof pin.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(pin.contentHash)
  ) {
    throw integrityError(expectedKind, 'content_hash');
  }

  let definition: ResearchConfigDefinition;
  try {
    definition = parseResearchConfigDefinition(pin.definition);
  } catch {
    throw integrityError(expectedKind, 'definition_schema');
  }
  if (definition.kind !== expectedKind) {
    throw integrityError(expectedKind, 'definition_kind');
  }
  if (hashResearchConfigDefinition(definition) !== pin.contentHash) {
    throw integrityError(expectedKind, 'definition_hash');
  }

  return {
    profileId:pin.profileId,
    definition:definition as ResearchConfigDefinitionFor<K>,
    contentHash:pin.contentHash,
    provenance:'AT_CREATION_VERIFIED',
  };
}

function missingExecutionRecord(
  aggregateType: 'source_file' | 'generation_batch' | 'benchmark_run',
  aggregateId: string,
): DomainError {
  return new DomainError(
    'RESEARCH_CONFIG_PIN_NOT_FOUND',
    '연구 설정을 확인할 실행 기록을 찾을 수 없습니다.',
    { aggregateType, aggregateId },
  );
}

export async function resolveSourceExecutionPins(sourceFileId: string): Promise<{
  documentParse:VerifiedResearchConfigPin<'document_parse'>;
  embeddingRag:VerifiedResearchConfigPin<'embedding_rag'>;
}> {
  const result = await db.query<SourcePinRow>(
    `select
       document_parse_profile_id,
       document_parse_profile_snapshot,
       document_parse_profile_hash,
       document_parse_profile_snapshot_provenance,
       embedding_rag_profile_id,
       embedding_rag_profile_snapshot,
       embedding_rag_profile_hash,
       embedding_rag_profile_snapshot_provenance
     from source_files
     where id=$1`,
    [sourceFileId],
  );
  const row = result.rows[0];
  if (!row) throw missingExecutionRecord('source_file', sourceFileId);

  return {
    documentParse:verifyResearchConfigPin('document_parse', {
      profileId:row.document_parse_profile_id,
      definition:row.document_parse_profile_snapshot,
      contentHash:row.document_parse_profile_hash,
      provenance:row.document_parse_profile_snapshot_provenance,
    }),
    embeddingRag:verifyResearchConfigPin('embedding_rag', {
      profileId:row.embedding_rag_profile_id,
      definition:row.embedding_rag_profile_snapshot,
      contentHash:row.embedding_rag_profile_hash,
      provenance:row.embedding_rag_profile_snapshot_provenance,
    }),
  };
}

export async function resolveGenerationExecutionPins(
  generationBatchId: string,
): Promise<{
  questionGeneration:VerifiedResearchConfigPin<'question_generation'>;
  embeddingRag:VerifiedResearchConfigPin<'embedding_rag'>;
}> {
  const result = await db.query<GenerationPinRow>(
    `select
       question_generation_profile_id,
       question_generation_profile_snapshot,
       question_generation_profile_hash,
       question_generation_profile_snapshot_provenance,
       embedding_rag_profile_id,
       embedding_rag_profile_snapshot,
       embedding_rag_profile_hash,
       embedding_rag_profile_snapshot_provenance
     from generation_batches
     where id=$1`,
    [generationBatchId],
  );
  const row = result.rows[0];
  if (!row) {
    throw missingExecutionRecord('generation_batch', generationBatchId);
  }

  return {
    questionGeneration:verifyResearchConfigPin('question_generation', {
      profileId:row.question_generation_profile_id,
      definition:row.question_generation_profile_snapshot,
      contentHash:row.question_generation_profile_hash,
      provenance:row.question_generation_profile_snapshot_provenance,
    }),
    embeddingRag:verifyResearchConfigPin('embedding_rag', {
      profileId:row.embedding_rag_profile_id,
      definition:row.embedding_rag_profile_snapshot,
      contentHash:row.embedding_rag_profile_hash,
      provenance:row.embedding_rag_profile_snapshot_provenance,
    }),
  };
}

export async function resolveBenchmarkExecutionPin(
  benchmarkRunId: string,
): Promise<VerifiedResearchConfigPin<'benchmark_models'>> {
  const result = await db.query<BenchmarkPinRow>(
    `select
       benchmark_models_profile_id,
       benchmark_models_profile_snapshot,
       benchmark_models_profile_hash,
       benchmark_models_profile_snapshot_provenance
     from benchmark_runs
     where id=$1`,
    [benchmarkRunId],
  );
  const row = result.rows[0];
  if (!row) throw missingExecutionRecord('benchmark_run', benchmarkRunId);

  return verifyResearchConfigPin('benchmark_models', {
    profileId:row.benchmark_models_profile_id,
    definition:row.benchmark_models_profile_snapshot,
    contentHash:row.benchmark_models_profile_hash,
    provenance:row.benchmark_models_profile_snapshot_provenance,
  });
}
