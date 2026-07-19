import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/server/db/pool';
import { withTransaction } from '@/server/db/transaction';
import { createProviderRegistry } from '@/server/providers/registry';
import { GeminiEmbedder } from '@/server/providers/gemini-embedding';

const generatedSchema = z.array(z.object({
  questionText: z.string().min(5), answerText: z.string().min(1),
  acceptedAnswers: z.array(z.string()).default([]), designSummary: z.string().default(''),
  evidenceSummary: z.string().default(''), evidenceChunkIds: z.array(z.string().uuid()).min(1),
}));

function extractJson(text: string): unknown {
  const start = text.indexOf('['); const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('GENERATION_PARSE_FAILED: 모델 응답에 JSON 배열이 없습니다.');
  return JSON.parse(text.slice(start, end + 1));
}

type Batch = { id: string; requested_count: number; conditions: Record<string, unknown>; source_scope: { sourceFileIds: string[] } };

export async function generateQuestions(batchId: string): Promise<{ questions: number }> {
  const batchResult = await db.query<Batch>('select id, requested_count, conditions, source_scope from generation_batches where id = $1', [batchId]);
  const batch = batchResult.rows[0];
  if (!batch) throw new Error('GENERATION_BATCH_NOT_FOUND: 생성 배치를 찾을 수 없습니다.');
  await db.query("update generation_batches set state = 'RUNNING', progress = jsonb_set(progress, '{currentStage}', '1'), updated_at = now() where id = $1", [batchId]);
  const mock = process.env.MOCK_PROVIDERS?.toLowerCase() === 'true';
  const queryText = [batch.conditions.subject,batch.conditions.grade,...(Array.isArray(batch.conditions.units)?batch.conditions.units:[]),batch.conditions.purpose,batch.conditions.direction].filter(Boolean).join(' · ');
  const units = Array.isArray(batch.conditions.units) && batch.conditions.units.length ? batch.conditions.units.map(String) : null;
  let queryVector: string | null = null; const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL ?? null;
  if (!mock) {
    if (!process.env.GOOGLE_API_KEY || !embeddingModel) throw new Error('GENERATION_EMBEDDING_NOT_CONFIGURED: 검색 질의 임베딩 환경변수가 필요합니다.');
    const [vector] = await new GeminiEmbedder({ apiKey:process.env.GOOGLE_API_KEY, modelId:embeddingModel, dimensions:3072 }).embed([queryText], undefined, 'RETRIEVAL_QUERY');
    queryVector = `[${vector!.join(',')}]`;
  }
  const chunks = await db.query<{ id: string; content: string; page_start: number | null; unit: string | null }>(
    `select id, content, page_start, unit from source_chunks
     where source_file_id = any($1::uuid[]) and ($2::text[] is null or unit = any($2::text[]))
     order by case when $3::vector is null then null else embedding <=> $3::vector end nulls last, source_file_id, ordinal limit $4`,
    [batch.source_scope.sourceFileIds, units, queryVector, Number(batch.conditions.chunkCount ?? 10)],
  );
  if (!chunks.rowCount) throw new Error('GENERATION_EVIDENCE_EMPTY: 선택 범위에서 교과서 청크를 찾지 못했습니다.');
  const registry = createProviderRegistry(); const provider = registry.get('gemini');
  if (!provider) throw new Error('GENERATION_PROVIDER_NOT_CONFIGURED: Gemini 생성 환경변수가 필요합니다.');
  await db.query(`insert into generation_retrievals(generation_batch_id,query_text,embedding_model,candidate_scope,selected_chunks) values($1,$2,$3,$4::jsonb,$5::jsonb)`, [batchId,queryText,embeddingModel,JSON.stringify({sourceFileIds:batch.source_scope.sourceFileIds,units}),JSON.stringify(chunks.rows.map((chunk,index)=>({chunkId:chunk.id,rank:index+1,page:chunk.page_start,unit:chunk.unit})))]);
  const evidence = JSON.stringify(chunks.rows.map((chunk) => ({ chunkId:chunk.id, page:chunk.page_start, unit:chunk.unit, content:chunk.content })), null, 2);
  const generated: z.infer<typeof generatedSchema> = [];
  for (let offset = 0; offset < batch.requested_count; offset += 10) {
    const count = Math.min(10, batch.requested_count - offset);
    if (mock) {
      for (let item = 0; item < count; item += 1) generated.push({ questionText:`[MOCK ${offset+item+1}] ${String(batch.conditions.purpose)} 검증 문항`, answerText:'MOCK 모범 답안', acceptedAnswers:['MOCK 모범 답안'], designSummary:'로컬 파이프라인 검증 전용', evidenceSummary:'첫 번째 검색 청크', evidenceChunkIds:[chunks.rows[(offset+item)%chunks.rows.length]!.id] });
      await db.query("update generation_batches set progress = jsonb_set(jsonb_set(progress, '{currentStage}', '7'), '{completedQuestions}', to_jsonb($2::int)), updated_at = now() where id = $1", [batchId, generated.length]);
      continue;
    }
    const response = await provider.generate({
      system: '당신은 국내 교과서 기반 교육 평가 문항 설계자다. 근거에 없는 사실을 만들지 말고 JSON만 출력한다.',
      prompt: `다음 조건으로 서로 중복되지 않는 문항 ${count}개를 생성하라.\n조건: ${JSON.stringify(batch.conditions)}\n\n검색된 교과서 청크 JSON:\n${evidence}\n\n각 문항은 실제 사용한 chunkId만 evidenceChunkIds에 넣어야 한다. 출력은 [{"questionText":"...","answerText":"...","acceptedAnswers":[],"designSummary":"...","evidenceSummary":"...","evidenceChunkIds":["uuid"]}] 형식의 JSON 배열만 사용하라.`,
      maxOutputTokens: 8192, temperature: 0.2,
    });
    const parsed = generatedSchema.parse(extractJson(response.text));
    if (parsed.length !== count) throw new Error(`GENERATION_COUNT_MISMATCH: ${count}개를 요청했지만 ${parsed.length}개를 받았습니다.`);
    generated.push(...parsed);
    await db.query("update generation_batches set progress = jsonb_set(jsonb_set(progress, '{currentStage}', '7'), '{completedQuestions}', to_jsonb($2::int)), updated_at = now() where id = $1", [batchId, generated.length]);
  }
  const allowedChunkIds = new Set(chunks.rows.map((chunk) => chunk.id));
  if (generated.some((question) => question.evidenceChunkIds.some((id) => !allowedChunkIds.has(id)))) throw new Error('GENERATION_EVIDENCE_SCOPE_VIOLATION: 모델이 검색 범위 밖의 청크를 인용했습니다.');
  await withTransaction(async (client) => {
    for (const [index, question] of generated.entries()) {
      const questionId = randomUUID();
      const publicId = `Q-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${questionId.slice(0, 8).toUpperCase()}`;
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
          JSON.stringify([{ key: 'accuracy', label: '정확성', maxScore: 1 }, { key: 'completeness', label: '설명 완결성', maxScore: 1 }]),
          JSON.stringify(question.acceptedAnswers), question.designSummary, question.evidenceSummary,
          JSON.stringify({ pipelineComplete: true, ordinal: index + 1 })],
      );
      const cited = question.evidenceChunkIds.map((chunkId) => chunks.rows.find((chunk) => chunk.id === chunkId)!);
      for (const [evidenceIndex, chunk] of cited.entries()) await client.query(
        `insert into question_evidence(question_id, question_revision, source_chunk_id, ordinal, quote_text)
         values ($1,1,$2,$3,$4)`, [questionId, chunk.id, evidenceIndex + 1, chunk.content],
      );
    }
    await client.query("update generation_batches set state = 'COMPLETED', progress = jsonb_set(jsonb_set(progress, '{currentStage}', '9'), '{completedQuestions}', to_jsonb($2::int)), updated_at = now() where id = $1", [batchId, generated.length]);
  });
  return { questions: generated.length };
}

export async function markGenerationFailed(batchId: string, error: unknown) {
  const message = error instanceof Error ? error.message : '알 수 없는 질문 생성 오류';
  await db.query("update generation_batches set state = 'FAILED', progress = jsonb_set(progress, '{error}', to_jsonb($2::text)), updated_at = now() where id = $1", [batchId, message]);
}
