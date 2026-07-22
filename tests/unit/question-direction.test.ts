import { expect, test } from 'vitest';
import {
  QUESTION_GENERATION_MAX_OUTPUT_TOKENS,
  buildQuestionDirectionInstructions,
  parseQuestionDirectionResponse,
} from '@/server/questions/direction';

test('doubles the question generation output budget', () => {
  expect(QUESTION_GENERATION_MAX_OUTPUT_TOKENS).toBe(16_384);
});

test('builds a distinct per-question direction before retrieval', () => {
  const first = buildQuestionDirectionInstructions({
    conditions: { subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이', difficulty: '상', direction: '선수 관계를 활용' },
    ordinal: 1,
    total: 10,
  });
  const second = buildQuestionDirectionInstructions({
    conditions: { subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이', difficulty: '상', direction: '선수 관계를 활용' },
    ordinal: 2,
    total: 10,
  });

  expect(first.prompt).toContain('관련 자료를 검색하기 전에');
  expect(first.prompt).toContain('dependency_application');
  expect(first.prompt).toContain('searchQuery');
  expect(second.prompt).toContain('missing_prerequisite_diagnosis');
  expect(first.prompt).not.toBe(second.prompt);
});

test('parses a search-ready question direction', () => {
  expect(parseQuestionDirectionResponse(JSON.stringify({
    directionSummary: '속도 변화에서 가속도로 이어지는 관계를 적용한다.',
    targetConceptQuery: '가속도 속도 변화 시간 간격',
    prerequisiteQuery: '속도 속도 변화량 선수 개념',
    searchQuery: '역학 가속도 속도 변화 시간 간격 관계 적용',
  }))).toEqual({
    directionSummary: '속도 변화에서 가속도로 이어지는 관계를 적용한다.',
    targetConceptQuery: '가속도 속도 변화 시간 간격',
    prerequisiteQuery: '속도 속도 변화량 선수 개념',
    searchQuery: '역학 가속도 속도 변화 시간 간격 관계 적용',
  });
});

test('rejects a direction without a usable vector search query', () => {
  expect(() => parseQuestionDirectionResponse(JSON.stringify({
    directionSummary: '방향', targetConceptQuery: '목표', prerequisiteQuery: '선수', searchQuery: '',
  }))).toThrow('DIRECTION_PARSE_FAILED');
});
