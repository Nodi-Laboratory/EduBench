import { expect, test } from 'vitest';
import {
  assignedQuestionGenerationUnit,
  buildQuestionGenerationInstructions,
  thinkingLevelForDifficulty,
} from '@/domain/question-prompt';

test('raises Gemini thinking level with question difficulty', () => {
  expect(thinkingLevelForDifficulty('하')).toBe('LOW');
  expect(thinkingLevelForDifficulty('중')).toBe('MEDIUM');
  expect(thinkingLevelForDifficulty('상')).toBe('HIGH');
});

test('turns high difficulty into a CSAT-level discrimination contract', () => {
  const instructions = buildQuestionGenerationInstructions({
    conditions: {
      subject: '통합과학', grade: '고등학교 1학년', units: ['물질과 규칙성'],
      purpose: '개념 적용·문제풀이', questionType: '객관식', difficulty: '상',
      direction: '자료를 분석하게 구성', crossUnit: false,
    },
    ordinal: 1, total: 10, evidence: '[교과서 근거]',
  });

  expect(instructions.prompt).toContain('수능 고난도');
  expect(instructions.prompt).toContain('최소 3단계');
  expect(instructions.prompt).toContain('단순 정의 회상형을 금지');
  expect(instructions.prompt).toContain('5개 선택지');
  expect(instructions.prompt).toContain('자료를 분석하게 구성');
  expect(instructions.prompt).toContain('개념 적용·문제풀이');
});

test('gives different explicit contracts to purpose and question type', () => {
  const instructions = buildQuestionGenerationInstructions({
    conditions: {
      subject: '과학', grade: '중학교 2학년', units: ['전기와 자기'],
      purpose: '오개념·잘못된 주장 교정', questionType: '학생 설명형', difficulty: '중',
      direction: '학생의 주장을 평가', crossUnit: false,
    },
    ordinal: 2, total: 4, evidence: '[교과서 근거]',
  });

  expect(instructions.prompt).toContain('대표 오개념');
  expect(instructions.prompt).toContain('학생의 설명·주장');
  expect(instructions.prompt).toContain('오류를 찾아 교정');
});

test('defines detailed and distinct contracts for low and medium difficulty', () => {
  const base = { subject: '과학', grade: '중학교 2학년', units: ['전기와 자기'], purpose: '핵심 개념 이해', questionType: '단답형', direction: '', crossUnit: false };
  const low = buildQuestionGenerationInstructions({ conditions: { ...base, difficulty: '하' }, ordinal: 1, total: 2, evidence: '근거' }).prompt;
  const medium = buildQuestionGenerationInstructions({ conditions: { ...base, difficulty: '중' }, ordinal: 2, total: 2, evidence: '근거' }).prompt;

  expect(low).toContain('교과서 문장의 단순 복사 문제는 금지');
  expect(low).toContain('한 번의 개념 판단');
  expect(low).toContain('불필요한 함정');
  expect(medium).toContain('최소 2단계');
  expect(medium).toContain('서로 다른 근거 조각');
  expect(medium).toContain('낯설지만 해석 가능한 상황');
  expect(medium).toContain('부분적으로 맞지만 핵심 조건을 놓친 판단');
});

test('adds a non-template diversity contract that changes by question ordinal', () => {
  const conditions = { subject: '과학', grade: '고등학교 1학년', purpose: '개념 적용·문제풀이', questionType: '객관식', difficulty: '상' };
  const first = buildQuestionGenerationInstructions({ conditions, ordinal: 1, total: 3, evidence: '근거' }).prompt;
  const second = buildQuestionGenerationInstructions({ conditions, ordinal: 2, total: 3, evidence: '근거' }).prompt;

  expect(first).toContain('고정 템플릿으로 사용하지 않는다');
  expect(first).toContain('[문항 다양성 계약]');
  expect(first).not.toBe(second);
});

