import { DomainError } from '@/domain/errors';
import { buildQuestionResponseRepairInstructions } from '@/domain/question-prompt';
import type {
  GenerationRequest,
  NormalizedGeneration,
} from '@/server/providers/types';
import {
  GeneratedQuestionResponseError,
  parseGeneratedQuestionResponse,
  validateGeneratedQuestionForType,
  type GeneratedQuestion,
} from '@/server/questions/response';

export type StructuredQuestionGenerationStage = 'QUESTION' | 'QUESTION_REPAIR';

type RepairLifecycleEvent = {
  validationError: string;
};

type RepairFailureEvent = RepairLifecycleEvent & {
  error: string;
};

type GenerateQuestionWithStructuredRepairInput = {
  request: GenerationRequest;
  questionType: unknown;
  generate: (
    stage: StructuredQuestionGenerationStage,
    request: GenerationRequest,
  ) => Promise<NormalizedGeneration>;
  onRepairStarted?: (
    event: RepairLifecycleEvent,
  ) => void | Promise<void>;
  onRepairCompleted?: (
    event: RepairLifecycleEvent,
  ) => void | Promise<void>;
  onRepairFailed?: (
    event: RepairFailureEvent,
  ) => void | Promise<void>;
};

function assertCompleteResponse(
  response: NormalizedGeneration,
  repair: boolean,
) {
  if (response.finishReason !== 'STOP') {
    throw new DomainError(
      'GENERATION_INCOMPLETE_RESPONSE',
      `Gemini ${repair ? '교정 ' : ''}응답이 완료되지 않았습니다. finishReason=${response.finishReason ?? 'UNKNOWN'}`,
    );
  }
}

function parseAndValidateQuestion(
  response: NormalizedGeneration,
  questionType: unknown,
): GeneratedQuestion {
  const question = parseGeneratedQuestionResponse(response.text);
  validateGeneratedQuestionForType(question, questionType);
  return question;
}

function isRepairableOutputError(error: unknown) {
  return error instanceof GeneratedQuestionResponseError
    || (error instanceof Error
      && error.message.startsWith('GENERATION_FORMAT_MISMATCH:'));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validationDetail(error: unknown) {
  return errorMessage(error)
    .replace(/^GENERATION_PARSE_FAILED:\s*/, '')
    .replace(/^GENERATION_FORMAT_MISMATCH:\s*/, '');
}

export async function generateQuestionWithStructuredRepair(
  input: GenerateQuestionWithStructuredRepairInput,
): Promise<GeneratedQuestion> {
  const initialResponse = await input.generate('QUESTION', input.request);
  assertCompleteResponse(initialResponse, false);

  try {
    return parseAndValidateQuestion(initialResponse, input.questionType);
  } catch (initialError) {
    if (!isRepairableOutputError(initialError)) throw initialError;

    const validationError = errorMessage(initialError);
    await input.onRepairStarted?.({ validationError });
    const repairInstructions = buildQuestionResponseRepairInstructions({
      originalSystem: input.request.system,
      originalPrompt: input.request.prompt,
      invalidResponse: initialResponse.text,
      validationError,
    });
    const repairRequest: GenerationRequest = {
      ...input.request,
      system: repairInstructions.system,
      prompt: repairInstructions.prompt,
      temperature: 0,
    };

    let question: GeneratedQuestion;
    try {
      const repairResponse = await input.generate('QUESTION_REPAIR', repairRequest);
      assertCompleteResponse(repairResponse, true);
      question = parseAndValidateQuestion(
        repairResponse,
        input.questionType,
      );
    } catch (repairError) {
      try {
        await input.onRepairFailed?.({
          validationError,
          error: errorMessage(repairError),
        });
      } catch (lifecycleError) {
        console.error(
          'QUESTION_RESPONSE_REPAIR_FAILURE_EVENT_FAILED',
          lifecycleError,
        );
      }
      if (!isRepairableOutputError(repairError)) throw repairError;
      throw new DomainError(
        'GENERATION_PARSE_FAILED',
        `Gemini 구조화 응답이 교정 재요청 1회 후에도 검증을 통과하지 못했습니다. ${validationDetail(repairError)}`,
        {
          initialValidationError: validationError,
          repairValidationError: errorMessage(repairError),
        },
      );
    }
    await input.onRepairCompleted?.({ validationError });
    return question;
  }
}
