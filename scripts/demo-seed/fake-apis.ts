import { createHash } from 'node:crypto';
import type { GenerationRequest, ModelProvider, NormalizedGeneration } from '@/server/providers/types';
import { DEMO_QUESTION_BANK, type DemoQuestion } from './questions';
import { pageHtml, pageMarkdown, type DemoTextbook } from './textbooks';

// Deterministic stand-ins for the external APIs, used only while seeding.
// Every outgoing request is answered locally; anything unexpected throws so
// the seed can never reach a real provider.

function hashUnit(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0) / 0xffffffff;
}

function bigrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) grams.add(compact.slice(index, index + 2));
  return grams;
}

/** Share of the reference's character bigrams that also appear in the candidate. */
function coverage(candidate: string, reference: string): number {
  const ref = bigrams(reference);
  if (!ref.size) return 0;
  const cand = bigrams(candidate);
  let hit = 0;
  for (const gram of ref) if (cand.has(gram)) hit += 1;
  return hit / ref.size;
}

/** Hashed character-bigram embedding so cosine similarity follows word overlap. */
export function demoEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const gram of bigrams(text)) {
    const digest = createHash('md5').update(gram).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    vector[index]! += digest[4]! & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...vector) || 1;
  // A tiny constant component keeps even an empty text away from the zero vector.
  return vector.map((value, index) => (index === 0 ? value / norm + 1e-3 : value / norm));
}

function findQuestionByText(text: string): { subject: 'science' | 'math'; question: DemoQuestion } | null {
  for (const subject of ['science', 'math'] as const) {
    const question = DEMO_QUESTION_BANK[subject].find((candidate) => text.includes(candidate.questionText));
    if (question) return { subject, question };
  }
  return null;
}

function bankFromPrompt(prompt: string): { subject: 'science' | 'math'; question: DemoQuestion; ordinal: number } {
  const subject = /- 과목: 수학/.test(prompt) ? 'math' : 'science';
  const ordinal = Number(/총 \d+개 중 (\d+)번째/.exec(prompt)?.[1] ?? 1);
  const bank = DEMO_QUESTION_BANK[subject];
  return { subject, ordinal, question: bank[(ordinal - 1) % bank.length]! };
}

type EvidenceChunk = { chunkId: string; content: string };

function evidenceFromPrompt(prompt: string): EvidenceChunk[] {
  const marker = '[사용 가능한 교과서 근거]';
  const start = prompt.indexOf(marker);
  if (start < 0) return [];
  const rest = prompt.slice(start + marker.length);
  const end = rest.indexOf('[제출 전 자체 검증]');
  return JSON.parse((end < 0 ? rest : rest.slice(0, end)).trim()) as EvidenceChunk[];
}

function pickEvidence(question: DemoQuestion, evidence: EvidenceChunk[]): string[] {
  const ranked = evidence
    .map((chunk) => ({
      id:chunk.chunkId,
      score:question.keywords.filter((keyword) => chunk.content.includes(keyword)).length
        + coverage(chunk.content, question.answerText),
    }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, 2).map((entry) => entry.id);
}

function generatedQuestionJson(prompt: string): string {
  const { question } = bankFromPrompt(prompt);
  const evidence = evidenceFromPrompt(prompt);
  const chunkIds = pickEvidence(question, evidence);
  if (!chunkIds.length) throw new Error('DEMO_SEED: 생성 프롬프트에 근거 청크가 없습니다.');
  const taskType = /\(([a-z_]+)\)\. benchmarkDesign\.taskType/.exec(prompt)?.[1] ?? 'dependency_application';
  return JSON.stringify({
    questionText:question.questionText,
    answerText:question.answerText,
    acceptedAnswers:question.acceptedAnswers,
    answerOptions:[],
    designSummary:question.designSummary,
    evidenceSummary:question.evidenceSummary,
    evidenceChunkIds:chunkIds,
    benchmarkDesign:{
      benchmarkType:'PREREQUISITE_RELATIONSHIP',
      taskType,
      targetConcept:question.targetConcept,
      prerequisiteConcepts:question.prerequisites.map((prerequisite) => ({
        ...prerequisite,
        evidenceChunkIds:chunkIds,
      })),
      prerequisiteRelations:question.prerequisites.map((prerequisite) => ({
        fromConcept:prerequisite.concept,
        toConcept:question.targetConcept,
        relationType:'REQUIRES',
        explanation:question.relationExplanation,
        evidenceChunkIds:chunkIds,
      })),
      requiredReasoningSteps:question.reasoningSteps,
      failureSignals:question.failureSignals,
    },
  });
}

function directionJson(prompt: string): string {
  const { question } = bankFromPrompt(prompt);
  return JSON.stringify({
    directionSummary:question.directionSummary,
    targetConceptQuery:question.targetConceptQuery,
    prerequisiteQuery:question.prerequisiteQuery,
    searchQuery:question.searchQuery,
  });
}

function quarter(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 4) / 4;
}

