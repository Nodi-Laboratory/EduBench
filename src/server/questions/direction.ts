import { z } from 'zod';
import { benchmarkTaskForOrdinal, prerequisiteTaskLabels } from '@/domain/prerequisite-benchmark';
import type { QuestionPromptConditions } from '@/domain/question-prompt';

export const QUESTION_GENERATION_MAX_OUTPUT_TOKENS = 16_384;

const questionDirectionSchema = z.object({
  directionSummary: z.string().min(5),
  targetConceptQuery: z.string().min(2),
  prerequisiteQuery: z.string().min(2),
  searchQuery: z.string().min(5),
});

export type QuestionDirection = z.infer<typeof questionDirectionSchema>;

export const questionDirectionJsonSchema = {
  type: 'object',
  properties: {
    directionSummary: { type: 'string', description: '이번 문항만의 측정 방향과 다른 문항과의 차별점' },
    targetConceptQuery: { type: 'string', description: '목표 개념 후보를 찾는 한국어 검색어' },
    prerequisiteQuery: { type: 'string', description: '목표 개념의 선수 개념과 학습 순서를 찾는 한국어 검색어' },
    searchQuery: { type: 'string', description: '벡터 검색에 직접 사용할 목표·선수 개념 통합 검색 문장' },
  },
  required: ['directionSummary', 'targetConceptQuery', 'prerequisiteQuery', 'searchQuery'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function text(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function buildQuestionDirectionInstructions(input: {
  conditions: QuestionPromptConditions;
  ordinal: number;
  total: number;
}) {
  const units = Array.isArray(input.conditions.units) ? input.conditions.units.map(String).filter(Boolean) : [];
  const taskType = benchmarkTaskForOrdinal(input.ordinal);
  return {
    system: `당신은 교과서 기반 선수관계 벤치마크의 검색 설계자다.
아직 문항을 만들지 말고, 문항 하나에 사용할 검색 방향만 JSON으로 설계한다.
교과서에 실제로 존재한다고 확인되지 않은 구체적 사실이나 정답을 만들지 않는다.`,
    prompt: `총 ${input.total}개 중 ${input.ordinal}번째 문항에 대해 관련 자료를 검색하기 전에 독립적인 질문 방향성을 설계하라.

[사용자 조건]
- 과목: ${text(input.conditions.subject, '미지정')}
- 학년: ${text(input.conditions.grade, '미지정')}
- 단원: ${units.length ? units.join(' / ') : '선택 교과서 전체'}
- 질문 목적: ${text(input.conditions.purpose, '핵심 개념 이해')}
- 난이도: ${text(input.conditions.difficulty, '중')}
- 추가 방향: ${text(input.conditions.direction, '없음')}
- 선수관계 과제: ${prerequisiteTaskLabels[taskType]} (${taskType})

[방향성 설계 규칙]
- 이번 문항 하나만을 위한 방향을 만든다. 다른 문항과 같은 소재·개념 조합·추론 출발점을 반복하지 않는다.
- directionSummary에는 측정할 사고 활동과 선수관계 유형을 기술하되, 아직 근거가 없으므로 구체적인 정답을 단정하지 않는다.
- targetConceptQuery에는 선택 범위에서 목표 개념 후보를 찾을 검색어를 작성한다.
- prerequisiteQuery에는 그 목표를 이해하기 전에 필요한 정의·원리·절차·이전 학습 내용을 찾을 검색어를 작성한다.
- searchQuery에는 targetConceptQuery와 prerequisiteQuery를 결합한 자연스러운 한국어 벡터 검색 문장을 작성한다.
- 문항, 정답, 선택지는 생성하지 않는다.
- 출력은 directionSummary, targetConceptQuery, prerequisiteQuery, searchQuery만 가진 JSON 객체 하나다.`,
  };
}

export function parseQuestionDirectionResponse(value: string): QuestionDirection {
  try {
    return questionDirectionSchema.parse(JSON.parse(value.trim()));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'JSON 파싱 오류';
    throw new Error(`DIRECTION_PARSE_FAILED: 질문 방향성 응답이 올바르지 않습니다. ${detail}`);
  }
}
