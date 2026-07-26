import { prerequisiteMetricRubrics, prerequisiteScoreMetrics } from '@/domain/prerequisite-benchmark';

export const scoringEngineVersion = 'edubench-scoring-v1' as const;
export const scoringEngineReplacementRequiredMessage =
  '실행에 고정된 채점 엔진의 정의 또는 출처를 현재 코드로 검증할 수 없습니다. 현재 엔진으로 새 실행을 생성하십시오.';

export const scoringEngineSnapshotProvenances = [
  'LEGACY_BACKFILL_UNVERIFIED',
  'AT_CREATION_VERIFIED',
] as const;

export type ScoringEngineSnapshotProvenance =
  typeof scoringEngineSnapshotProvenances[number];

export const scoreProvenances = [
  'LEGACY_UNVERIFIED',
  'DETERMINISTIC_ENGINE_VERIFIED',
  'JUDGE_INVOCATION_VERIFIED',
] as const;

export type ScoreProvenance = typeof scoreProvenances[number];

export const judgeInvocationStates = [
  'REQUESTED',
  'RESPONSE_RECEIVED',
  'PARSED',
  'PERSISTED',
  'FAILED',
] as const;

export type JudgeInvocationState = typeof judgeInvocationStates[number];

export const judgeInvocationKinds = ['PRIMARY', 'FALLBACK'] as const;
export type JudgeInvocationKind = typeof judgeInvocationKinds[number];

const judgeInvocationTransitions: Readonly<
  Record<JudgeInvocationState, readonly JudgeInvocationState[]>
> = {
  REQUESTED:['RESPONSE_RECEIVED', 'FAILED'],
  RESPONSE_RECEIVED:['PARSED', 'FAILED'],
  PARSED:['PERSISTED', 'FAILED'],
  PERSISTED:[],
  FAILED:[],
};

export function canTransitionJudgeInvocationState(
  from: JudgeInvocationState,
  to: JudgeInvocationState,
): boolean {
  return judgeInvocationTransitions[from].includes(to);
}

export function isTerminalJudgeInvocationState(
  state: JudgeInvocationState,
): boolean {
  return state === 'PERSISTED' || state === 'FAILED';
}

export const currentScoringEngineDefinition = {
  version:scoringEngineVersion,
  title:'EduBench 선수관계 평가 엔진 v1',
  deterministic:{
    exactMatch:{
      implementationVersion:'normalize-korean-answer-v1',
      normalization:[
        'Unicode NFC normalization',
        'CRLF to LF',
        'collapse whitespace',
        'trim',
        'remove trailing . ! ? and ideographic full stop',
        'Korean-locale lowercase',
      ],
      comparison:'normalized candidate equals any normalized accepted answer or reference answer',
      range:[0, 1],
    },
    responsePresent:{
      implementationVersion:'normalized-response-present-v1',
      rule:'normalized response length is greater than zero',
      range:[0, 1],
    },
  },
  metricResolution:{
    implementationVersion:'required-metrics-v1',
    baseMetrics:['exact_match', 'response_present'],
    profileMetrics:'append score profile metrics in stored order and deduplicate by first occurrence',
    prerequisiteBenchmarkType:'PREREQUISITE_RELATIONSHIP',
    prerequisiteMetrics:[...prerequisiteScoreMetrics],
  },
  prerequisiteMetricRubrics:{ ...prerequisiteMetricRubrics },
  judge:{
    systemPrompt:'EDUBENCH_JUDGE_JSON. 지정된 metricKey만 빠짐없이 채점한다. 모델 이름을 보지 말고 제공된 루브릭과 교과서 근거만으로 절대평가한다.',
    requestFields:[
      'requiredMetrics',
      'instruction',
      'rubricPrompt',
      'question',
      'referenceAnswer',
      'acceptedAnswers',
      'scoringCriteria',
      'benchmarkDesign',
      'prerequisiteMetricRubrics',
      'evidenceMode',
      'textbookEvidence',
      'candidateResponse',
      'outputSchema',
    ],
    outputSchema:{
      type:'object',
      required:['scores'],
      properties:{
        scores:{
          type:'array',
          items:{
            type:'object',
            required:['metricKey', 'value', 'label', 'rationale'],
            properties:{
              metricKey:{ type:'string' },
              value:{
                type:['number', 'numeric string'],
                minimum:0,
                maximum:1,
              },
              label:{ type:'string', blankFallback:'SCORED' },
              rationale:{
                type:'string',
                blankFallback:'채점 모델이 설명을 생략했습니다.',
              },
              evidence:{
                type:'array',
                default:[],
                items:{
                  type:'object',
                  properties:{
                    claim:{ type:'string', optional:true },
                    quote:{ type:'string', optional:true },
                    chunkId:{ type:'string', optional:true },
                  },
                },
              },
            },
          },
        },
      },
    },
    parser:{
      implementationVersion:'first-last-json-object-zod-v1',
      extraction:'parse the substring from the first opening brace through the last closing brace',
      validation:'scores array; value coerced from a nonblank numeric string then constrained to 0..1; blank label and rationale receive fixed fallbacks; evidence is normalized',
      metricSelection:'primary and fallback responses both require exact metricKey matches; mismatched keys are unresolved',
    },
    batching:{
      implementationVersion:'all-required-metrics-then-single-metric-fallback-v1',
      primary:'request all unresolved Judge metrics in one call',
      fallback:'request each metric omitted by the primary response in a separate one-metric call',
    },
    sampling:{
      temperature:0,
      maxOutputTokens:8192,
    },
  },
} as const;

