import type { PoolClient } from 'pg';
import { db } from '@/server/db/pool';
import { withReadOnlyRepeatableReadTransaction } from '@/server/db/snapshot';

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

export type QuestionSetAudit = {
  id: string;
  title: string;
  description: string | null;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
  questions: AuditQuestion[];
};

export type DatasetAuditData = {
  workingQuestions: AuditQuestion[];
  questionSets: QuestionSetAudit[];
  versions: DatasetAuditVersion[];
};

export type DatasetAuditScope = 'set' | 'unassigned' | 'version';

export type AuditQuestionListItem = {
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
  questionSummary: string;
};

export type QuestionSetAuditMetadata = Omit<QuestionSetAudit, 'questions'>;
export type DatasetAuditVersionMetadata = Omit<DatasetAuditVersion, 'questions'>;

export type DatasetAuditIndex = {
  unassignedQuestionCount: number;
  questionSets: QuestionSetAuditMetadata[];
  versions: DatasetAuditVersionMetadata[];
};

export type ListDatasetAuditQuestionsInput = {
  scope: DatasetAuditScope;
  scopeId?: string;
  page?: number;
  pageSize?: number;
  query?: string;
  purpose?: string;
  difficulty?: string;
  questionType?: string;
  evidenceMode?: string;
};

export type DatasetAuditQuestionPage = {
  items: AuditQuestionListItem[];
  page: number;
  pageSize: number;
  total: number;
};

export type GetDatasetAuditQuestionDetailInput = {
  scope: DatasetAuditScope;
  scopeId?: string;
  questionId: string;
  revision: number;
};

type ReadOnlySnapshotRunner = <T>(
  work:(client:PoolClient)=>Promise<T>,
) => Promise<T>;

export type DatasetAuditReadDependencies = {
  withSnapshot?:ReadOnlySnapshotRunner;
};

export type QuestionSetAuditExportOptions = {
  batchSize?:number;
  exportedAt?:string;
};

export type QuestionSetAuditExport = {
  id:string;
  body:ReadableStream<Uint8Array>;
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

const activeUnassignedQuestionWhere = `
  q.status='APPROVED' and q.deleted_at is null
  and coalesce(q.generator_provider,'') <> 'sample'
  and coalesce(q.generator_model,'') not like 'mock-%'
  and not exists (
    select 1 from question_set_questions qsq
    join question_sets qs on qs.id=qsq.question_set_id
    where qsq.question_id=q.id and qs.deleted_at is null
  )`;

function normalizeAuditTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeQuestionListItem(row: RawQuestion): AuditQuestionListItem {
  const revision = Number(row.revision);
  const currentRevision = Number(row.current_revision);
  return {
    id: String(row.id), publicId: String(row.public_id),
    ordinal: row.ordinal == null ? null : Number(row.ordinal),
    status: String(row.status), subject: String(row.subject), grade: String(row.grade),
    chapter: text(row.chapter), unit: text(row.unit), purpose: String(row.purpose),
    difficulty: String(row.difficulty), questionType: String(row.question_type),
    evidenceMode: String(row.evidence_mode), revision, currentRevision,
    revisionDrift: revision !== currentRevision,
    questionSummary: String(row.question_summary),
  };
}

function normalizedPage(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 1;
}

function normalizedPageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 20;
  return Math.min(50, Math.floor(value));
}

type AuditScopeSql = {
  from: string;
  where: string[];
  ordinal: string;
};

function auditScopeSql(
  input: Pick<ListDatasetAuditQuestionsInput, 'scope' | 'scopeId'>,
  values: unknown[],
): AuditScopeSql | null {
  if (input.scope === 'unassigned') {
    return {
      from: `questions q
        join question_revisions qr on qr.question_id=q.id and qr.revision=q.current_revision`,
      where: [activeUnassignedQuestionWhere],
      ordinal: 'q.public_id asc',
    };
  }
  if (!input.scopeId) return null;
  values.push(input.scopeId);
  const scopeParameter = `$${values.length}`;
  if (input.scope === 'set') {
    return {
      from: `question_set_questions qsq
        join question_sets qs on qs.id=qsq.question_set_id
        join questions q on q.id=qsq.question_id
        join question_revisions qr on qr.question_id=qsq.question_id and qr.revision=qsq.question_revision`,
      where: [`qsq.question_set_id=${scopeParameter}`, 'qs.deleted_at is null'],
      ordinal: 'qsq.ordinal asc, q.public_id asc',
    };
  }
  return {
    from: `dataset_questions dq
      join dataset_versions dv on dv.id=dq.dataset_version_id
      join questions q on q.id=dq.question_id
      join question_revisions qr on qr.question_id=dq.question_id and qr.revision=dq.question_revision`,
    where: [`dq.dataset_version_id=${scopeParameter}`],
    ordinal: 'dq.ordinal asc, q.public_id asc',
  };
}

