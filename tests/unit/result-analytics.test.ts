import { expect, test } from 'vitest';
import {
  buildResultAnalytics,
  buildResultQuestionHeatmapPage,
  getResultAnalytics,
} from '@/server/results/analytics';

test('builds composite, metric, purpose, prerequisite, and distribution analytics', () => {
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
  expect(analytics.distributions.find((row) => row.blindId === 'M01')?.bins).toEqual([0, 0, 1, 0, 1]);
});

test('keeps a large result snapshot aggregate-only without question text or score cells', () => {
  const scores = Array.from({ length:250 }, (_, index) => ({
    blindId:'M01',
    questionId:`q${index + 1}`,
    questionPublicId:`Q-${index + 1}`,
    questionText:`질문 원문 ${index + 1}`,
    purpose:index % 2 ? '개념 적용' : '선수 관계',
    metricKey:'accuracy',
    value:index % 5 / 4,
  }));

  const analytics = buildResultAnalytics({
    models:[{
      blindId:'M01', displayName:'Gemini', modelId:'gemini-test',
      responses:250, avgLatencyMs:1000, costKrw:20,
    }],
    scores,
  });
  const serialized = JSON.stringify(analytics);

  expect(analytics).not.toHaveProperty('questionRows');
  expect(serialized).not.toContain('질문 원문 1');
  expect(serialized.length).toBeLessThan(10_000);
});

test('does not select question text while reading the aggregate snapshot', async () => {
  const queries: string[] = [];
  const queryable = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim().toLowerCase());
      return { rows:[] };
    },
  } as unknown as NonNullable<Parameters<typeof getResultAnalytics>[1]>;

  await getResultAnalytics('run-1', queryable);

  expect(queries).toHaveLength(3);
  expect(queries.some((sql) => (
    sql.includes('question_text') || sql.includes('question_revisions')
  ))).toBe(false);
});

