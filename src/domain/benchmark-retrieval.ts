export const benchmarkRetrievalModes = ['NONE', 'VECTOR', 'PIKE'] as const;
export const storedBenchmarkRetrievalModes = [
  'LEGACY_EVIDENCE',
  ...benchmarkRetrievalModes,
] as const;

export type BenchmarkRetrievalMode =
  (typeof benchmarkRetrievalModes)[number];
export type StoredBenchmarkRetrievalMode =
  (typeof storedBenchmarkRetrievalModes)[number];

export function hashBenchmarkRetrievalSnapshot(value: unknown): string {
  return createHash('sha256')
    .update(serializeAsPostgresJsonb(value))
    .digest('hex');
}

export const benchmarkRetrievalModeMetadata: Record<
  BenchmarkRetrievalMode,
  {
    shortLabel:string;
    title:string;
    description:string;
  }
> = {
  NONE: {
    shortLabel:'일반',
    title:'일반 · RAG 없음',
    description:'교과서 검색 결과를 제공하지 않고 모델 자체 지식만 평가합니다.',
  },
  VECTOR: {
    shortLabel:'RAG',
    title:'RAG · 단순 벡터 검색',
    description:'공개 질문과 선택지만 질의로 사용해 동일 교과서 리비전에서 코사인 유사도 상위 청크를 검색합니다.',
  },
  PIKE: {
    shortLabel:'Pike',
    title:'Pike-inspired · 생성 그래프 스냅샷',
    description:'완전한 Microsoft PIKE-RAG 구현이 아닙니다. 문항 생성 당시 검색 스냅샷을 재사용하고, 생성된 선수관계 청사진이 인용한 청크를 앞에 배치합니다. 그래프가 새 검색을 수행하지 않습니다.',
  },
};

const modeOrder = new Map(
  benchmarkRetrievalModes.map((mode, index) => [mode, index]),
);

export function parseBenchmarkRetrievalModes(
  input: readonly unknown[],
): BenchmarkRetrievalMode[] {
  if (!input.length) {
    throw new Error('벤치마크 검색 조건을 하나 이상 선택해야 합니다.');
  }
  const unique = new Set<BenchmarkRetrievalMode>();
  for (const value of input) {
    if (
      typeof value !== 'string'
      || !benchmarkRetrievalModes.includes(value as BenchmarkRetrievalMode)
    ) {
      throw new Error(`지원하지 않는 검색 조건입니다: ${String(value)}`);
    }
    unique.add(value as BenchmarkRetrievalMode);
  }
  return [...unique].sort(
    (left, right) => modeOrder.get(left)! - modeOrder.get(right)!,
  );
}

export function buildPublicQuestionRetrievalQuery(input: {
  questionText:string;
  answerOptions:unknown;
}): string {
  const question = input.questionText.trim();
  const options = Array.isArray(input.answerOptions)
    ? input.answerOptions
      .map((option) => String(option).trim())
      .filter(Boolean)
    : [];
  return [
    `질문: ${question}`,
    ...(options.length
      ? [`선택지:\n${options.map((option, index) => (
        `${index + 1}. ${option}`
      )).join('\n')}`]
      : []),
  ].join('\n');
}

export function buildBenchmarkAnswerPrompt(input: {
  retrievalMode:StoredBenchmarkRetrievalMode;
  questionText:string;
  answerOptions:unknown;
  evidence:string[];
}): string {
  const options = Array.isArray(input.answerOptions)
    && input.answerOptions.length
    ? `\n\n선택지:\n${input.answerOptions.map(
      (option, index) => `${index + 1}. ${String(option)}`,
    ).join('\n')}`
    : '';
  let contextInstruction: string;
  if (input.retrievalMode === 'NONE') {
    contextInstruction =
      '교과서 검색 근거는 제공되지 않습니다. 모델 자체 지식만 사용해 답하십시오.';
  } else {
    const title = input.retrievalMode === 'VECTOR'
      ? '단순 벡터 검색으로 찾은 교과서 근거'
      : input.retrievalMode === 'PIKE'
        ? 'Pike-inspired 생성 그래프 스냅샷에서 재사용·재정렬한 교과서 근거'
        : '문항에 연결된 기존 교과서 근거';
    contextInstruction = input.evidence.length
      ? `${title}만 사용하십시오.\n\n${input.evidence.join('\n\n')}`
      : `${title}를 찾지 못했습니다. 근거 부족을 명시하십시오.`;
  }
  return `${contextInstruction}\n\n[질문]\n${input.questionText}${options}`;
}

export type BenchmarkRetrievedChunk = {
  chunkId:string;
  content:string;
  rank?:number;
  page?:number | null;
  unit?:string | null;
  source?:string;
  similarity?:number | null;
  semanticRank?:number | null;
  anchorChunkId?:string | null;
  sourceFileId?:string;
  sourceRevisionId?:string;
  ordinal?:number;
  [key:string]:unknown;
};

type BenchmarkDesignEvidence = {
  prerequisiteConcepts?:Array<{ evidenceChunkIds?:unknown }>;
  prerequisiteRelations?:Array<{ evidenceChunkIds?:unknown }>;
};

function graphEvidenceChunkIds(design: BenchmarkDesignEvidence): string[] {
  const ids = [
    ...(design.prerequisiteConcepts ?? []).flatMap((concept) => (
      Array.isArray(concept.evidenceChunkIds)
        ? concept.evidenceChunkIds.filter(
          (id): id is string => typeof id === 'string',
        )
        : []
    )),
    ...(design.prerequisiteRelations ?? []).flatMap((relation) => (
      Array.isArray(relation.evidenceChunkIds)
        ? relation.evidenceChunkIds.filter(
          (id): id is string => typeof id === 'string',
        )
        : []
    )),
  ];
  return [...new Set(ids)];
}

export function orderPikeRetrievalChunks<
  T extends BenchmarkRetrievedChunk,
>(
  chunks: readonly T[],
  benchmarkDesign: BenchmarkDesignEvidence,
): T[] {
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  const add = (chunkId: string) => {
    const chunk = byId.get(chunkId);
    if (!chunk || seen.has(chunkId)) return;
    seen.add(chunkId);
    ordered.push(chunk);
  };
  graphEvidenceChunkIds(benchmarkDesign).forEach(add);
  chunks.forEach((chunk) => add(chunk.chunkId));
  return ordered;
}
import { createHash } from 'node:crypto';
import { serializeAsPostgresJsonb } from '@/domain/research-config';
