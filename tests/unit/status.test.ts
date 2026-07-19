import { describe, expect, test } from 'vitest';
import { transitionDocument, transitionQuestion, transitionRun } from '@/domain/status';

describe('run state machine', () => {
  test('pauses and resumes only from valid states', () => {
    expect(transitionRun('RUNNING', 'PAUSE')).toBe('PAUSED');
    expect(transitionRun('PAUSED', 'RESUME')).toBe('RUNNING');
    expect(() => transitionRun('COMPLETED', 'PAUSE')).toThrow('INVALID_RUN_TRANSITION');
  });

  test('moves a running benchmark through scoring before completion', () => {
    expect(transitionRun('RUNNING', 'BEGIN_SCORING')).toBe('SCORING');
    expect(transitionRun('SCORING', 'COMPLETE')).toBe('COMPLETED');
  });
});

test('document retries from its failed processing stage', () => {
  expect(transitionDocument('FAILED', 'RETRY', 'EMBEDDING')).toBe('EMBEDDING');
  expect(() => transitionDocument('READY', 'RETRY', 'PARSING')).toThrow('INVALID_DOCUMENT_TRANSITION');
});

test('question edit-and-approve creates the approved state', () => {
  expect(transitionQuestion('IN_REVIEW', 'EDIT_AND_APPROVE')).toBe('APPROVED');
  expect(() => transitionQuestion('DELETED', 'APPROVE')).toThrow('INVALID_QUESTION_TRANSITION');
});