export async function getDatasetAuditIndex(): Promise<DatasetAuditIndex> {
  const [unassigned, questionSets, versions] = await Promise.all([
    db.query<{ count: string }>(`select count(*) from questions q where ${activeUnassignedQuestionWhere}`),
    db.query(`select qs.id,qs.title,qs.description,qs.created_at::text created_at,
      qs.updated_at::text updated_at,count(qsq.question_id)::integer question_count
      from question_sets qs
      left join question_set_questions qsq on qsq.question_set_id=qs.id
      where qs.deleted_at is null
      group by qs.id order by qs.updated_at desc,qs.created_at desc`),
    db.query(`select dv.id,dv.version,dv.status,dv.title,dv.description,dv.question_count,dv.distribution,dv.content_hash,
      parent.version parent_version,dv.published_at::text published_at from dataset_versions dv
      left join dataset_versions parent on parent.id=dv.parent_version_id order by dv.published_at desc`),
  ]);
  return {
    unassignedQuestionCount: Number(unassigned.rows[0]?.count ?? 0),
    questionSets: questionSets.rows.map((row) => ({
      id: String(row.id), title: String(row.title), description: text(row.description),
      questionCount: Number(row.question_count), createdAt: normalizeAuditTimestamp(row.created_at),
      updatedAt: normalizeAuditTimestamp(row.updated_at),
    })),
    versions: versions.rows.map((row) => ({
      id: String(row.id), version: String(row.version), status: String(row.status), title: String(row.title),
      description: text(row.description), questionCount: Number(row.question_count), distribution: record(row.distribution),
      contentHash: String(row.content_hash), parentVersion: text(row.parent_version),
      publishedAt: normalizeAuditTimestamp(row.published_at),
    })),
  };
}

function indentedJson(value:unknown, spaces:number):string {
  const indentation = ' '.repeat(spaces);
  return indentation + JSON.stringify(value, null, 2)
    .replaceAll('\n', `\n${indentation}`);
}

function questionSetExportEnvelope(
  exportedAt:string,
  questionSet:QuestionSetAuditMetadata,
):{ prefix:string; suffix:string } {
  const sentinel = `__EDUBENCH_QUESTIONS_${questionSet.id}__`;
  const template = JSON.stringify({
    exportedAt,
    questionSet:{ ...questionSet, questions:sentinel },
  }, null, 2);
  const token = JSON.stringify(sentinel);
  const tokenIndex = template.indexOf(token);
  if (tokenIndex < 0) {
    throw new Error('QUESTION_SET_EXPORT_ENVELOPE_ERROR');
  }
  return {
    prefix:`${template.slice(0, tokenIndex)}[`,
    suffix:`\n    ]${template.slice(tokenIndex + token.length)}`,
  };
}

