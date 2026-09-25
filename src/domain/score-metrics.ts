import { prerequisiteMetricRubrics, prerequisiteScoringCriteria } from '@/domain/prerequisite-benchmark';

export type ScoreMetricMethod = 'deterministic' | 'judge';

export type ScoreMetricDefinition = {
  key: string;
  label: string;
  category: string;
  method: ScoreMetricMethod;
  range: string;
  direction: string;
  definition: string;
  evaluates: string;
  interpretation: string;
  rubric: string;
};

const baseMetrics: Record<string, Omit<ScoreMetricDefinition, 'key'>> = {
  response_present: {
    label: '응답 존재', category: '결정론적 검사', method: 'deterministic', range: '0 또는 1', direction: '높을수록 좋음',
    definition: '모델이 비어 있지 않은 응답을 반환했는지 검사합니다.', evaluates: '응답 생성 자체의 성공 여부',
    interpretation: '1은 공백이 아닌 응답이 존재, 0은 응답이 없음을 뜻합니다.', rubric: '코드로 계산하며 내용의 정확성은 평가하지 않습니다.',
  },
  accuracy: {
    label: '정확성', category: '내용 품질', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '최종 답과 핵심 개념·계산·판단이 모범 답안 및 채점 기준에 비추어 정확한 정도입니다.',
    evaluates: '결론과 이를 뒷받침하는 핵심 사실 및 논리의 정확성',
    interpretation: '1은 핵심 오류가 없는 답, 0은 결론이나 핵심 논리가 틀린 답입니다.', rubric: '문항별 원자 채점 기준과 모범 답안을 우선하여 절대평가합니다.',
  },
  faithfulness: {
    label: '교과서 충실성', category: '근거 품질', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '응답의 핵심 주장이 제공된 교과서 근거에서 직접 뒷받침되는 정도입니다.',
    evaluates: '근거와 주장 사이의 일치, 근거에 없는 사실의 개입 여부',
    interpretation: '1은 핵심 주장 전체가 근거에 의해 지지되고, 0은 근거와 충돌하거나 근거 밖 주장이 답을 좌우합니다.',
    rubric: '표현이 달라도 의미가 근거와 일치하면 인정하되, 외부 지식이 정답 논리에 필수이면 감점합니다.',
  },
  completeness: {
    label: '완결성', category: '응답 품질', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '문항이 요구한 하위 과업과 필수 설명을 빠짐없이 수행한 정도입니다.', evaluates: '요구사항 누락과 추론 단계의 완결성',
    interpretation: '1은 모든 요구를 충족, 0은 핵심 요구를 수행하지 않은 경우입니다.', rubric: '질문의 발문과 원자 채점 기준을 항목별로 대조합니다.',
  },
  curriculum_alignment: {
    label: '교육과정 정합성', category: '교육 적합성', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '응답이 지정된 교과·학년·단원 범위와 교과서의 개념 수준에 맞는 정도입니다.', evaluates: '교육과정 범위, 용어와 개념 수준',
    interpretation: '1은 지정 범위에 정확히 부합, 0은 범위를 벗어나거나 다른 수준의 개념으로 답한 경우입니다.', rubric: '고급 지식 자체가 아니라 지정 학습 범위 안에서의 적절성을 평가합니다.',
  },
  student_fit: {
    label: '학생 수준 적합성', category: '교육 적합성', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '설명의 언어, 단계, 예시가 대상 학년 학생이 이해할 수 있는 수준인지 평가합니다.', evaluates: '설명 난도와 교육적 명료성',
    interpretation: '1은 대상 학년이 따라갈 수 있는 정확한 설명, 0은 지나치게 생략되거나 불필요하게 전문적인 설명입니다.', rubric: '정확성을 훼손하지 않는 범위에서 대상 학년의 이해 가능성을 판단합니다.',
  },
  misconception: {
    label: '오개념 대응', category: '교육 적합성', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '문항에 포함된 오개념이나 잘못된 추론을 정확히 식별하고 교정한 정도입니다.', evaluates: '오류 지점의 진단, 원인 설명, 올바른 개념으로의 교정',
    interpretation: '1은 오류 원인과 교정이 모두 명확, 0은 오개념을 강화하거나 놓친 경우입니다.', rubric: '단순히 정답만 제시하지 않고 잘못된 추론이 왜 성립하지 않는지 확인합니다.',
  },
  hallucination: {
    label: '환각 억제', category: '근거 품질', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    definition: '제공된 자료나 일반적으로 허용된 문항 정보에 없는 내용을 사실처럼 만들어내지 않은 정도입니다.', evaluates: '근거 없는 사실·인용·수치·개념의 생성 여부',
    interpretation: '1은 확인 불가능한 주장이 없고, 0은 핵심 답을 왜곡하는 조작된 내용이 있습니다.', rubric: '근거 부족을 명시한 응답은 근거 없는 단정보다 높게 평가합니다.',
  },
};

const prerequisiteMetrics = Object.fromEntries(prerequisiteScoringCriteria.map((criterion) => [criterion.key, {
  label: criterion.label,
  category: '선수관계 추론',
  method: 'judge' as const,
  range: `0~${criterion.maxScore}`,
  direction: '높을수록 좋음',
  definition: criterion.description,
  evaluates: '문항에 저장된 benchmarkDesign과 모델 응답 사이의 일치',
  interpretation: `최대 ${criterion.maxScore}점은 설계된 선수관계 요구를 모두 충족했음을 뜻합니다.`,
  rubric: prerequisiteMetricRubrics[criterion.key],
}])) satisfies Record<string, Omit<ScoreMetricDefinition, 'key'>>;

const metricDefinitions = { ...baseMetrics, ...prerequisiteMetrics };

export function describeScoreMetric(metricKey: string): ScoreMetricDefinition {
  const definition = metricDefinitions[metricKey];
  if (definition) return { key: metricKey, ...definition };
  return {
    key: metricKey, label: metricKey, category: '사용자 정의', method: 'judge', range: '프로필 정의 참조', direction: '프로필 정의 참조',
    definition: '프로필에 추가된 사용자 정의 지표입니다.', evaluates: '저장된 채점 프로필의 전체 루브릭 프롬프트에 정의된 대상',
    interpretation: '점수 범위와 의미는 해당 프로필의 루브릭 프롬프트를 기준으로 해석해야 합니다.',
    rubric: '이 지표의 최종 판정 기준은 아래에 공개된 프로필 루브릭 프롬프트입니다.',
  };
}

export function describeScoreMetrics(metricKeys: string[]): ScoreMetricDefinition[] {
  return [...new Set(metricKeys)]
    .filter((metricKey) => metricKey !== 'exact_match')
    .map(describeScoreMetric);
}
