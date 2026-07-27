import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError } from '@/domain/errors';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';

export type QuestionSetTarget =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; title: string; description?: string };

export type QuestionSetItem = {
  id: string;
  title: string;
  description: string | null;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
  questions: [];
};

export type PublishQuestionSetInput = {
  version: string;
  title: string;
  description?: string;
};

export type PublishedQuestionSetDataset = {
  id: string;
  version: string;
  title: string;
  questionCount: number;
  contentHash: string;
  existing: boolean;
};

type QuestionSetRow = {
  id: string;
  title: string;
  description: string | null;
  question_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type PinnedQuestionRow = {
  id: string;
  public_id: string;
  status: string;
  question_revision: number;
  ordinal: number;
  purpose: string;
  question_type: string;
  evidence_mode: string;
  question_text: string;
  answer_text: string;
  answer_options: unknown;
  scoring_criteria: unknown;
  accepted_answers: unknown;
  design_summary: string | null;
  evidence_summary: string | null;
  evidence: unknown;
};

type ExistingDatasetRow = {
  id: string;
  version: string;
  title: string;
  question_count: number;
  content_hash: string;
};

const questionSetProjection = `
  question_set.id,
  question_set.title,
  question_set.description,
  question_set.created_at,
  question_set.updated_at,
  (
    select count(*)::int
      from question_set_questions item
     where item.question_set_id = question_set.id
  ) question_count
`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeQuestionSet(row: QuestionSetRow): QuestionSetItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    questionCount: Number(row.question_count),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    questions: [],
  };
}

