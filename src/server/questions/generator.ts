import { randomUUID } from 'node:crypto';
import { mapConcurrentOrdered } from '@/domain/parallel';
import { benchmarkTaskForOrdinal, prerequisiteScoringCriteria } from '@/domain/prerequisite-benchmark';
import { buildQuestionGenerationInstructions, thinkingLevelForDifficulty } from '@/domain/question-prompt';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { recordGenerationEvent } from '@/server/generation/activity';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';
import { createProviderRegistry } from '@/server/providers/registry';
import {
  QUESTION_GENERATION_MAX_OUTPUT_TOKENS,
  buildQuestionDirectionInstructions,
  parseQuestionDirectionResponse,
  questionDirectionJsonSchema,
  type QuestionDirection,
} from '@/server/questions/direction';
import {
  generatedQuestionResponseJsonSchema,
  parseGeneratedQuestionResponse,
  validateGeneratedQuestionForType,
  type GeneratedQuestion,
} from '@/server/questions/response';

type Batch = {
  id: string;
  requested_count: number;
  conditions: Record<string, unknown>;
  source_scope: { sourceFileIds: string[]; tocEntryIds?: string[] };
};
type GenerationOptions = { signal?: AbortSignal; jobId?: string };

function errorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : '알 수 없는 질문 생성 오류';
  return { code: message.split(':', 1)[0] || 'GENERATION_FAILED', message };
}

async function incrementProgress(batchId: string, field: 'completedQuestions' | 'failedQuestions') {
  await db.query(
    `update generation_batches
        set progress = jsonb_set(
          jsonb_set(progress, '{currentStage}', '7'),
          $2::text[],
          to_jsonb(coalesce((progress->>$3)::int, 0) + 1)
        ), updated_at = now()
      where id = $1`,
    [batchId, `{${field}}`, field],
  );
}

