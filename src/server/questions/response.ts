import { z } from 'zod';

export type GeneratedQuestionValidationIssue = {
  code: string;
  message: string;
  path: Array<string | number>;
};

export class GeneratedQuestionResponseError extends Error {
  readonly code = 'GENERATION_PARSE_FAILED';
  readonly validationIssues: GeneratedQuestionValidationIssue[];

  constructor(error: unknown) {
    const validationIssues = error instanceof z.ZodError
      ? error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map((part) => typeof part === 'symbol' ? String(part) : part),
      }))
      : [{
        code: 'invalid_json',
        message: error instanceof Error ? error.message : 'JSON 파싱 오류',
        path: [],
      }];
    super(
      `GENERATION_PARSE_FAILED: Gemini 구조화 응답이 올바르지 않습니다. ${JSON.stringify(validationIssues)}`,
      { cause: error },
    );
    this.name = 'GeneratedQuestionResponseError';
    this.validationIssues = validationIssues;
  }
}

const prerequisiteRelationSchema = z.object({
  fromConcept: z.string().min(1),
  toConcept: z.string().min(1),
  relationType: z.enum(['REQUIRES', 'BUILDS_ON', 'APPLIES', 'DISTINGUISHES']),
  explanation: z.string().min(5),
  evidenceChunkIds: z.array(z.string().uuid()).min(1),
});

const benchmarkDesignSchema = z.object({
  benchmarkType: z.literal('PREREQUISITE_RELATIONSHIP'),
  taskType: z.enum(['dependency_application', 'missing_prerequisite_diagnosis', 'cross_unit_transfer', 'relation_direction_discrimination', 'prerequisite_chain_completion']),
  targetConcept: z.string().min(1),
  prerequisiteConcepts: z.array(z.object({
    concept: z.string().min(1), role: z.string().min(5), evidenceChunkIds: z.array(z.string().uuid()).min(1),
  })).min(1),
  prerequisiteRelations: z.array(prerequisiteRelationSchema).min(1),
  requiredReasoningSteps: z.array(z.string().min(3)).min(2),
  failureSignals: z.array(z.string().min(3)).min(1),
}).superRefine((design, context) => {
  if (!design.prerequisiteRelations.some((relation) => relation.toConcept === design.targetConcept)) {
    context.addIssue({ code: 'custom', message: '최소 한 선수 관계가 목표 개념으로 연결되어야 합니다.', path: ['prerequisiteRelations'] });
  }
});

export const generatedQuestionSchema = z.object({
  questionText: z.string().min(5),
  answerText: z.string().min(1),
  acceptedAnswers: z.array(z.string()).default([]),
  answerOptions: z.array(z.string()).default([]),
  designSummary: z.string().default(''),
  evidenceSummary: z.string().default(''),
  evidenceChunkIds: z.array(z.string().uuid()).min(1),
  benchmarkDesign: benchmarkDesignSchema,
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export const generatedQuestionResponseJsonSchema = {
  type: 'object',
  description: '교과서 근거로 만든 단일 교육 평가 문항. 반드시 이 객체 하나만 반환한다.',
  properties: {
    questionText: { type: 'string', description: '학생에게 제시할 완결된 질문 한 개' },
    answerText: { type: 'string', description: '교과서 근거에만 기반한 완결된 모범 답안' },
    acceptedAnswers: { type: 'array', description: '정답으로 인정할 짧은 대체 표현', items: { type: 'string' } },
    answerOptions: { type: 'array', description: '객관식이면 정확히 5개 선택지, 그 외 형식이면 빈 배열', items: { type: 'string' } },
    designSummary: { type: 'string', description: '문항의 교육적 설계 의도' },
    evidenceSummary: { type: 'string', description: '인용한 교과서 근거의 짧은 요약' },
    evidenceChunkIds: { type: 'array', description: '제공된 청크 중 실제 사용한 chunkId만 포함', items: { type: 'string' }, minItems: 1 },
    benchmarkDesign: {
      type: 'object', description: '문항이 측정하는 선수 관계 청사진',
      properties: {
        benchmarkType: { type: 'string', enum: ['PREREQUISITE_RELATIONSHIP'] },
        taskType: { type: 'string', enum: ['dependency_application', 'missing_prerequisite_diagnosis', 'cross_unit_transfer', 'relation_direction_discrimination', 'prerequisite_chain_completion'] },
        targetConcept: {
          type: 'string',
          description: '선수 관계가 최종적으로 도달하는 하나의 간결한 교과서 개념 또는 원리명. 분석·계산 같은 수행 과제 문장이나 여러 목표의 결합이 아니어야 하며, 적어도 한 prerequisiteRelations 항목의 toConcept와 글자 단위로 정확히 동일해야 한다.',
        },
        prerequisiteConcepts: { type: 'array', minItems: 1, items: { type: 'object', properties: { concept: { type: 'string' }, role: { type: 'string' }, evidenceChunkIds: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['concept', 'role', 'evidenceChunkIds'], additionalProperties: false } },
        prerequisiteRelations: {
          type: 'array',
          description: '방향성 있는 선수 관계 목록. 적어도 한 항목은 toConcept에 benchmarkDesign.targetConcept 문자열을 그대로 복사해 목표 개념으로 연결해야 한다.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              fromConcept: { type: 'string', description: '선행하는 선수 개념' },
              toConcept: { type: 'string', description: '관계가 도달하는 개념. 최종 관계에서는 targetConcept와 글자 단위로 정확히 동일해야 한다.' },
              relationType: { type: 'string', enum: ['REQUIRES', 'BUILDS_ON', 'APPLIES', 'DISTINGUISHES'] },
              explanation: { type: 'string' },
              evidenceChunkIds: { type: 'array', minItems: 1, items: { type: 'string' } },
            },
            required: ['fromConcept', 'toConcept', 'relationType', 'explanation', 'evidenceChunkIds'],
            additionalProperties: false,
          },
        },
        requiredReasoningSteps: { type: 'array', minItems: 2, items: { type: 'string' } },
        failureSignals: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      required: ['benchmarkType', 'taskType', 'targetConcept', 'prerequisiteConcepts', 'prerequisiteRelations', 'requiredReasoningSteps', 'failureSignals'], additionalProperties: false,
    },
  },
  required: ['questionText', 'answerText', 'acceptedAnswers', 'answerOptions', 'designSummary', 'evidenceSummary', 'evidenceChunkIds', 'benchmarkDesign'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function parseGeneratedQuestionResponse(text: string): GeneratedQuestion {
  try {
    return generatedQuestionSchema.parse(JSON.parse(text.trim()));
  } catch (error) {
    throw new GeneratedQuestionResponseError(error);
  }
}

export function validateGeneratedQuestionForType(question: GeneratedQuestion, questionType: unknown) {
  if (questionType === '객관식' && question.answerOptions.length !== 5) {
    throw new Error(`GENERATION_FORMAT_MISMATCH: 객관식은 5개 선택지가 필요하지만 ${question.answerOptions.length}개가 생성되었습니다.`);
  }
  if (questionType !== '객관식' && question.answerOptions.length > 0) {
    throw new Error('GENERATION_FORMAT_MISMATCH: 객관식이 아닌 문항에는 선택지를 생성할 수 없습니다.');
  }
}
