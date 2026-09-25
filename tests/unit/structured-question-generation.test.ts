import { expect, test, vi } from 'vitest';
import type {
  GenerationRequest,
  NormalizedGeneration,
} from '@/server/providers/types';
import {
  generateQuestionWithStructuredRepair,
  type StructuredQuestionGenerationStage,
} from '@/server/questions/structured-generation';

const chunkId = '11111111-1111-4111-8111-111111111111';

function questionJson(toConcept: string) {
  return JSON.stringify({
    questionText: '속도 변화와 시간 간격을 이용해 가속도를 판단하시오.',
    answerText: '속도 변화량을 시간 간격으로 나누어 가속도를 판단한다.',
    acceptedAnswers: [],
    answerOptions: [],
    designSummary: '선수 개념을 목표 개념에 적용한다.',
    evidenceSummary: '속도 변화와 가속도의 관계를 사용한다.',
    evidenceChunkIds: [chunkId],
    benchmarkDesign: {
      benchmarkType: 'PREREQUISITE_RELATIONSHIP',
      taskType: 'dependency_application',
      targetConcept: '가속도',
      prerequisiteConcepts: [{
        concept: '속도 변화',
        role: '가속도를 판단하기 전에 필요한 변화량이다.',
        evidenceChunkIds: [chunkId],
      }],
      prerequisiteRelations: [{
        fromConcept: '속도 변화',
        toConcept,
        relationType: 'REQUIRES',
        explanation: '속도 변화를 알아야 가속도를 판단할 수 있다.',
        evidenceChunkIds: [chunkId],
      }],
      requiredReasoningSteps: [
        '속도 변화를 구한다.',
        '시간 간격과 연결해 가속도를 판단한다.',
      ],
      failureSignals: ['속도와 가속도를 같은 개념으로 취급한다.'],
    },
  });
}

function response(text: string): NormalizedGeneration {
  return {
    text,
    raw: { text },
    inputTokens: 10,
    outputTokens: 20,
    finishReason: 'STOP',
    requestId: 'request-id',
    modelId: 'gemini-test',
    modelSnapshot: 'gemini-test',
    latencyMs: 5,
  };
}

const request: GenerationRequest = {
  system: '원래 시스템 지시',
  prompt: '원래 문항 생성 지시와 교과서 근거',
  maxOutputTokens: 8_192,
  responseMimeType: 'application/json',
  responseJsonSchema: { type: 'object' },
  thinkingLevel: 'HIGH',
};

test('repairs one semantically invalid structured response without repeating retrieval', async () => {
  const calls: Array<{
    stage: StructuredQuestionGenerationStage;
    request: GenerationRequest;
  }> = [];
  const generate = vi.fn(async (
    stage: StructuredQuestionGenerationStage,
    generationRequest: GenerationRequest,
  ) => {
    calls.push({ stage, request: generationRequest });
    return stage === 'QUESTION'
      ? response(questionJson('힘'))
      : response(questionJson('가속도'));
  });
  const onRepairStarted = vi.fn();
  const onRepairCompleted = vi.fn();

  const result = await generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
    onRepairStarted,
    onRepairCompleted,
  });

  expect(result.benchmarkDesign.prerequisiteRelations[0]?.toConcept).toBe('가속도');
  expect(calls.map((call) => call.stage)).toEqual(['QUESTION', 'QUESTION_REPAIR']);
  expect(calls[1]?.request).toMatchObject({
    responseMimeType: 'application/json',
    responseJsonSchema: request.responseJsonSchema,
    temperature: 0,
  });
  expect(calls[1]?.request.prompt).toContain('최소 한 선수 관계가 목표 개념으로 연결');
  expect(calls[1]?.request.prompt).toContain('benchmarkDesign.targetConcept');
  expect(calls[1]?.request.prompt).toContain(questionJson('힘'));
  expect(onRepairStarted).toHaveBeenCalledOnce();
  expect(onRepairCompleted).toHaveBeenCalledOnce();
});

test('limits semantic structure repair to one additional provider call', async () => {
  const generate = vi.fn(async () => response(questionJson('힘')));
  const onRepairFailed = vi.fn();

  await expect(generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
    onRepairFailed,
  })).rejects.toThrow(/GENERATION_PARSE_FAILED.*교정 재요청 1회/);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(onRepairFailed).toHaveBeenCalledOnce();
});

test('requires an explicit STOP finish reason before parsing the initial response', async () => {
  const generate = vi.fn(async () => ({
    ...response(questionJson('가속도')),
    finishReason: null,
  }));

  await expect(generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
  })).rejects.toThrow(/GENERATION_INCOMPLETE_RESPONSE.*finishReason=UNKNOWN/);

  expect(generate).toHaveBeenCalledTimes(1);
});

test('requires an explicit STOP finish reason from the repair response', async () => {
  const generate = vi.fn()
    .mockResolvedValueOnce(response(questionJson('힘')))
    .mockResolvedValueOnce({
      ...response(questionJson('가속도')),
      finishReason: null,
    });
  const onRepairFailed = vi.fn();

  await expect(generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
    onRepairFailed,
  })).rejects.toThrow(/GENERATION_INCOMPLETE_RESPONSE.*교정 응답.*finishReason=UNKNOWN/);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(onRepairFailed).toHaveBeenCalledOnce();
});

test('does not relabel a completed-repair lifecycle callback error as a repair failure', async () => {
  const generate = vi.fn()
    .mockResolvedValueOnce(response(questionJson('힘')))
    .mockResolvedValueOnce(response(questionJson('가속도')));
  const onRepairFailed = vi.fn();

  await expect(generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
    onRepairCompleted: () => {
      throw new Error('REPAIR_COMPLETION_AUDIT_FAILED');
    },
    onRepairFailed,
  })).rejects.toThrow('REPAIR_COMPLETION_AUDIT_FAILED');

  expect(onRepairFailed).not.toHaveBeenCalled();
});

test('preserves the original repair error when failure lifecycle logging also fails', async () => {
  const generate = vi.fn(async () => response(questionJson('힘')));

  await expect(generateQuestionWithStructuredRepair({
    request,
    questionType: '구조화 서술형',
    generate,
    onRepairFailed: () => {
      throw new Error('REPAIR_FAILURE_AUDIT_FAILED');
    },
  })).rejects.toThrow(/GENERATION_PARSE_FAILED.*교정 재요청 1회/);

  expect(generate).toHaveBeenCalledTimes(2);
});