async function lockQuestionSet(
  client: PoolClient,
  questionSetId: string,
): Promise<QuestionSetItem> {
  const result = await client.query<QuestionSetRow>(
    `select ${questionSetProjection}
       from question_sets question_set
      where question_set.id = $1
        and question_set.deleted_at is null
      for update of question_set`,
    [questionSetId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError(
      'QUESTION_SET_NOT_FOUND',
      '질문 세트를 찾을 수 없습니다.',
      { questionSetId },
    );
  }
  return normalizeQuestionSet(row);
}

export async function listQuestionSets(): Promise<QuestionSetItem[]> {
  const result = await db.query<QuestionSetRow>(
    `select ${questionSetProjection}
       from question_sets question_set
      where question_set.deleted_at is null
      order by question_set.created_at, question_set.id`,
  );
  return result.rows.map(normalizeQuestionSet);
}

export async function createQuestionSetWithClient(
  client: PoolClient,
  input: { title: string; description?: string },
): Promise<QuestionSetItem> {
  const result = await client.query<QuestionSetRow>(
    `insert into question_sets(id, title, description)
     values ($1, $2, $3)
     returning id, title, description, created_at, updated_at,
       0::int question_count`,
    [randomUUID(), input.title.trim(), input.description?.trim() || null],
  );
  return normalizeQuestionSet(result.rows[0]!);
}

export function createQuestionSet(
  input: { title: string; description?: string },
): Promise<QuestionSetItem> {
  return withTransaction((client) => createQuestionSetWithClient(client, input));
}

export async function assignQuestionToTargetSet(
  client: PoolClient,
  target: QuestionSetTarget,
  questionId: string,
  questionRevision: number,
): Promise<{ item: QuestionSetItem; created: boolean }> {
  const created = target.kind === 'new';
  const questionSet = created
    ? await createQuestionSetWithClient(client, target)
    : await lockQuestionSet(client, target.id);

  const ordinalResult = await client.query<{ ordinal: number }>(
    `select coalesce(max(ordinal), 0)::int + 1 ordinal
       from question_set_questions
      where question_set_id = $1`,
    [questionSet.id],
  );
  const ordinal = ordinalResult.rows[0]?.ordinal ?? 1;

  try {
    await client.query(
      `insert into question_set_questions(
         question_set_id, question_id, question_revision, ordinal
       ) values ($1, $2, $3, $4)`,
      [questionSet.id, questionId, questionRevision, ordinal],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new DomainError(
        'QUESTION_SET_MEMBERSHIP_CONFLICT',
        '이 문항은 이미 선택한 질문 세트에 포함되어 있습니다.',
        { questionSetId: questionSet.id, questionId },
      );
    }
    throw error;
  }

  const updated = await client.query<QuestionSetRow>(
    `update question_sets question_set
        set updated_at = now()
      where question_set.id = $1
      returning ${questionSetProjection}`,
    [questionSet.id],
  );
  return {
    item: normalizeQuestionSet(updated.rows[0]!),
    created,
  };
}

export function softDeleteQuestionSet(
  questionSetId: string,
): Promise<QuestionSetItem> {
  return withTransaction(async (client) => {
    await lockQuestionSet(client, questionSetId);
    const result = await client.query<QuestionSetRow>(
      `update question_sets question_set
          set deleted_at = now(), updated_at = now()
        where question_set.id = $1
        returning ${questionSetProjection}`,
      [questionSetId],
    );
    return normalizeQuestionSet(result.rows[0]!);
  });
}

export function removeQuestionFromSet(
  questionSetId: string,
  questionId: string,
): Promise<{ item: QuestionSetItem; removedQuestionId: string }> {
  return withTransaction(async (client) => {
    await lockQuestionSet(client, questionSetId);
    const removed = await client.query<{ ordinal: number }>(
      `delete from question_set_questions
        where question_set_id = $1 and question_id = $2
        returning ordinal`,
      [questionSetId, questionId],
    );
    const ordinal = removed.rows[0]?.ordinal;
    if (ordinal == null) {
      throw new DomainError(
        'QUESTION_SET_QUESTION_NOT_FOUND',
        '질문 세트에 해당 문항이 없습니다.',
        { questionSetId, questionId },
      );
    }

    await client.query(
      'set constraints question_set_questions_ordinal_key deferred',
    );
    await client.query(
      `update question_set_questions
          set ordinal = ordinal - 1
        where question_set_id = $1 and ordinal > $2`,
      [questionSetId, ordinal],
    );
    const updated = await client.query<QuestionSetRow>(
      `update question_sets question_set
          set updated_at = now()
        where question_set.id = $1
        returning ${questionSetProjection}`,
      [questionSetId],
    );
    return {
      item: normalizeQuestionSet(updated.rows[0]!),
      removedQuestionId: questionId,
    };
  });
}

function countBy(
  rows: PinnedQuestionRow[],
  key: 'purpose' | 'question_type' | 'evidence_mode',
): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = row[key];
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function existingDatasetResult(
  row: ExistingDatasetRow,
): PublishedQuestionSetDataset {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    questionCount: row.question_count,
    contentHash: row.content_hash,
    existing: true,
  };
}

function isDatasetVersionUniqueViolation(error: unknown): boolean {
  const postgresError = error as { code?: string; constraint?: string };
  return postgresError.code === '23505'
    && [
      'dataset_versions_version_key',
      'dataset_versions_content_hash_key',
    ].includes(postgresError.constraint ?? '');
}