test.each([
  ['핵심 개념 이해', '개념의 적용 조건과 성립 범위'],
  ['개념 적용·문제풀이', '해결에 필요한 개념을 스스로 선택'],
  ['여러 단원 연결 추론', '각 단원 개념이 연결되는 중간 논리'],
  ['학생 수준별 설명', '핵심 용어를 누락하지 않으면서'],
  ['오개념·잘못된 주장 교정', '왜 그 생각이 그럴듯해 보이는지'],
])('expands the %s purpose into a multi-part assessment contract', (purpose, expected) => {
  const prompt = buildQuestionGenerationInstructions({
    conditions: { subject: '과학', grade: '고등학교 1학년', purpose, questionType: '구조화 서술형', difficulty: '중' },
    ordinal: 1, total: 1, evidence: '근거',
  }).prompt;
  expect(prompt).toContain(expected);
});

test.each([
  ['구조화 서술형', '채점 가능한 하위 요구'],
  ['객관식', '선택지 길이와 문법 구조'],
  ['단답형', '정답 공간을 하나로 수렴'],
  ['학생 설명형', '주장-근거-연결 논리'],
])('expands the %s format into a detailed construction contract', (questionType, expected) => {
  const prompt = buildQuestionGenerationInstructions({
    conditions: { subject: '과학', grade: '중학교 2학년', purpose: '핵심 개념 이해', questionType, difficulty: '중' },
    ordinal: 1, total: 1, evidence: '근거',
  }).prompt;
  expect(prompt).toContain(expected);
});

test('requires every question to measure a directed prerequisite relationship', () => {
  const prompt = buildQuestionGenerationInstructions({
    conditions: { subject: '과학', grade: '고등학교 1학년', units: ['역학'], purpose: '개념 적용·문제풀이', questionType: '구조화 서술형', difficulty: '상' },
    ordinal: 3, total: 5, evidence: '근거',
  }).prompt;

  expect(prompt).toContain('[선수 관계 벤치마크 계약]');
  expect(prompt).toContain('선수 개념만으로 목표 개념을 설명');
  expect(prompt).toContain('선수 관계의 방향');
  expect(prompt).toContain('필수 추론 단계');
  expect(prompt).toContain('누락 진단');
});

test('assigns one deterministic selected unit to each single-unit question prompt', () => {
  const conditions = {
    subject:'과학', grade:'중학교 2학년', units:['물질', '전기', '생명'],
    purpose:'핵심 개념 이해', questionType:'서술형', difficulty:'중', direction:'', crossUnit:false,
  };
  const prompt = buildQuestionGenerationInstructions({
    conditions,
    ordinal:5,
    total:9,
    evidence:'[]',
  });

  expect(assignedQuestionGenerationUnit(conditions, 5)).toBe('전기');
  expect(prompt.prompt).toContain('- 선택 단원: 전기');
  expect(prompt.prompt).not.toContain('물질 / 전기 / 생명');
});

test('assigns two adjacent units to each cross-unit question prompt without exposing every selection', () => {
  const units = Array.from({ length:70 }, (_, index) => `단원 ${index + 1}`);
  const conditions = {
    subject:'과학', grade:'중학교 2학년', units,
    purpose:'여러 단원 연결 추론', questionType:'서술형', difficulty:'중', direction:'', crossUnit:true,
  };
  const prompt = buildQuestionGenerationInstructions({
    conditions,
    ordinal:37,
    total:70,
    evidence:'[]',
  });

  expect(assignedQuestionGenerationUnit(conditions, 37)).toBe('단원 37 / 단원 38');
  expect(prompt.prompt).toContain('- 선택 단원: 단원 37 / 단원 38');
  expect(prompt.prompt).toContain('배정된 두 단원(단원 37 / 단원 38)의 개념을 실제 풀이에 사용한다');
  expect(prompt.prompt).not.toContain('단원 36');
  expect(prompt.prompt).not.toContain('단원 39');
});

test('states the cross-field prerequisite target invariant as a mechanical output contract', () => {
  const instructions = buildQuestionGenerationInstructions({
    conditions: {
      subject: '과학',
      grade: '고등학교 1학년',
      units: ['역학'],
      purpose: '선수관계 측정',
      questionType: '구조화 서술형',
      difficulty: '상',
    },
    ordinal: 1,
    total: 1,
    evidence: '근거',
  });

  expect(instructions.system).toContain('필드 간 불변조건');
  expect(instructions.prompt).toContain('targetConcept 문자열을 그대로 복사');
  expect(instructions.prompt).toContain('공백·조사·괄호·기호까지 완전히 동일');
});
