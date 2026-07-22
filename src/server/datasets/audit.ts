import { db } from '@/server/db/pool';

export type BenchmarkDesignAudit = {
  benchmarkType: string | null;
  taskType: string | null;
  targetConcept: string | null;
  prerequisiteConcepts: Array<{ concept: string; role: string; evidenceChunkIds: string[] }>;
  prerequisiteRelations: Array<{ fromConcept: string; toConcept: string; relationType: string; explanation: string; evidenceChunkIds: string[] }>;
  requiredReasoningSteps: string[];
  failureSignals: string[];
};

export type QuestionEvidenceAudit = {
  chunkId: string;
  ordinal: number;
  role: string;
  quote: string | null;
  content: string;
  sourceName: string;
  pageStart: number | null;
  pageEnd: number | null;
  chapter: string | null;
  unit: string | null;
  sourceRevision: number;
  parseModel: string | null;
  parseRequestId: string | null;
};

export type AuditQuestion = {
  id: string;
  publicId: string;
  ordinal: number | null;
  status: string;
  subject: string;
  grade: string;
  chapter: string | null;
  unit: string | null;
  purpose: string;
  difficulty: string;
  questionType: string;
  evidenceMode: string;
  revision: number;
  currentRevision: number;
  revisionDrift: boolean;
  questionText: string;
  answerText: string;
  answerOptions: unknown[];
  acceptedAnswers: string[];
  scoringCriteria: Array<Record<string, unknown>>;
  designSummary: string | null;
  evidenceSummary: string | null;
  qualityScores: Record<string, unknown>;
  benchmarkDesign: BenchmarkDesignAudit | null;
  evidence: QuestionEvidenceAudit[];
  generation: {
    batchId: string | null;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    embeddingModel: string | null;
  };
  createdAt: string;
};

export type DatasetAuditVersion = {
  id: string;
  version: string;
  status: string;
  title: string;
  description: string | null;
  questionCount: number;
  distribution: Record<string, unknown>;
  contentHash: string;
  parentVersion: string | null;
  publishedAt: string;
  questions: AuditQuestion[];
};

export type DatasetAuditData = {
  workingQuestions: AuditQuestion[];
  versions: DatasetAuditVersion[];
};

type RawQuestion = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === 'string');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

export function normalizeBenchmarkDesign(qualityScores: unknown): BenchmarkDesignAudit | null {
  const design = record(record(qualityScores).benchmarkDesign);
  if (!Object.keys(design).length) return null;
  return {
    benchmarkType: text(design.benchmarkType),
    taskType: text(design.taskType),
    targetConcept: text(design.targetConcept),
    prerequisiteConcepts: array(design.prerequisiteConcepts).map(record).map((item) => ({
      concept: text(item.concept) ?? '—', role: text(item.role) ?? '—', evidenceChunkIds: strings(item.evidenceChunkIds),
    })),
    prerequisiteRelations: array(design.prerequisiteRelations).map(record).map((item) => ({
      fromConcept: text(item.fromConcept) ?? '—', toConcept: text(item.toConcept) ?? '—',
      relationType: text(item.relationType) ?? '—', explanation: text(item.explanation) ?? '—', evidenceChunkIds: strings(item.evidenceChunkIds),
    })),
    requiredReasoningSteps: strings(design.requiredReasoningSteps),
    failureSignals: strings(design.failureSignals),
  };
}

function normalizeQuestion(row: RawQuestion): AuditQuestion {
  const qualityScores = record(row.quality_scores);
  const currentRevision = Number(row.current_revision);
  const revision = Number(row.revision);
  return {
    id: String(row.id), publicId: String(row.public_id), ordinal: row.ordinal == null ? null : Number(row.ordinal),
    status: String(row.status), subject: String(row.subject), grade: String(row.grade),
    chapter: text(row.chapter), unit: text(row.unit), purpose: String(row.purpose), difficulty: String(row.difficulty),
    questionType: String(row.question_type), evidenceMode: String(row.evidence_mode), revision, currentRevision,
    revisionDrift: revision !== currentRevision, questionText: String(row.question_text), answerText: String(row.answer_text),
    answerOptions: array(row.answer_options), acceptedAnswers: strings(row.accepted_answers),
    scoringCriteria: array(row.scoring_criteria).map(record), designSummary: text(row.design_summary),
    evidenceSummary: text(row.evidence_summary), qualityScores, benchmarkDesign: normalizeBenchmarkDesign(qualityScores),
    evidence: array(row.evidence).map(record).map((item) => ({
      chunkId: String(item.chunkId), ordinal: Number(item.ordinal), role: String(item.role), quote: text(item.quote),
      content: String(item.content ?? ''), sourceName: String(item.sourceName ?? '—'),
      pageStart: item.pageStart == null ? null : Number(item.pageStart), pageEnd: item.pageEnd == null ? null : Number(item.pageEnd),
      chapter: text(item.chapter), unit: text(item.unit), sourceRevision: Number(item.sourceRevision),
      parseModel: text(item.parseModel), parseRequestId: text(item.parseRequestId),
    })),
    generation: {
      batchId: text(row.generation_batch_id), provider: text(row.generator_provider),
      model: text(row.generator_model) ?? text(row.generation_model), promptVersion: text(row.prompt_version),
      embeddingModel: text(row.embedding_model),
    },
    createdAt: String(row.created_at),
  };
}