test('maps bounded SQL aggregate rows without loading individual scores', async () => {
  const resultSets = [
    [
      {
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'NONE', responses:'2', avg_latency_ms:'100',
        cost_krw:'3',
      },
      {
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'VECTOR', responses:'2', avg_latency_ms:'200',
        cost_krw:'4',
      },
      {
        blind_id:'M02', display_name:'Legacy', model_id:'legacy-test',
        retrieval_mode:'LEGACY_EVIDENCE', responses:'0',
        avg_latency_ms:null, cost_krw:null,
      },
    ],
    [
      {
        purpose:'개념 적용',
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'NONE', responses:'1', avg_latency_ms:'90',
        cost_krw:'1',
      },
      {
        purpose:'개념 적용',
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'VECTOR', responses:'1', avg_latency_ms:'190',
        cost_krw:'2',
      },
      {
        purpose:'선수 관계',
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'NONE', responses:'1', avg_latency_ms:'110',
        cost_krw:'2',
      },
      {
        purpose:'선수 관계',
        blind_id:'M01', display_name:'Gemini', model_id:'gemini-test',
        retrieval_mode:'VECTOR', responses:'1', avg_latency_ms:'210',
        cost_krw:'2',
      },
      ...['개념 적용', '선수 관계'].map((purpose) => ({
        purpose,
        blind_id:'M02', display_name:'Legacy', model_id:'legacy-test',
        retrieval_mode:'LEGACY_EVIDENCE', responses:'0',
        avg_latency_ms:null, cost_krw:null,
      })),
    ],
    [
      {
        row_kind:'METRIC', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:'accuracy', average_value:'0.75',
        score_count:'2', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'METRIC', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'VECTOR', row_key:'accuracy', average_value:'0.25',
        score_count:'2', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'METRIC', scope_purpose:null, blind_id:'M02',
        retrieval_mode:'LEGACY_EVIDENCE', row_key:'accuracy',
        average_value:null, score_count:'0', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'METRIC', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:'prerequisite_relation_accuracy',
        average_value:'0.5', score_count:'1', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'PURPOSE', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:'개념 적용', average_value:'0.6',
        score_count:'1', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'PURPOSE', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:'선수 관계', average_value:'0.9',
        score_count:'1', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'METRIC', scope_purpose:'선수 관계', blind_id:'M01',
        retrieval_mode:'NONE', row_key:'accuracy', average_value:'0.9',
        score_count:'1', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'PURPOSE', scope_purpose:'선수 관계', blind_id:'M01',
        retrieval_mode:'NONE', row_key:'선수 관계',
        average_value:'0.9', score_count:'1', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'MODEL', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:null, average_value:null,
        score_count:'3', composite_score:'0.666667',
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'MODEL', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'VECTOR', row_key:null, average_value:null,
        score_count:'2', composite_score:'0.25',
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'MODEL', scope_purpose:'선수 관계', blind_id:'M01',
        retrieval_mode:'NONE', row_key:null, average_value:null,
        score_count:'1', composite_score:'0.9',
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'DISTRIBUTION', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'NONE', row_key:null, average_value:null,
        score_count:'0', composite_score:null,
        bin_0:'0', bin_1:'1', bin_2:'0', bin_3:'1', bin_4:'0',
      },
      {
        row_kind:'DISTRIBUTION', scope_purpose:null, blind_id:'M01',
        retrieval_mode:'VECTOR', row_key:null, average_value:null,
        score_count:'0', composite_score:null,
        bin_0:'1', bin_1:'1', bin_2:'0', bin_3:'0', bin_4:'0',
      },
      {
        row_kind:'DISTRIBUTION', scope_purpose:'선수 관계',
        blind_id:'M01', retrieval_mode:'NONE', row_key:null,
        average_value:null, score_count:'0', composite_score:null,
        bin_0:'0', bin_1:'0', bin_2:'0', bin_3:'0', bin_4:'1',
      },
    ],
  ];
  const returnedRowCounts:number[] = [];
  const queryable = {
    query: async () => {
      const rows = resultSets.shift() ?? [];
      returnedRowCounts.push(rows.length);
      return { rows };
    },
  } as unknown as NonNullable<Parameters<typeof getResultAnalytics>[1]>;

  const analytics = await getResultAnalytics('run-aggregate', queryable);

  expect(returnedRowCounts).toEqual([3, 6, 14]);
  expect(analytics.retrievalModes).toEqual(['NONE', 'VECTOR']);
  expect(analytics.purposeOptions).toEqual(['개념 적용', '선수 관계']);
  expect(analytics.models).toEqual([
    expect.objectContaining({
      seriesKey:'M01::NONE', responses:2, avgLatencyMs:100, costKrw:3,
      compositeScore:0.666667, scoreCount:3,
    }),
    expect.objectContaining({
      seriesKey:'M01::VECTOR', compositeScore:0.25, scoreCount:2,
    }),
    expect.objectContaining({
      seriesKey:'M02::LEGACY_EVIDENCE',
      compositeScore:null, scoreCount:0,
    }),
  ]);
  expect(
    analytics.metricRows.find((row) => row.metricKey === 'accuracy'),
  ).toEqual({
    metricKey:'accuracy',
    label:'정확성',
    scores:{ 'M01::NONE':0.75, 'M01::VECTOR':0.25 },
    counts:{ 'M01::NONE':2, 'M01::VECTOR':2 },
  });
  expect(analytics.prerequisiteRows).toEqual([
    expect.objectContaining({
      metricKey:'prerequisite_relation_accuracy',
      scores:{ 'M01::NONE':0.5 },
      counts:{ 'M01::NONE':1 },
    }),
  ]);
  expect(analytics.purposeRows).toEqual([
    {
      purpose:'개념 적용',
      scores:{ 'M01::NONE':0.6 },
      counts:{ 'M01::NONE':1 },
    },
    {
      purpose:'선수 관계',
      scores:{ 'M01::NONE':0.9 },
      counts:{ 'M01::NONE':1 },
    },
  ]);
  expect(analytics.distributions).toEqual([
    { blindId:'M01::NONE', bins:[0, 1, 0, 1, 0] },
    { blindId:'M01::VECTOR', bins:[1, 1, 0, 0, 0] },
    { blindId:'M02::LEGACY_EVIDENCE', bins:[0, 0, 0, 0, 0] },
  ]);
  expect(analytics.purposeViews['선수 관계']).toMatchObject({
    models:[
      expect.objectContaining({
        seriesKey:'M01::NONE', compositeScore:0.9, scoreCount:1,
      }),
      expect.objectContaining({
        seriesKey:'M01::VECTOR', compositeScore:null, scoreCount:0,
      }),
      expect.objectContaining({
        seriesKey:'M02::LEGACY_EVIDENCE', compositeScore:null, scoreCount:0,
      }),
    ],
    metricRows:[expect.objectContaining({
      metricKey:'accuracy',
      scores:{ 'M01::NONE':0.9 },
      counts:{ 'M01::NONE':1 },
    })],
    purposeRows:[{
      purpose:'선수 관계',
      scores:{ 'M01::NONE':0.9 },
      counts:{ 'M01::NONE':1 },
    }],
    distributions:[
      { blindId:'M01::NONE', bins:[0, 0, 0, 0, 1] },
      { blindId:'M01::VECTOR', bins:[0, 0, 0, 0, 0] },
      { blindId:'M02::LEGACY_EVIDENCE', bins:[0, 0, 0, 0, 0] },
    ],
  });
});