export type ScoringEngineDefinition =
  typeof currentScoringEngineDefinition;

export type ScoringEngineSnapshot = {
  id: string;
  version: string;
  title: string;
  definition: unknown;
  contentHash: string;
};

export function isVerifiedScoringEngineSnapshot(input: {
  scoringEngineVersionId:string | null | undefined;
  scoringEngineSnapshot:unknown;
  provenance:string | null | undefined;
}): input is {
  scoringEngineVersionId:string;
  scoringEngineSnapshot:ScoringEngineSnapshot;
  provenance:'AT_CREATION_VERIFIED';
} {
  if (
    input.provenance !== 'AT_CREATION_VERIFIED'
    || typeof input.scoringEngineVersionId !== 'string'
    || !input.scoringEngineVersionId
    || !input.scoringEngineSnapshot
    || typeof input.scoringEngineSnapshot !== 'object'
    || Array.isArray(input.scoringEngineSnapshot)
  ) return false;

  const snapshot = input.scoringEngineSnapshot as Record<string, unknown>;
  if (
    snapshot.id !== input.scoringEngineVersionId
    || typeof snapshot.version !== 'string'
    || !snapshot.version
    || typeof snapshot.title !== 'string'
    || !snapshot.title
    || !snapshot.definition
    || typeof snapshot.definition !== 'object'
    || Array.isArray(snapshot.definition)
    || typeof snapshot.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(snapshot.contentHash)
  ) return false;

  const definition = snapshot.definition as Record<string, unknown>;
  return definition.version === snapshot.version;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  const serialized = JSON.stringify(value);
  return serialized ?? 'null';
}

export function isCurrentScoringEngineSnapshot(input: {
  scoringEngineVersionId:string | null | undefined;
  scoringEngineSnapshot:unknown;
  provenance:string | null | undefined;
}): input is {
  scoringEngineVersionId:string;
  scoringEngineSnapshot:ScoringEngineSnapshot & {
    version:typeof scoringEngineVersion;
    definition:ScoringEngineDefinition;
  };
  provenance:'AT_CREATION_VERIFIED';
} {
  return isVerifiedScoringEngineSnapshot(input)
    && input.scoringEngineSnapshot.version === scoringEngineVersion
    && canonicalJson(input.scoringEngineSnapshot.definition)
      === canonicalJson(currentScoringEngineDefinition);
}