const questionProjection = `
  q.id,q.public_id,q.status,q.subject,q.grade,q.chapter,q.unit,q.purpose,q.difficulty,q.question_type,q.evidence_mode,
  q.current_revision,q.generation_batch_id,q.generator_provider,q.generator_model,q.embedding_model,q.created_at::text created_at,
  qr.revision,qr.question_text,qr.answer_text,qr.answer_options,qr.scoring_criteria,qr.accepted_answers,
  qr.design_summary,qr.evidence_summary,qr.quality_scores,gb.generation_model,gb.prompt_version,
  coalesce((select jsonb_agg(jsonb_build_object(
    'chunkId',sc.id,'ordinal',qe.ordinal,'role',qe.role,'quote',qe.quote_text,'content',sc.content,
    'sourceName',sf.original_name,'pageStart',sc.page_start,'pageEnd',sc.page_end,'chapter',sc.chapter,'unit',sc.unit,
    'sourceRevision',sr.revision,'parseModel',sr.parse_model,'parseRequestId',sr.parse_request_id
  ) order by qe.ordinal)
  from question_evidence qe join source_chunks sc on sc.id=qe.source_chunk_id
  join source_files sf on sf.id=sc.source_file_id join source_revisions sr on sr.id=sc.source_revision_id
  where qe.question_id=q.id and qe.question_revision=qr.revision),'[]'::jsonb) evidence`;

export async function getDatasetAuditData(): Promise<DatasetAuditData> {
  const [working, versions, pinned] = await Promise.all([
    db.query(`select ${questionProjection},null::integer ordinal from questions q
      join question_revisions qr on qr.question_id=q.id and qr.revision=q.current_revision
      left join generation_batches gb on gb.id=q.generation_batch_id
      where q.status='APPROVED' and q.deleted_at is null and coalesce(q.generator_provider,'') <> 'sample'
      and coalesce(q.generator_model,'') not like 'mock-%' order by q.public_id`),
    db.query(`select dv.id,dv.version,dv.status,dv.title,dv.description,dv.question_count,dv.distribution,dv.content_hash,
      parent.version parent_version,dv.published_at::text published_at from dataset_versions dv
      left join dataset_versions parent on parent.id=dv.parent_version_id order by dv.published_at desc`),
    db.query(`select ${questionProjection},dq.ordinal,dq.dataset_version_id from dataset_questions dq
      join questions q on q.id=dq.question_id
      join question_revisions qr on qr.question_id=dq.question_id and qr.revision=dq.question_revision
      left join generation_batches gb on gb.id=q.generation_batch_id order by dq.dataset_version_id,dq.ordinal`),
  ]);
  const pinnedByVersion = new Map<string, AuditQuestion[]>();
  for (const row of pinned.rows) {
    const key = String(row.dataset_version_id);
    pinnedByVersion.set(key, [...(pinnedByVersion.get(key) ?? []), normalizeQuestion(row)]);
  }
  return {
    workingQuestions: working.rows.map(normalizeQuestion),
    versions: versions.rows.map((row) => ({
      id: String(row.id), version: String(row.version), status: String(row.status), title: String(row.title),
      description: text(row.description), questionCount: Number(row.question_count), distribution: record(row.distribution),
      contentHash: String(row.content_hash), parentVersion: text(row.parent_version), publishedAt: String(row.published_at),
      questions: pinnedByVersion.get(String(row.id)) ?? [],
    })),
  };
}