test('pages the heatmap by purpose, retrieval mode, and model with stable ordering', () => {
  const scores = Array.from({ length:120 }, (_, index) => ({
    blindId:index < 110 ? 'M01' : 'M02',
    retrievalMode:index < 110 ? 'VECTOR' as const : 'PIKE' as const,
    questionId:`q${index + 1}`,
    questionPublicId:`Q-${String(index + 1).padStart(3, '0')}`,
    questionText:`질문 ${index + 1}`,
    purpose:'선수 관계',
    metricKey:'accuracy',
    value:index === 30 ? null : index / 120,
  }));

  const page = buildResultQuestionHeatmapPage({
    scores,
    purpose:'선수 관계',
    retrievalModes:['VECTOR'],
    blindIds:['M01'],
    page:2,
    pageSize:25,
  });

  expect(page).toMatchObject({ total:110, page:2, pageSize:25 });
  expect(page.rows).toHaveLength(25);
  expect(page.rows[0]).toMatchObject({ publicId:'Q-026', questionText:'질문 26' });
  expect(page.rows[5]?.scores).toEqual({});
  expect(page.rows.at(-1)).toMatchObject({ publicId:'Q-050' });
});

test('returns empty collections instead of invented zero values', () => {
  expect(buildResultAnalytics({ models:[], scores:[] })).toMatchObject({
    models:[], metricRows:[], purposeRows:[], prerequisiteRows:[], distributions:[],
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
});

test('excludes the deprecated exact-match metric from rows and composite scores', () => {
  const analytics = buildResultAnalytics({
    models:[
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:null, costKrw:null },
    ],
    metricWeights:{ exact_match:100, accuracy:1 },
    scores:[
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'exact_match', value:1 },
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'질문', purpose:'선수 관계', metricKey:'accuracy', value:0.4 },
    ],
  });

  expect(analytics.metricRows.map((row) => row.metricKey)).toEqual(['accuracy']);
  expect(analytics.models[0]).toMatchObject({ compositeScore:0.4, scoreCount:1 });
});

test('builds an independently aggregated view for every question purpose', () => {
  const analytics = buildResultAnalytics({
    models:[
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:2, avgLatencyMs:null, costKrw:null },
      { blindId:'M02', displayName:'EXAONE', modelId:'exaone-test', responses:2, avgLatencyMs:null, costKrw:null },
    ],
    modelsByPurpose:{
      '선수 관계':[
        { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:900, costKrw:3 },
        { blindId:'M02', displayName:'EXAONE', modelId:'exaone-test', responses:0, avgLatencyMs:null, costKrw:null },
      ],
      '개념 적용':[
        { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:1100, costKrw:4 },
        { blindId:'M02', displayName:'EXAONE', modelId:'exaone-test', responses:1, avgLatencyMs:1500, costKrw:5 },
      ],
    },
    scores:[
      { blindId:'M01', questionId:'q1', questionPublicId:'Q-1', questionText:'선수 질문', purpose:'선수 관계', metricKey:'accuracy', value:0.9 },
      { blindId:'M02', questionId:'q1', questionPublicId:'Q-1', questionText:'선수 질문', purpose:'선수 관계', metricKey:'accuracy', value:null },
      { blindId:'M01', questionId:'q2', questionPublicId:'Q-2', questionText:'적용 질문', purpose:'개념 적용', metricKey:'accuracy', value:0.2 },
      { blindId:'M02', questionId:'q2', questionPublicId:'Q-2', questionText:'적용 질문', purpose:'개념 적용', metricKey:'accuracy', value:0.7 },
    ],
  });

  expect(analytics.purposeOptions).toEqual(['개념 적용', '선수 관계']);
  expect(analytics.purposeViews['선수 관계']?.models).toEqual([
    expect.objectContaining({
      blindId:'M01', responses:1, avgLatencyMs:900, costKrw:3,
      compositeScore:0.9, scoreCount:1,
    }),
    expect.objectContaining({
      blindId:'M02', responses:0, avgLatencyMs:null, costKrw:null,
      compositeScore:null, scoreCount:0,
    }),
  ]);
  expect(analytics.purposeViews['개념 적용']?.models).toEqual([
    expect.objectContaining({ blindId:'M02', compositeScore:0.7, scoreCount:1 }),
    expect.objectContaining({ blindId:'M01', compositeScore:0.2, scoreCount:1 }),
  ]);
});

