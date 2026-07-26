import { describe, expect, test } from 'vitest';
import {
  canTransitionJudgeInvocationState,
  currentScoringEngineDefinition,
  isCurrentScoringEngineSnapshot,
  isTerminalJudgeInvocationState,
  isVerifiedScoringEngineSnapshot,
  scoringEngineVersion,
} from '@/domain/scoring-engine';

describe('scoring engine domain contract', () => {
  test('publishes the substantive current scoring behavior', () => {
    expect(scoringEngineVersion).toBe('edubench-scoring-v1');
    expect(currentScoringEngineDefinition).toMatchObject({
      version:'edubench-scoring-v1',
      deterministic:{
        exactMatch:{
          implementationVersion:'normalize-korean-answer-v1',
          normalization:expect.arrayContaining([
            'Unicode NFC normalization',
            'collapse whitespace',
            'Korean-locale lowercase',
          ]),
        },
      },
      metricResolution:{
        prerequisiteMetrics:[
          'target_concept_correctness',
          'prerequisite_identification',
          'prerequisite_relation_accuracy',
          'prerequisite_application',
          'reasoning_chain_completeness',
          'textbook_grounding',
        ],
      },
      prerequisiteMetricRubrics:{
        prerequisite_application:expect.stringContaining('용어 나열만 하면 0'),
        textbook_grounding:expect.stringContaining('textbookEvidence'),
      },
      judge:{
        systemPrompt:expect.stringContaining('EDUBENCH_JUDGE_JSON'),
        outputSchema:{
          properties:{
            scores:{
              items:{
                properties:{
                  value:{ minimum:0, maximum:1 },
                },
              },
            },
          },
        },
        parser:{
          implementationVersion:'first-last-json-object-zod-v1',
          metricSelection:'primary and fallback responses both require exact metricKey matches; mismatched keys are unresolved',
        },
        batching:{
          implementationVersion:'all-required-metrics-then-single-metric-fallback-v1',
        },
        sampling:{ temperature:0, maxOutputTokens:8192 },
      },
    });
    expect(
      currentScoringEngineDefinition.judge.sampling,
    ).not.toHaveProperty('currentEnvironmentOverride');
  });

  test('allows only the durable forward lifecycle transitions', () => {
    expect(canTransitionJudgeInvocationState('REQUESTED', 'RESPONSE_RECEIVED')).toBe(true);
    expect(canTransitionJudgeInvocationState('REQUESTED', 'FAILED')).toBe(true);
    expect(canTransitionJudgeInvocationState('RESPONSE_RECEIVED', 'PARSED')).toBe(true);
    expect(canTransitionJudgeInvocationState('PARSED', 'PERSISTED')).toBe(true);
    expect(canTransitionJudgeInvocationState('PARSED', 'REQUESTED')).toBe(false);
    expect(canTransitionJudgeInvocationState('PERSISTED', 'FAILED')).toBe(false);
    expect(isTerminalJudgeInvocationState('PERSISTED')).toBe(true);
    expect(isTerminalJudgeInvocationState('FAILED')).toBe(true);
    expect(isTerminalJudgeInvocationState('PARSED')).toBe(false);
  });

  test('recognizes only an internally matching verified run snapshot', () => {
    const hash = 'a'.repeat(64);
    expect(isVerifiedScoringEngineSnapshot({
      scoringEngineVersionId:'31d7f4d3-d24e-4b36-b890-5a08c3237075',
      scoringEngineSnapshot:{
        id:'31d7f4d3-d24e-4b36-b890-5a08c3237075',
        version:'edubench-scoring-v1',
        title:'engine',
        definition:currentScoringEngineDefinition,
        contentHash:hash,
      },
      provenance:'AT_CREATION_VERIFIED',
    })).toBe(true);
    expect(isVerifiedScoringEngineSnapshot({
      scoringEngineVersionId:'31d7f4d3-d24e-4b36-b890-5a08c3237075',
      scoringEngineSnapshot:{
        id:'5e338285-a64d-425c-95de-dc314fd72aa7',
        version:'edubench-scoring-v1',
        title:'engine',
        definition:currentScoringEngineDefinition,
        contentHash:hash,
      },
      provenance:'AT_CREATION_VERIFIED',
    })).toBe(false);
    expect(isVerifiedScoringEngineSnapshot({
      scoringEngineVersionId:null,
      scoringEngineSnapshot:null,
      provenance:'LEGACY_BACKFILL_UNVERIFIED',
    })).toBe(false);
  });

  test('rejects a verified snapshot whose rules differ from the runtime engine', () => {
    const id = '31d7f4d3-d24e-4b36-b890-5a08c3237075';
    const base = {
      scoringEngineVersionId:id,
      provenance:'AT_CREATION_VERIFIED',
    } as const;
    expect(isCurrentScoringEngineSnapshot({
      ...base,
      scoringEngineSnapshot:{
        id,
        version:scoringEngineVersion,
        title:'EduBench 선수관계 평가 엔진 v1',
        definition:{
          judge:currentScoringEngineDefinition.judge,
          version:currentScoringEngineDefinition.version,
          title:currentScoringEngineDefinition.title,
          deterministic:currentScoringEngineDefinition.deterministic,
          metricResolution:currentScoringEngineDefinition.metricResolution,
          prerequisiteMetricRubrics:
            currentScoringEngineDefinition.prerequisiteMetricRubrics,
        },
        contentHash:'a'.repeat(64),
      },
    })).toBe(true);
    expect(isCurrentScoringEngineSnapshot({
      ...base,
      scoringEngineSnapshot:{
        id,
        version:scoringEngineVersion,
        title:'EduBench 선수관계 평가 엔진 v1',
        definition:{
          ...currentScoringEngineDefinition,
          judge:{
            ...currentScoringEngineDefinition.judge,
            sampling:{ temperature:0, maxOutputTokens:4096 },
          },
        },
        contentHash:'a'.repeat(64),
      },
    })).toBe(false);
  });
});