export async function generateQuestions(batchId: string, options: GenerationOptions = {}): Promise<{ questions: number }> {
  const jobId = options.jobId ?? null;
  const log = (eventType: string, payload: Record<string, unknown> = {}) =>
    recordGenerationEvent(batchId, jobId, eventType, payload);
  const batchResult = await db.query<Batch>(
    'select id, requested_count, conditions, source_scope from generation_batches where id = $1',
    [batchId],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new Error('GENERATION_BATCH_NOT_FOUND: 생성 배치를 찾을 수 없습니다.');
  const executionMode = batch.conditions.executionMode === 'parallel' ? 'parallel' : 'sequential';
  const concurrency = executionMode === 'parallel'
    ? Math.max(1, Number(process.env.QUESTION_GENERATION_CONCURRENCY ?? 4))
    : 1;
  await db.query(
    `update generation_batches
        set state = 'RUNNING',
            progress = (progress - 'error') || '{"currentStage":1,"completedQuestions":0,"failedQuestions":0}'::jsonb,
            updated_at = now()
      where id = $1`,
    [batchId],
  );
  await log('GENERATION_STARTED', { requestedCount: batch.requested_count, executionMode, concurrency });

  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL ?? null;
  if (!mock) {
    if (!process.env.GOOGLE_API_KEY || !embeddingModel) {
      throw new Error('GENERATION_EMBEDDING_NOT_CONFIGURED: 검색 질의 임베딩 환경변수가 필요합니다.');
    }
  }

  const registry = createProviderRegistry();
  const provider = registry.get('gemini');
  if (!provider) throw new Error('GENERATION_PROVIDER_NOT_CONFIGURED: Gemini 생성 환경변수가 필요합니다.');
  const embedder = !mock ? new GeminiEmbedder({
    apiKey: process.env.GOOGLE_API_KEY!,
    modelId: embeddingModel!,
    dimensions: 3072,
    baseUrl: process.env.GEMINI_BASE_URL,
  }) : null;
  const ordinals = Array.from({ length: batch.requested_count }, (_, index) => index + 1);

  const generated = await mapConcurrentOrdered(ordinals, concurrency, async (ordinal) => {
    try {
      await log('QUESTION_DIRECTION_STARTED', { ordinal, total: batch.requested_count });
      let questionDirection: QuestionDirection;
      if (mock) {
        questionDirection = {
          directionSummary: `${ordinal}번 문항의 독립적인 선수관계 측정 방향`,
          targetConceptQuery: `${String(batch.conditions.subject ?? '')} 목표 개념 ${ordinal}`,
          prerequisiteQuery: `${String(batch.conditions.subject ?? '')} 선수 개념 ${ordinal}`,
          searchQuery: `${String(batch.conditions.subject ?? '')} 목표 개념 ${ordinal} 선수 관계 학습 순서`,
        };
      } else {
        const directionInstructions = buildQuestionDirectionInstructions({
          conditions: batch.conditions,
          ordinal,
          total: batch.requested_count,
        });
        const directionResponse = await provider.generate({
          system: directionInstructions.system,
          prompt: directionInstructions.prompt,
          maxOutputTokens: 2_048,
          temperature: 0.3,
          responseMimeType: 'application/json',
          responseJsonSchema: questionDirectionJsonSchema,
          thinkingLevel: 'LOW',
        }, options.signal);
        if (directionResponse.finishReason && directionResponse.finishReason !== 'STOP') {
          throw new Error(`DIRECTION_INCOMPLETE_RESPONSE: Gemini 방향성 응답이 완료되지 않았습니다. finishReason=${directionResponse.finishReason}`);
        }
        questionDirection = parseQuestionDirectionResponse(directionResponse.text);
      }
      await log('QUESTION_DIRECTION_COMPLETED', { ordinal, total: batch.requested_count, ...questionDirection });

      await log('QUESTION_RETRIEVAL_STARTED', { ordinal, total: batch.requested_count, queryText: questionDirection.searchQuery });
      let queryVector: string | null = null;
      if (embedder) {
        const [vector] = await embedder.embed([questionDirection.searchQuery], options.signal, 'RETRIEVAL_QUERY');
        queryVector = `[${vector!.join(',')}]`;
      }
      const semanticChunks = await db.query<{ id: string; content: string; page_start: number | null; unit: string | null; source_file_id: string; ordinal: number }>(
        `select id, content, page_start, unit, source_file_id, ordinal from source_chunks
         where source_file_id = any($1::uuid[])
         order by case when $2::vector is null then null else embedding <=> $2::vector end nulls last,
                  source_file_id, ordinal
         limit $3`,
        [batch.source_scope.sourceFileIds, queryVector, Number(batch.conditions.chunkCount ?? 10)],
      );
      const precedingChunks = semanticChunks.rowCount ? await db.query<{ id: string; content: string; page_start: number | null; unit: string | null; source_file_id: string; ordinal: number }>(
        `select distinct prior.id, prior.content, prior.page_start, prior.unit, prior.source_file_id, prior.ordinal
           from source_chunks hit join source_chunks prior on prior.source_revision_id=hit.source_revision_id
            and prior.ordinal between greatest(1, hit.ordinal - 2) and hit.ordinal - 1
          where hit.id = any($1::uuid[])
          order by prior.source_file_id, prior.ordinal`,
        [semanticChunks.rows.map((chunk) => chunk.id)],
      ) : { rows: [], rowCount: 0 };
      const chunks = {
        rows: [...new Map([...precedingChunks.rows, ...semanticChunks.rows].map((chunk) => [chunk.id, chunk])).values()],
        rowCount: 0,
      };
      chunks.rowCount = chunks.rows.length;
      if (!chunks.rowCount) throw new Error(`GENERATION_EVIDENCE_EMPTY: ${ordinal}번 문항 방향에서 교과서 청크를 찾지 못했습니다.`);
      await db.query(
        `insert into generation_retrievals(generation_batch_id,query_text,embedding_model,candidate_scope,selected_chunks)
         values($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [batchId, questionDirection.searchQuery, embeddingModel,
          JSON.stringify({ ordinal, questionDirection, sourceFileIds: batch.source_scope.sourceFileIds, tocEntryIds: batch.source_scope.tocEntryIds ?? [], units: batch.conditions.units ?? [] }),
          JSON.stringify(chunks.rows.map((chunk, index) => ({ chunkId: chunk.id, rank: index + 1, page: chunk.page_start, unit: chunk.unit })))],
      );
      await log('QUESTION_RETRIEVAL_COMPLETED', {
        ordinal,
        total: batch.requested_count,
        queryText: questionDirection.searchQuery,
        chunkCount: chunks.rowCount,
        chunks: chunks.rows.map((chunk, index) => ({ chunkId: chunk.id, rank: index + 1, page: chunk.page_start, unit: chunk.unit })),
      });

      const evidence = JSON.stringify(chunks.rows.map((chunk) => ({
        chunkId: chunk.id, page: chunk.page_start, unit: chunk.unit, content: chunk.content,
      })), null, 2);
      const allowedChunkIds = new Set(chunks.rows.map((chunk) => chunk.id));
      await log('QUESTION_GENERATION_STARTED', { ordinal, total: batch.requested_count, executionMode, directionSummary: questionDirection.directionSummary });
      let question: GeneratedQuestion;
      if (mock) {
        const citedChunkId = chunks.rows[(ordinal - 1) % chunks.rows.length]!.id;
        const targetConcept = `MOCK 목표 개념 ${ordinal}`;
        question = {
          questionText: `[MOCK ${ordinal}] ${String(batch.conditions.purpose)} 검증 문항`,
          answerText: 'MOCK 모범 답안', acceptedAnswers: ['MOCK 모범 답안'], answerOptions: [],
          designSummary: '로컬 파이프라인 검증 전용', evidenceSummary: '검색 청크 근거',
          evidenceChunkIds: [citedChunkId],
          benchmarkDesign: {
            benchmarkType: 'PREREQUISITE_RELATIONSHIP', taskType: benchmarkTaskForOrdinal(ordinal), targetConcept,
            prerequisiteConcepts: [{ concept: `MOCK 선수 개념 ${ordinal}`, role: '목표 개념의 이해에 먼저 필요한 개념', evidenceChunkIds: [citedChunkId] }],
            prerequisiteRelations: [{ fromConcept: `MOCK 선수 개념 ${ordinal}`, toConcept: targetConcept, relationType: 'REQUIRES', explanation: '선수 개념을 먼저 적용해야 목표 개념을 판단할 수 있다.', evidenceChunkIds: [citedChunkId] }],
            requiredReasoningSteps: ['선수 개념을 식별한다.', '선수 개념을 목표 개념 판단에 적용한다.'],
            failureSignals: ['선수 개념을 적용하지 않고 결론만 제시한다.'],
          },
        };
      } else {
        const instructions = buildQuestionGenerationInstructions({
          conditions: {
            ...batch.conditions,
            direction: `${String(batch.conditions.direction ?? '')}\n이번 문항 전용 방향성: ${questionDirection.directionSummary}`.trim(),
          },
          ordinal,
          total: batch.requested_count,
          evidence,
        });
        const response = await provider.generate({
          system: instructions.system,
          prompt: instructions.prompt,
          maxOutputTokens: QUESTION_GENERATION_MAX_OUTPUT_TOKENS,
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: generatedQuestionResponseJsonSchema,
          thinkingLevel: thinkingLevelForDifficulty(batch.conditions.difficulty),
        }, options.signal);
        if (response.finishReason && response.finishReason !== 'STOP') {
          throw new Error(`GENERATION_INCOMPLETE_RESPONSE: Gemini 응답이 완료되지 않았습니다. finishReason=${response.finishReason}`);
        }
        question = parseGeneratedQuestionResponse(response.text);
        validateGeneratedQuestionForType(question, batch.conditions.questionType);
      }
      if (question.evidenceChunkIds.some((id) => !allowedChunkIds.has(id))) {
        throw new Error('GENERATION_EVIDENCE_SCOPE_VIOLATION: 모델이 검색 범위 밖의 청크를 인용했습니다.');
      }
      const designChunkIds = [
        ...question.benchmarkDesign.prerequisiteConcepts.flatMap((concept) => concept.evidenceChunkIds),
        ...question.benchmarkDesign.prerequisiteRelations.flatMap((relation) => relation.evidenceChunkIds),
      ];
      if (designChunkIds.some((id) => !allowedChunkIds.has(id))) {
        throw new Error('GENERATION_EVIDENCE_SCOPE_VIOLATION: 선수 관계 청사진이 검색 범위 밖의 청크를 인용했습니다.');
      }
      await incrementProgress(batchId, 'completedQuestions');
      await log('QUESTION_GENERATION_COMPLETED', { ordinal, total: batch.requested_count, questionDirection, ...question });
      return { question, chunks, questionDirection };
    } catch (error) {
      const detail = errorDetail(error);
      await incrementProgress(batchId, 'failedQuestions');
      await log('QUESTION_GENERATION_FAILED', { ordinal, total: batch.requested_count, ...detail });
      throw error;
    }
  });

  const publicIds: string[] = [];
  await withTransaction(async (client) => {
    for (const [index, generatedItem] of generated.entries()) {
      const { question, chunks, questionDirection } = generatedItem;
      const questionId = randomUUID();
      const publicId = `Q-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${questionId.slice(0, 8).toUpperCase()}`;
      publicIds.push(publicId);
      await client.query(
        `insert into questions(id, public_id, generation_batch_id, status, subject, grade, unit, purpose, difficulty, question_type, evidence_mode, generator_provider, generator_model, embedding_model)
         values ($1,$2,$3,'IN_REVIEW',$4,$5,$6,$7,$8,$9,'GROUNDED','gemini',$10,$11)`,
        [questionId, publicId, batchId, String(batch.conditions.subject ?? ''), String(batch.conditions.grade ?? ''),
          Array.isArray(batch.conditions.units) ? batch.conditions.units.join(', ') : null,
          String(batch.conditions.purpose ?? ''), String(batch.conditions.difficulty ?? '중'),
          String(batch.conditions.questionType ?? '서술형'), provider.modelId, process.env.GEMINI_EMBEDDING_MODEL ?? 'not-used'],
      );
      await client.query(
        `insert into question_revisions(question_id, revision, question_text, answer_text, scoring_criteria, accepted_answers, design_summary, evidence_summary, quality_scores, change_reason)
         values ($1,1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,'question-generation-v1')`,
        [questionId, question.questionText, question.answerText,
          JSON.stringify(prerequisiteScoringCriteria),
          JSON.stringify(question.acceptedAnswers), question.designSummary, question.evidenceSummary,
          JSON.stringify({ pipelineComplete: true, ordinal: index + 1, questionDirection, benchmarkDesign: question.benchmarkDesign })],
      );
      await client.query(
        'update question_revisions set answer_options = $2::jsonb where question_id = $1 and revision = 1',
        [questionId, JSON.stringify(question.answerOptions)],
      );
      const cited = question.evidenceChunkIds.map((chunkId) => chunks.rows.find((chunk) => chunk.id === chunkId)!);
      for (const [evidenceIndex, chunk] of cited.entries()) {
        await client.query(
          `insert into question_evidence(question_id, question_revision, source_chunk_id, ordinal, quote_text)
           values ($1,1,$2,$3,$4)`,
          [questionId, chunk.id, evidenceIndex + 1, chunk.content],
        );
      }
    }
    await client.query(
      `update generation_batches
          set state = 'COMPLETED',
              progress = jsonb_set(jsonb_set(progress, '{currentStage}', '9'), '{completedQuestions}', to_jsonb($2::int)),
              updated_at = now()
        where id = $1`,
      [batchId, generated.length],
    );
  });
  await log('GENERATION_COMPLETED', { questionCount: generated.length, publicIds });
  return { questions: generated.length };
}

export async function markGenerationFailed(batchId: string, error: unknown, jobId?: string) {
  const detail = errorDetail(error);
  await db.query(
    `update generation_batches
        set state = 'FAILED', progress = jsonb_set(progress, '{error}', to_jsonb($2::text)), updated_at = now()
      where id = $1`,
    [batchId, detail.message],
  );
  await recordGenerationEvent(batchId, jobId ?? null, 'GENERATION_FAILED', detail);
}
