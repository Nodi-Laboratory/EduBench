import { expect, test } from 'vitest';
import {
  generatedQuestionResponseJsonSchema,
  parseGeneratedQuestionResponse,
  validateGeneratedQuestionForType,
} from '@/server/questions/response';

const chunkId = '11111111-1111-4111-8111-111111111111';

const benchmarkDesign = {
  benchmarkType: 'PREREQUISITE_RELATIONSHIP' as const,
  taskType: 'dependency_application' as const,
  targetConcept: '가속도',
  prerequisiteConcepts: [{ concept: '속도 변화', role: '가속도를 정의하는 데 필요한 변화량', evidenceChunkIds: [chunkId] }],
  prerequisiteRelations: [{ fromConcept: '속도 변화', toConcept: '가속도', relationType: 'REQUIRES' as const, explanation: '속도의 시간에 따른 변화로 가속도를 이해한다.', evidenceChunkIds: [chunkId] }],
  requiredReasoningSteps: ['속도 변화를 판별한다.', '시간 간격과 연결해 가속도를 판단한다.'],
  failureSignals: ['가속도를 속도와 동일시한다.'],
};

test('parses one structured question JSON object', () => {
  expect(parseGeneratedQuestionResponse(JSON.stringify({
    questionText: '원자와 분자의 차이를 설명하시오.',
    answerText: '원자는 원소의 성질을 가지는 기본 입자이고 분자는 원자들이 결합한 입자이다.',
    acceptedAnswers: ['원자는 기본 입자이며 분자는 원자의 결합이다.'],
    answerOptions: ['① 원자만 물질이다.', '② 분자는 원자의 결합이다.'],
    designSummary: '핵심 개념 비교',
    evidenceSummary: '교과서 정의에 근거',
    evidenceChunkIds: [chunkId],
    benchmarkDesign,
  }))).toMatchObject({ evidenceChunkIds: [chunkId], answerOptions: ['① 원자만 물질이다.', '② 분자는 원자의 결합이다.'] });
});

test('reports malformed structured question JSON clearly', () => {
  expect(() => parseGeneratedQuestionResponse('{"questionText":"깨진 응답"'))
    .toThrow('GENERATION_PARSE_FAILED');
});

test('requires exactly five options for multiple choice questions', () => {
  const question = parseGeneratedQuestionResponse(JSON.stringify({
    questionText: '옳은 설명을 고르시오.', answerText: '⑤', acceptedAnswers: ['⑤'],
    answerOptions: ['① A', '② B', '③ C', '④ D'], designSummary: '', evidenceSummary: '', evidenceChunkIds: [chunkId], benchmarkDesign,
  }));
  expect(() => validateGeneratedQuestionForType(question, '객관식')).toThrow('GENERATION_FORMAT_MISMATCH');
});

test('rejects a benchmark design whose prerequisite relation does not reach the target concept', () => {
  expect(() => parseGeneratedQuestionResponse(JSON.stringify({
    questionText: '가속도를 판단하시오.', answerText: '속도 변화량을 시간으로 나눈다.', acceptedAnswers: [], answerOptions: [],
    designSummary: '', evidenceSummary: '', evidenceChunkIds: [chunkId],
    benchmarkDesign: { ...benchmarkDesign, prerequisiteRelations: [{ ...benchmarkDesign.prerequisiteRelations[0], toConcept: '힘' }] },
  }))).toThrow('GENERATION_PARSE_FAILED');
});

test('describes the target-link equality rule inside the provider JSON schema', () => {
  const benchmarkDesignProperty = (
    generatedQuestionResponseJsonSchema.properties.benchmarkDesign.properties
  );
  expect(benchmarkDesignProperty.targetConcept.description)
    .toContain('정확히 동일');
  expect(benchmarkDesignProperty.prerequisiteRelations.description)
    .toContain('toConcept');
});