export async function openQuestionSetAuditExport(
  questionSetId: string,
  options:QuestionSetAuditExportOptions = {},
): Promise<QuestionSetAuditExport | null> {
  const client = await db.connect();
  let transactionOpen = false;
  let released = false;
  const finish = async (commit:boolean) => {
    if (released) return;
    released = true;
    try {
      if (transactionOpen) {
        if (commit) {
          try {
            await client.query('commit');
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          }
        } else {
          await client.query('rollback');
        }
        transactionOpen = false;
      }
    } finally {
      client.release();
    }
  };
  try {
    await client.query('begin isolation level repeatable read read only');
    transactionOpen = true;
    const questionSet = await client.query(
      `select qs.id,qs.title,qs.description,qs.created_at::text created_at,
        qs.updated_at::text updated_at,count(qsq.question_id)::integer question_count
        from question_sets qs
        left join question_set_questions qsq on qsq.question_set_id=qs.id
        where qs.id=$1 and qs.deleted_at is null
        group by qs.id`,
      [questionSetId],
    );
    const row = questionSet.rows[0];
    if (!row) {
      await finish(false);
      return null;
    }
    const metadata:QuestionSetAuditMetadata = {
      id: String(row.id),
      title: String(row.title),
      description: text(row.description),
      questionCount: Number(row.question_count),
      createdAt: normalizeAuditTimestamp(row.created_at),
      updatedAt: normalizeAuditTimestamp(row.updated_at),
    };
    const exportedAt = options.exportedAt ?? new Date().toISOString();
    const requestedBatchSize = Math.floor(options.batchSize ?? 50);
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(250, requestedBatchSize))
      : 50;
    const encoder = new TextEncoder();
    const envelope = metadata.questionCount > 0
      ? questionSetExportEnvelope(exportedAt, metadata)
      : null;
    let phase:'header' | 'questions' | 'done' = 'header';
    let questionBatch:AuditQuestion[] = [];
    let batchIndex = 0;
    let emitted = 0;
    let cursorOrdinal = 0;

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (phase === 'header') {
            phase = metadata.questionCount > 0 ? 'questions' : 'done';
            if (phase === 'done') {
              await finish(true);
              controller.enqueue(encoder.encode(JSON.stringify({
                exportedAt,
                questionSet:{ ...metadata, questions:[] },
              }, null, 2)));
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(envelope!.prefix));
            return;
          }
          if (phase === 'done') {
            controller.close();
            return;
          }
          if (batchIndex >= questionBatch.length) {
            const questions = await client.query<RawQuestion>(
              `select ${questionProjection},qsq.ordinal
                 from question_set_questions qsq
                 join question_sets qs
                   on qs.id=qsq.question_set_id
                  and qs.deleted_at is null
                 join questions q on q.id=qsq.question_id
                 join question_revisions qr
                   on qr.question_id=qsq.question_id
                  and qr.revision=qsq.question_revision
                 left join generation_batches gb
                   on gb.id=q.generation_batch_id
                where qsq.question_set_id=$1
                  and qsq.ordinal>$2
                order by qsq.ordinal
                limit $3`,
              [questionSetId, cursorOrdinal, batchSize],
            );
            if (!questions.rows.length) {
              throw new Error(
                'QUESTION_SET_EXPORT_SNAPSHOT_INCOMPLETE: 문항 수와 내보내기 스냅샷이 일치하지 않습니다.',
              );
            }
            cursorOrdinal = Number(
              questions.rows[questions.rows.length - 1]!.ordinal,
            );
            questionBatch = questions.rows.map(normalizeQuestion);
            batchIndex = 0;
          }
          const question = questionBatch[batchIndex++]!;
          const chunk = `${emitted === 0 ? '\n' : ',\n'}${
            indentedJson(question, 6)
          }`;
          emitted += 1;
          if (emitted === metadata.questionCount) {
            phase = 'done';
            await finish(true);
            controller.enqueue(encoder.encode(`${chunk}${envelope!.suffix}`));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          await finish(false).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel() {
        phase = 'done';
        await finish(false);
      },
    });
    return { id:metadata.id, body };
  } catch (error) {
    await finish(false).catch(() => undefined);
    throw error;
  }
}