test('retains an explicit run purpose when it has no score rows', () => {
  const analytics = buildResultAnalytics({
    models:[
      { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:1, avgLatencyMs:700, costKrw:2 },
    ],
    purposes:['미채점 목적'],
    modelsByPurpose:{
      '미채점 목적':[
        { blindId:'M01', displayName:'Gemini', modelId:'gemini-test', responses:0, avgLatencyMs:null, costKrw:null },
      ],
    },
    scores:[],
  });

  expect(analytics.purposeOptions).toEqual(['미채점 목적']);
  expect(analytics.purposeViews['미채점 목적']).toMatchObject({
    models:[{
      blindId:'M01', responses:0, avgLatencyMs:null, costKrw:null,
      compositeScore:null, scoreCount:0,
    }],
    metricRows:[],
    distributions:[{ blindId:'M01', bins:[0, 0, 0, 0, 0] }],
  });
});

test('keeps the same model separate across 일반, RAG, and Pike result series', () => {
  const analytics = buildResultAnalytics({
    models:[
      {
        blindId:'M01',
        retrievalMode:'NONE',
        displayName:'Gemini',
        modelId:'gemini-test',
        responses:1,
        avgLatencyMs:100,
        costKrw:1,
      },
      {
        blindId:'M01',
        retrievalMode:'VECTOR',
        displayName:'Gemini',
        modelId:'gemini-test',
        responses:1,
        avgLatencyMs:110,
        costKrw:2,
      },
      {
        blindId:'M01',
        retrievalMode:'PIKE',
        displayName:'Gemini',
        modelId:'gemini-test',
        responses:1,
        avgLatencyMs:120,
        costKrw:3,
      },
    ],
    scores:[
      {
        blindId:'M01',
        retrievalMode:'NONE',
        questionId:'q1',
        questionPublicId:'Q-1',
        questionText:'질문',
        purpose:'선수 관계',
        metricKey:'accuracy',
        value:0.2,
      },
      {
        blindId:'M01',
        retrievalMode:'VECTOR',
        questionId:'q1',
        questionPublicId:'Q-1',
        questionText:'질문',
        purpose:'선수 관계',
        metricKey:'accuracy',
        value:0.6,
      },
      {
        blindId:'M01',
        retrievalMode:'PIKE',
        questionId:'q1',
        questionPublicId:'Q-1',
        questionText:'질문',
        purpose:'선수 관계',
        metricKey:'accuracy',
        value:0.9,
      },
    ],
  });

  expect(analytics.retrievalModes).toEqual(['NONE', 'VECTOR', 'PIKE']);
  expect(analytics.models.map((model) => ({
    key:model.seriesKey,
    score:model.compositeScore,
  }))).toEqual([
    { key:'M01::PIKE', score:0.9 },
    { key:'M01::VECTOR', score:0.6 },
    { key:'M01::NONE', score:0.2 },
  ]);
  expect(
    analytics.metricRows.find((row) => row.metricKey === 'accuracy')?.scores,
  ).toEqual({
    'M01::NONE':0.2,
    'M01::VECTOR':0.6,
    'M01::PIKE':0.9,
  });
});