export async function publishQuestionSet(
  questionSetId: string,
  input: PublishQuestionSetInput,
): Promise<PublishedQuestionSetDataset> {
  let attemptedContentHash: string | null = null;
  try {
    return await withTransaction(async (client) => {
      const questionSet = await lockQuestionSet(client, questionSetId);
      const questions = await client.query<PinnedQuestionRow>(
      `select
         question.id,
         question.public_id,
         question.status,
         item.question_revision,
         item.ordinal,
         question.purpose,
         question.question_type,
         question.evidence_mode,
         revision.question_text,
         revision.answer_text,
         revision.answer_options,
         revision.scoring_criteria,
         revision.accepted_answers,
         revision.design_summary,
         revision.evidence_summary,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'chunkId', evidence.source_chunk_id,
               'ordinal', evidence.ordinal,
               'role', evidence.role,
               'quote', evidence.quote_text
             )
             order by evidence.ordinal
           )
           from question_evidence evidence
           where evidence.question_id = question.id
             and evidence.question_revision = item.question_revision
         ), '[]'::jsonb) evidence
       from question_set_questions item
       join questions question on question.id = item.question_id
       join question_revisions revision
         on revision.question_id = item.question_id
        and revision.revision = item.question_revision
      where item.question_set_id = $1
      order by item.ordinal`,
      [questionSetId],
    );
      if (!questions.rowCount) {
        throw new DomainError(
          'QUESTION_SET_EMPTY',
          '빈 질문 세트는 데이터셋으로 발행할 수 없습니다.',
          { questionSetId },
        );
      }
      if (questions.rows.length > 5000) {
        throw new DomainError(
          'QUESTION_SET_TOO_LARGE',
          '데이터셋에는 최대 5000개 문항을 포함할 수 있습니다.',
          { questionSetId },
        );
      }
      if (questions.rows.some((question) => question.status !== 'APPROVED')) {
        throw new DomainError(
          'QUESTION_SET_QUESTIONS_NOT_APPROVED',
          '질문 세트의 모든 문항이 승인 상태여야 합니다.',
          { questionSetId },
        );
      }

      const contentHash = createHash('sha256')
        .update(JSON.stringify(questions.rows))
        .digest('hex');
      attemptedContentHash = contentHash;
      const existing = await client.query<ExistingDatasetRow>(
        `select id, version, title, question_count, content_hash
           from dataset_versions
          where version = $1 or content_hash = $2`,
        [input.version, contentHash],
      );
      const existingDataset = existing.rows[0];
      if (existingDataset) {
        if (
          existingDataset.version !== input.version
          || existingDataset.content_hash !== contentHash
        ) {
          throw new DomainError(
            'DATASET_VERSION_CONFLICT',
            '버전 또는 내용 해시가 기존 데이터셋과 충돌합니다.',
          );
        }
        return existingDatasetResult(existingDataset);
      }

      const distribution = {
        capabilities: countBy(questions.rows, 'purpose'),
        responseFormats: countBy(questions.rows, 'question_type'),
        evidenceModes: countBy(questions.rows, 'evidence_mode'),
      };
      const datasetId = randomUUID();
      await client.query(
        `insert into dataset_versions(
           id, version, status, title, description, question_count,
           distribution, content_hash, source_question_set_id, published_at
         ) values ($1, $2, 'DRAFT', $3, $4, $5, $6::jsonb, $7, $8, now())`,
        [
          datasetId,
          input.version,
          input.title,
          input.description?.trim() || questionSet.description,
          questions.rows.length,
          JSON.stringify(distribution),
          contentHash,
          questionSetId,
        ],
      );
      for (const question of questions.rows) {
        await client.query(
          `insert into dataset_questions(
             dataset_version_id, question_id, question_revision, ordinal
           ) values ($1, $2, $3, $4)`,
          [
            datasetId,
            question.id,
            question.question_revision,
            question.ordinal,
          ],
        );
      }
      await client.query(
        `update dataset_versions
            set status = 'PUBLISHED', published_at = now()
          where id = $1`,
        [datasetId],
      );
      return {
        id: datasetId,
        version: input.version,
        title: input.title,
        questionCount: questions.rows.length,
        contentHash,
        existing: false,
      };
    });
  } catch (error) {
    if (!isDatasetVersionUniqueViolation(error) || !attemptedContentHash) {
      throw error;
    }
    const existing = await db.query<ExistingDatasetRow>(
      `select id, version, title, question_count, content_hash
         from dataset_versions
        where version = $1 or content_hash = $2`,
      [input.version, attemptedContentHash],
    );
    const existingDataset = existing.rows[0];
    if (
      existingDataset
      && existingDataset.version === input.version
      && existingDataset.content_hash === attemptedContentHash
    ) {
      return existingDatasetResult(existingDataset);
    }
    throw new DomainError(
      'DATASET_VERSION_CONFLICT',
      '버전 또는 내용 해시가 기존 데이터셋과 충돌합니다.',
    );
  }
}