export async function listDatasetAuditQuestions(
  input: ListDatasetAuditQuestionsInput,
  dependencies:DatasetAuditReadDependencies = {},
): Promise<DatasetAuditQuestionPage> {
  const page = normalizedPage(input.page);
  const pageSize = normalizedPageSize(input.pageSize);
  const values: unknown[] = [];
  const scope = auditScopeSql(input, values);
  if (!scope) return { items: [], page, pageSize, total: 0 };

  const where = [...scope.where];
  const addFilter = (column: string, value: string | undefined) => {
    if (!value?.trim()) return;
    values.push(value.trim());
    where.push(`${column}=$${values.length}`);
  };
  if (input.query?.trim()) {
    values.push(`%${input.query.trim()}%`);
    const parameter = `$${values.length}`;
    where.push(`(
      q.public_id ilike ${parameter}
      or qr.question_text ilike ${parameter}
      or qr.answer_text ilike ${parameter}
      or q.subject ilike ${parameter}
      or q.grade ilike ${parameter}
      or coalesce(q.chapter,'') ilike ${parameter}
      or coalesce(q.unit,'') ilike ${parameter}
      or q.purpose ilike ${parameter}
      or coalesce(qr.quality_scores #>> '{benchmarkDesign,targetConcept}','') ilike ${parameter}
    )`);
  }
  addFilter('q.purpose', input.purpose);
  addFilter('q.difficulty', input.difficulty);
  addFilter('q.question_type', input.questionType);
  addFilter('q.evidence_mode', input.evidenceMode);
  const countValues = [...values];
  values.push(pageSize, (page - 1) * pageSize);
  const limitParameter = `$${values.length - 1}`;
  const offsetParameter = `$${values.length}`;
  const ordinal = input.scope === 'set' ? 'qsq.ordinal' : input.scope === 'version' ? 'dq.ordinal' : 'null::integer';
  const withSnapshot = dependencies.withSnapshot
    ?? withReadOnlyRepeatableReadTransaction;
  return withSnapshot(async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*) total
       from ${scope.from}
       where ${where.join(' and ')}`,
      countValues,
    );
    const result = await client.query<RawQuestion>(
      `select q.id,q.public_id,q.status,q.subject,q.grade,q.chapter,q.unit,q.purpose,q.difficulty,q.question_type,q.evidence_mode,
        q.current_revision,qr.revision,${ordinal} ordinal,left(qr.question_text,500) question_summary
        from ${scope.from}
        where ${where.join(' and ')}
        order by ${scope.ordinal}
        limit ${limitParameter} offset ${offsetParameter}`,
      values,
    );
    return {
      items: result.rows.map(normalizeQuestionListItem), page, pageSize,
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  });
}

export async function getDatasetAuditQuestionDetail(
  input: GetDatasetAuditQuestionDetailInput,
): Promise<AuditQuestion | null> {
  const values: unknown[] = [];
  const scope = auditScopeSql(input, values);
  if (!scope) return null;
  values.push(input.questionId, input.revision);
  const questionParameter = `$${values.length - 1}`;
  const revisionParameter = `$${values.length}`;
  const result = await db.query<RawQuestion>(
    `select ${questionProjection},${input.scope === 'set' ? 'qsq.ordinal' : input.scope === 'version' ? 'dq.ordinal' : 'null::integer'} ordinal
      from ${scope.from}
      left join generation_batches gb on gb.id=q.generation_batch_id
      where ${[...scope.where, `q.id=${questionParameter}`, `qr.revision=${revisionParameter}`].join(' and ')}`,
    values,
  );
  return result.rows[0] ? normalizeQuestion(result.rows[0]) : null;
}

export async function getDatasetAuditData(): Promise<DatasetAuditData> {
  const [working, sets, versions, pinnedSets, pinnedVersions] = await Promise.all([
    db.query(`select ${questionProjection},null::integer ordinal from questions q
      join question_revisions qr on qr.question_id=q.id and qr.revision=q.current_revision
      left join generation_batches gb on gb.id=q.generation_batch_id
      where q.status='APPROVED' and q.deleted_at is null and coalesce(q.generator_provider,'') <> 'sample'
      and coalesce(q.generator_model,'') not like 'mock-%'
      and not exists (
        select 1 from question_set_questions qsq
        join question_sets qs on qs.id=qsq.question_set_id
        where qsq.question_id=q.id and qs.deleted_at is null
      )
      order by q.public_id`),
    db.query(`select qs.id,qs.title,qs.description,qs.created_at::text created_at,
      qs.updated_at::text updated_at,count(qsq.question_id)::integer question_count
      from question_sets qs
      left join question_set_questions qsq on qsq.question_set_id=qs.id
      where qs.deleted_at is null
      group by qs.id order by qs.updated_at desc,qs.created_at desc`),
    db.query(`select dv.id,dv.version,dv.status,dv.title,dv.description,dv.question_count,dv.distribution,dv.content_hash,
      parent.version parent_version,dv.published_at::text published_at from dataset_versions dv
      left join dataset_versions parent on parent.id=dv.parent_version_id order by dv.published_at desc`),
    db.query(`select ${questionProjection},qsq.ordinal,qsq.question_set_id from question_set_questions qsq
      join question_sets qs on qs.id=qsq.question_set_id and qs.deleted_at is null
      join questions q on q.id=qsq.question_id
      join question_revisions qr on qr.question_id=qsq.question_id and qr.revision=qsq.question_revision
      left join generation_batches gb on gb.id=q.generation_batch_id
      order by qsq.question_set_id,qsq.ordinal`),
    db.query(`select ${questionProjection},dq.ordinal,dq.dataset_version_id from dataset_questions dq
      join questions q on q.id=dq.question_id
      join question_revisions qr on qr.question_id=dq.question_id and qr.revision=dq.question_revision
      left join generation_batches gb on gb.id=q.generation_batch_id order by dq.dataset_version_id,dq.ordinal`),
  ]);
  const pinnedBySet = new Map<string, AuditQuestion[]>();
  for (const row of pinnedSets.rows) {
    const key = String(row.question_set_id);
    pinnedBySet.set(key, [...(pinnedBySet.get(key) ?? []), normalizeQuestion(row)]);
  }
  const pinnedByVersion = new Map<string, AuditQuestion[]>();
  for (const row of pinnedVersions.rows) {
    const key = String(row.dataset_version_id);
    pinnedByVersion.set(key, [...(pinnedByVersion.get(key) ?? []), normalizeQuestion(row)]);
  }
  return {
    workingQuestions: working.rows.map(normalizeQuestion),
    questionSets: sets.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      description: text(row.description),
      questionCount: Number(row.question_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      questions: pinnedBySet.get(String(row.id)) ?? [],
    })),
    versions: versions.rows.map((row) => ({
      id: String(row.id), version: String(row.version), status: String(row.status), title: String(row.title),
      description: text(row.description), questionCount: Number(row.question_count), distribution: record(row.distribution),
      contentHash: String(row.content_hash), parentVersion: text(row.parent_version), publishedAt: String(row.published_at),
      questions: pinnedByVersion.get(String(row.id)) ?? [],
    })),
  };
}
