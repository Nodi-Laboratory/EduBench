export const prerequisiteTaskTypes = [
  'dependency_application',
  'missing_prerequisite_diagnosis',
  'cross_unit_transfer',
  'relation_direction_discrimination',
  'prerequisite_chain_completion',
] as const;

export type PrerequisiteTaskType = typeof prerequisiteTaskTypes[number];

export const prerequisiteTaskLabels: Record<PrerequisiteTaskType, string> = {
  dependency_application: '선수 개념 적용',
  missing_prerequisite_diagnosis: '누락된 선수 개념 진단',
  cross_unit_transfer: '단원 간 선수관계 전이',
  relation_direction_discrimination: '선수 관계 방향 판별',
  prerequisite_chain_completion: '선수 개념 사슬 완성',
};

export function benchmarkTaskForOrdinal(ordinal: number): PrerequisiteTaskType {
  return prerequisiteTaskTypes[(Math.max(1, ordinal) - 1) % prerequisiteTaskTypes.length]!;
}

export const prerequisiteScoreMetrics = [
  'target_concept_correctness',
  'prerequisite_identification',
  'prerequisite_relation_accuracy',
  'prerequisite_application',
  'reasoning_chain_completeness',
  'textbook_grounding',
] as const;

export const prerequisiteScoringCriteria = [
  { key: 'target_concept_correctness', label: '목표 개념 정확성', maxScore: 1, description: '최종 판단과 목표 개념의 설명이 정확하다.' },
  { key: 'prerequisite_identification', label: '선수 개념 식별', maxScore: 1, description: '해결에 필요한 선수 개념을 빠짐없이 식별한다.' },
  { key: 'prerequisite_relation_accuracy', label: '선수 관계 방향 정확성', maxScore: 1, description: '어떤 개념이 먼저 필요하고 왜 필요한지 방향을 정확히 설명한다.' },
  { key: 'prerequisite_application', label: '선수 개념 적용', maxScore: 1, description: '선수 개념을 이름만 언급하지 않고 목표 개념의 판단에 실제로 사용한다.' },
  { key: 'reasoning_chain_completeness', label: '추론 사슬 완결성', maxScore: 1, description: '선수 개념에서 목표 개념과 결론까지 이어지는 필수 단계를 생략하지 않는다.' },
  { key: 'textbook_grounding', label: '교과서 근거 충실성', maxScore: 1, description: '주장과 관계가 제공된 교과서 근거의 범위를 벗어나지 않는다.' },
] as const;

export const prerequisiteMetricRubrics: Record<(typeof prerequisiteScoreMetrics)[number], string> = {
  target_concept_correctness: '최종 결론과 목표 개념 설명의 정확성을 평가한다. 1은 모두 정확, 0.5는 결론은 맞지만 핵심 조건 일부 누락, 0은 결론 또는 개념이 틀린 경우다.',
  prerequisite_identification: 'benchmarkDesign.prerequisiteConcepts와 비교한다. 1은 필요한 선수 개념을 모두 명시하거나 의미상 분명히 사용, 0.5는 일부만 사용, 0은 식별하지 못한 경우다.',
  prerequisite_relation_accuracy: '선수→목표 관계의 방향과 이유를 평가한다. 방향 반전이나 단순 연관성 진술은 0, 방향은 맞지만 이유가 불완전하면 0.5다.',
  prerequisite_application: '선수 개념이 목표 판단의 입력이나 근거로 실제 작동하는지 평가한다. 용어 나열만 하면 0, 부분 적용은 0.5, 모든 관계를 올바르게 적용하면 1이다.',
  reasoning_chain_completeness: 'benchmarkDesign.requiredReasoningSteps와 비교한다. 모든 필수 단계를 논리적으로 연결하면 1, 핵심 중간 단계 하나 누락은 0.5, 결론만 제시하면 0이다.',
  textbook_grounding: '제공된 textbookEvidence로 후보 응답의 핵심 주장과 관계를 뒷받침할 수 있는지 평가한다. 외부 사실이 정답 논리에 필수면 감점한다.',
};
