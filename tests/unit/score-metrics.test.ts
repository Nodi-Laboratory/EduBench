import { describe, expect, test } from 'vitest';
import { describeScoreMetric, describeScoreMetrics } from '@/domain/score-metrics';

describe('score metric research definitions', () => {
  test('describes deterministic, judge, prerequisite, and unknown metrics', () => {
    expect(describeScoreMetric('response_present')).toMatchObject({
      label: '응답 존재', method: 'deterministic', range: '0 또는 1', direction: '높을수록 좋음',
    });
    expect(describeScoreMetric('faithfulness')).toMatchObject({
      label: '교과서 충실성', method: 'judge', range: '0~1', direction: '높을수록 좋음',
    });
    expect(describeScoreMetric('prerequisite_relation_accuracy')).toMatchObject({
      label: '선수 관계 방향 정확성', category: '선수관계 추론', method: 'judge',
    });
    expect(describeScoreMetric('prerequisite_relation_accuracy').rubric).toContain('방향');
    expect(describeScoreMetric('custom_metric')).toMatchObject({
      key: 'custom_metric', label: 'custom_metric', category: '사용자 정의', method: 'judge',
    });
  });

  test('deduplicates metrics while retaining requested order', () => {
    expect(describeScoreMetrics(['accuracy', 'exact_match', 'accuracy', 'response_present']).map((metric) => metric.key))
      .toEqual(['accuracy', 'response_present']);
  });
});
