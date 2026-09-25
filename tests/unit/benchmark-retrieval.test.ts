import { expect, test } from 'vitest';
import {
  benchmarkRetrievalModeMetadata,
  buildBenchmarkAnswerPrompt,
  buildPublicQuestionRetrievalQuery,
  hashBenchmarkRetrievalSnapshot,
  orderPikeRetrievalChunks,
  parseBenchmarkRetrievalModes,
} from '@/domain/benchmark-retrieval';

test('hashes retrieval snapshots in PostgreSQL jsonb key order', () => {
  const first = {
    schemaVersion:1,
    strategy:'simple-vector-top-k',
    settings:{ topK:12, enabled:true },
  };
  const reordered = {
    settings:{ enabled:true, topK:12 },
    strategy:'simple-vector-top-k',
    schemaVersion:1,
  };
  expect(hashBenchmarkRetrievalSnapshot(first)).toBe(
    hashBenchmarkRetrievalSnapshot(reordered),
  );
  expect(hashBenchmarkRetrievalSnapshot(first))
    .toMatch(/^[0-9a-f]{64}$/);
});

test('normalizes and deduplicates only the three public benchmark retrieval modes', () => {
  expect(parseBenchmarkRetrievalModes(['PIKE', 'NONE', 'PIKE', 'VECTOR']))
    .toEqual(['NONE', 'VECTOR', 'PIKE']);
  expect(() => parseBenchmarkRetrievalModes([])).toThrowError(
    /검색 조건을 하나 이상/,
  );
  expect(() => parseBenchmarkRetrievalModes(['LEGACY_EVIDENCE']))
    .toThrowError(/지원하지 않는 검색 조건/);
});

test('builds ordinary RAG queries from public question inputs without private answer artifacts', () => {
  expect(buildPublicQuestionRetrievalQuery({
    questionText:'  광합성에 필요한 조건을 설명하시오.  ',
    answerOptions:[' 빛 ', '산소'],
  })).toBe(
    '질문: 광합성에 필요한 조건을 설명하시오.\n선택지:\n1. 빛\n2. 산소',
  );
});

test('orders Pike context by graph-cited evidence and then keeps every remaining generation chunk once', () => {
  const chunks = [
    { chunkId:'00000000-0000-0000-0000-000000000001', content:'첫 청크', rank:1 },
    { chunkId:'00000000-0000-0000-0000-000000000002', content:'둘 청크', rank:2 },
    { chunkId:'00000000-0000-0000-0000-000000000003', content:'셋 청크', rank:3 },
  ];
  const ordered = orderPikeRetrievalChunks(chunks, {
    prerequisiteConcepts:[{
      evidenceChunkIds:[
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000003',
      ],
    }],
    prerequisiteRelations:[{
      evidenceChunkIds:['00000000-0000-0000-0000-000000000002'],
    }],
  });

  expect(ordered.map((chunk) => chunk.chunkId)).toEqual([
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
  ]);
});

test('keeps the no-RAG answer prompt free of textbook evidence while rendering retrieved modes explicitly', () => {
  expect(buildBenchmarkAnswerPrompt({
    retrievalMode:'NONE',
    questionText:'왜 계절이 생기는가?',
    answerOptions:[],
    evidence:[],
  })).toBe(
    '교과서 검색 근거는 제공되지 않습니다. 모델 자체 지식만 사용해 답하십시오.\n\n[질문]\n왜 계절이 생기는가?',
  );

  const retrieved = buildBenchmarkAnswerPrompt({
    retrievalMode:'VECTOR',
    questionText:'왜 계절이 생기는가?',
    answerOptions:['자전', '공전'],
    evidence:['[근거 1 · p.12]\n지구의 자전축은 기울어져 있다.'],
  });
  expect(retrieved).toContain('단순 벡터 검색으로 찾은 교과서 근거');
  expect(retrieved).toContain('[근거 1 · p.12]');
  expect(retrieved).toContain('1. 자전\n2. 공전');
});

test('describes Pike as a generation graph snapshot without claiming full graph-driven retrieval', () => {
  const metadata = benchmarkRetrievalModeMetadata.PIKE;
  expect(metadata.shortLabel).toBe('Pike');
  expect(metadata.title).toBe('Pike-inspired · 생성 그래프 스냅샷');
  expect(metadata.description).toContain(
    '완전한 Microsoft PIKE-RAG 구현이 아닙니다',
  );
  expect(metadata.description).toContain(
    '그래프가 새 검색을 수행하지 않습니다',
  );

  const prompt = buildBenchmarkAnswerPrompt({
    retrievalMode:'PIKE',
    questionText:'가속도를 이해하려면 어떤 선수 개념이 필요한가?',
    answerOptions:[],
    evidence:['[근거 1]\n속도는 위치의 시간에 따른 변화이다.'],
  });
  expect(prompt).toContain(
    'Pike-inspired 생성 그래프 스냅샷에서 재사용·재정렬한 교과서 근거',
  );
  expect(prompt).not.toContain('그래프로 선택한');
});