function judgeJson(prompt: string): string {
  const payload = JSON.parse(prompt) as {
    requiredMetrics: string[];
    referenceAnswer: string;
    candidateResponse: string;
  };
  const quality = coverage(payload.candidateResponse ?? '', payload.referenceAnswer ?? '');
  return JSON.stringify({
    scores:payload.requiredMetrics.map((metricKey) => {
      const jitter = (hashUnit(`${metricKey}:${payload.candidateResponse}`) - 0.5) * 0.3;
      const value = quarter(0.1 + quality * 1.15 + jitter);
      return {
        metricKey,
        value,
        label:value >= 0.75 ? '충족' : value >= 0.5 ? '부분 충족' : '미흡',
        rationale:value >= 0.75
          ? '모범 답안의 선수 개념과 추론 단계를 대부분 포함한다.'
          : value >= 0.5
            ? '결론은 맞지만 선수 개념을 목표 개념에 연결하는 설명이 부족하다.'
            : '핵심 선수 관계를 잘못 적용했거나 교과서 근거와 다른 설명을 포함한다.',
        evidence:[],
      };
    }),
  });
}

function geminiResponse(text: string, prompt: string, model: string): Response {
  const requestId = `demo-${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;
  return new Response(JSON.stringify({
    candidates:[{ content:{ parts:[{ text }] }, finishReason:'STOP' }],
    usageMetadata:{
      promptTokenCount:Math.ceil(prompt.length / 2),
      candidatesTokenCount:Math.ceil(text.length / 2),
    },
    modelVersion:model,
  }), { status:200, headers:{ 'content-type':'application/json', 'x-request-id':requestId } });
}

export type FakeApiState = { textbook: DemoTextbook | null };

export function installFakeFetch(state: FakeApiState): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.endsWith('/document-digitization')) {
      const form = init?.body as FormData;
      const file = form.get('document') as File;
      const pageNumber = Number(/page-(\d+)\./.exec(file.name)?.[1]);
      const page = state.textbook?.pages[pageNumber - 1];
      if (!page) throw new Error(`DEMO_SEED: 알 수 없는 페이지 ${file.name}`);
      return new Response(JSON.stringify({
        content:{ html:pageHtml(page), markdown:pageMarkdown(page) },
        model:'document-parse-demo',
      }), { status:200, headers:{ 'content-type':'application/json', 'x-request-id':`demo-parse-${pageNumber}` } });
    }

    if (url.includes(':batchEmbedContents')) {
      const body = JSON.parse(String(init?.body)) as {
        requests: Array<{ content: { parts: Array<{ text: string }> }; outputDimensionality?: number }>;
      };
      return new Response(JSON.stringify({
        embeddings:body.requests.map((request) => ({
          values:demoEmbedding(request.content.parts[0]!.text, request.outputDimensionality ?? 3072),
        })),
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }

    if (url.includes(':generateContent')) {
      const body = JSON.parse(String(init?.body)) as {
        systemInstruction: { parts: Array<{ text: string }> };
        contents: Array<{ parts: Array<{ text: string }> }>;
      };
      const system = body.systemInstruction.parts[0]!.text;
      const prompt = body.contents[0]!.parts[0]!.text;
      const model = decodeURIComponent(/models\/([^:]+):/.exec(url)?.[1] ?? 'gemini');
      if (system.includes('EDUBENCH_JUDGE_JSON')) return geminiResponse(judgeJson(prompt), prompt, model);
      if (system.includes('검색 설계자')) return geminiResponse(directionJson(prompt), prompt, model);
      if (system.includes('교육 평가 문항 설계자')) return geminiResponse(generatedQuestionJson(prompt), prompt, model);
      throw new Error('DEMO_SEED: 처리할 수 없는 Gemini 요청입니다.');
    }

    throw new Error(`DEMO_SEED: 외부 요청이 차단되었습니다: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const MODEL_SKILL: Record<string, number> = {
  openai:0.78,
  gemini:0.72,
  upstage:0.55,
  exaone:0.5,
  claude:0.7,
  midm:0.45,
};

/** Benchmark target model stand-in with a fixed skill level per provider. */
export class DemoAnswerProvider implements ModelProvider {
  constructor(readonly key: string, readonly modelId: string) {}

  async generate(request: GenerationRequest): Promise<NormalizedGeneration> {
    const match = findQuestionByText(request.prompt);
    const hasEvidence = request.prompt.includes('교과서') && request.prompt.length > 900;
    const skill = (MODEL_SKILL[this.key] ?? 0.5) + (hasEvidence ? 0.12 : 0);
    const roll = hashUnit(`${this.key}:${request.prompt}`);
    let text: string;
    if (!match) {
      text = '질문에 필요한 정보를 찾지 못했습니다.';
    } else if (roll < skill) {
      text = match.question.answerText;
    } else if (roll < skill + 0.2) {
      text = match.question.partialAnswer;
    } else {
      text = match.question.mistakenAnswer;
    }
    const latencyMs = Math.round(900 + hashUnit(`${this.key}:latency:${request.prompt}`) * 5200);
    return {
      text,
      raw:{ demo:true, provider:this.key },
      inputTokens:Math.ceil((request.system.length + request.prompt.length) / 2),
      outputTokens:Math.ceil(text.length / 1.6),
      finishReason:'stop',
      requestId:`demo-${this.key}-${createHash('sha256').update(request.prompt).digest('hex').slice(0, 12)}`,
      modelId:this.modelId,
      modelSnapshot:this.modelId,
      latencyMs,
    };
  }
}
