import { expect, test } from 'vitest';
import { buildResultAnalytics } from '@/server/results/analytics';

test('builds composite, metric, purpose, prerequisite, heatmap, and distribution analytics', () => {
  const analytics = buildResultAnalytics({
    models: [
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:2, avgLatencyMs:1000, costKrw:20 },
      { blindId:'M02', displayName:'EXAONE', modelId:'exaone-test', responses:2, avgLatencyMs:1800, costKrw:null },
    ],
    scores: [
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'accuracy', value:0.8 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'response_present', value:1 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'prerequisite_relation_accuracy', value:0.6 },
      { blindId:'M01', questionId:'q2', questionPublicId:'Q-2', questionText:'둘째 질문', purpose:'개념 적용', metricKey:'accuracy', value:0.4 },
      { blindId:'M02', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'accuracy', value:1 },
      { blindId:'M02', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'prerequisite_relation_accuracy', value:0.5 },
      { blindId:'M02', questionId:'q2', questionPublicId:'Q-2', questionText:'둘째 질문', purpose:'개념 적용', metricKey:'accuracy', value:Number.NaN },
    ],
  });

  expect(analytics.models.find((model) => model.blindId === 'M01')).toMatchObject({ compositeScore:0.6, responses:2 });
  expect(analytics.metricRows.find((row) => row.metricKey === 'accuracy')?.scores).toEqual({ M01:0.6, M02:1 });
  expect(analytics.purposeRows.find((row) => row.purpose === '선수 관계')?.scores).toEqual({ M01:0.8, M02:1 });
  expect(analytics.prerequisiteRows).toHaveLength(1);
  expect(analytics.questionRows.find((row) => row.questionId === 'q1')?.scores).toEqual({ M01:0.8, M02:1 });
  expect(analytics.distributions.find((row) => row.blindId === 'M01')?.bins).toEqual([0, 0, 1, 0, 1]);
});

test('returns empty collections instead of invented zero values', () => {
  expect(buildResultAnalytics({ models:[], scores:[] })).toMatchObject({
    models:[], metricRows:[], purposeRows:[], prerequisiteRows:[], questionRows:[], distributions:[],
  });
});

test('computes a weighted mean of metric means and ignores null observations', () => {
  const analytics = buildResultAnalytics({
    models: [
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:2, avgLatencyMs:null, costKrw:null },
    ],
    metricWeights: {
      accuracy: 3,
      faithfulness: 1,
      response_present: 0,
      excluded_metric: 0,
    },
    scores: [
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'accuracy', value:1 },
      { blindId:'M01', questionId:'q2', questionPublicId:'Q-2', questionText:'둘째 질문', purpose:'선수 관계', metricKey:'accuracy', value:null },
      { blindId:'M01', questionId:'q3', questionPublicId:'Q-3', questionText:'셋째 질문', purpose:'선수 관계', metricKey:'accuracy', value:1 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'faithfulness', value:0 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'response_present', value:1 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'첫 질문', purpose:'선수 관계', metricKey:'excluded_metric', value:1 },
    ],
  });

  expect(analytics.models[0]).toMatchObject({ compositeScore:0.75, scoreCount:3 });
  expect(analytics.metricRows.find((row) => row.metricKey === 'accuracy')).toMatchObject({
    scores:{ M01:1 }, counts:{ M01:2 },
  });
});

test('uses default weights and returns null when no positive-weight metric is observed', () => {
  const base = {
    models: [
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:null, costKrw:null },
    ],
  };
  const onlyPresence = buildResultAnalytics({
    ...base,
    scores: [
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'response_present', value:1 },
    ],
  });
  expect(onlyPresence.models[0]).toMatchObject({ compositeScore:null, scoreCount:0 });

  const missingWeightDefaultsToOne = buildResultAnalytics({
    ...base,
    metricWeights:{ accuracy:0 },
    scores: [
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'accuracy', value:1 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'faithfulness', value:0.4 },
    ],
  });
  expect(missingWeightDefaultsToOne.models[0]).toMatchObject({ compositeScore:0.4, scoreCount:1 });
});

test('preserves an observed null score as N/A instead of converting it to zero', () => {
  const analytics = buildResultAnalytics({
    models:[
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:null, costKrw:null },
    ],
    scores:[
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'accuracy', value:null },
    ],
  });
  expect(analytics.models[0]).toMatchObject({ compositeScore:null, scoreCount:0 });
  expect(analytics.metricRows[0]).toMatchObject({
    metricKey:'accuracy',
    scores:{},
    counts:{},
  });
  expect(analytics.questionRows[0]).toMatchObject({ scores:{} });
});
