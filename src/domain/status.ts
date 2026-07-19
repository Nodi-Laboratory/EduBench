import { DomainError } from './errors';

export type RunState =
  | 'DRAFT' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'SCORING'
  | 'CANCELLING' | 'CANCELLED' | 'COMPLETED' | 'FAILED';
export type RunCommand =
  | 'QUEUE' | 'START' | 'PAUSE' | 'RESUME' | 'BEGIN_SCORING'
  | 'CANCEL' | 'FINISH_CANCEL' | 'COMPLETE' | 'FAIL';

const runTransitions = new Map<string, RunState>([
  ['DRAFT:QUEUE', 'QUEUED'],
  ['QUEUED:START', 'RUNNING'],
  ['RUNNING:PAUSE', 'PAUSED'],
  ['PAUSED:RESUME', 'RUNNING'],
  ['RUNNING:BEGIN_SCORING', 'SCORING'],
  ['SCORING:COMPLETE', 'COMPLETED'],
  ['QUEUED:CANCEL', 'CANCELLING'],
  ['RUNNING:CANCEL', 'CANCELLING'],
  ['PAUSED:CANCEL', 'CANCELLING'],
  ['CANCELLING:FINISH_CANCEL', 'CANCELLED'],
  ['QUEUED:FAIL', 'FAILED'],
  ['RUNNING:FAIL', 'FAILED'],
  ['SCORING:FAIL', 'FAILED'],
]);

export function transitionRun(current: RunState, command: RunCommand): RunState {
  const next = runTransitions.get(`${current}:${command}`);
  if (!next) {
    throw new DomainError('INVALID_RUN_TRANSITION', `${current} 상태에서 ${command} 명령을 실행할 수 없습니다.`, { current, command });
  }
  return next;
}

export type DocumentState =
  | 'UPLOADED' | 'PARSING' | 'PARSED' | 'HTML_REVIEWED' | 'CHUNKING'
  | 'CHUNKED' | 'EMBEDDING' | 'READY' | 'FAILED';
export type DocumentCommand =
  | 'PARSE' | 'PARSE_COMPLETE' | 'APPROVE_HTML' | 'CHUNK' | 'CHUNK_COMPLETE'
  | 'EMBED' | 'EMBED_COMPLETE' | 'FAIL' | 'RETRY';

const documentTransitions = new Map<string, DocumentState>([
  ['UPLOADED:PARSE', 'PARSING'],
  ['PARSING:PARSE_COMPLETE', 'PARSED'],
  ['PARSED:APPROVE_HTML', 'HTML_REVIEWED'],
  ['HTML_REVIEWED:CHUNK', 'CHUNKING'],
  ['CHUNKING:CHUNK_COMPLETE', 'CHUNKED'],
  ['CHUNKED:EMBED', 'EMBEDDING'],
  ['EMBEDDING:EMBED_COMPLETE', 'READY'],
  ['PARSING:FAIL', 'FAILED'],
  ['CHUNKING:FAIL', 'FAILED'],
  ['EMBEDDING:FAIL', 'FAILED'],
]);

export function transitionDocument(
  current: DocumentState,
  command: DocumentCommand,
  failedStage?: Exclude<DocumentState, 'FAILED' | 'READY'>,
): DocumentState {
  if (current === 'FAILED' && command === 'RETRY' && failedStage) return failedStage;
  const next = documentTransitions.get(`${current}:${command}`);
  if (!next) {
    throw new DomainError('INVALID_DOCUMENT_TRANSITION', `${current} 상태에서 ${command} 명령을 실행할 수 없습니다.`, { current, command, failedStage });
  }
  return next;
}

export type QuestionState = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'HELD' | 'DELETED';
export type QuestionCommand = 'SUBMIT' | 'APPROVE' | 'EDIT_AND_APPROVE' | 'HOLD' | 'REOPEN' | 'DELETE';

const questionTransitions = new Map<string, QuestionState>([
  ['DRAFT:SUBMIT', 'IN_REVIEW'],
  ['IN_REVIEW:APPROVE', 'APPROVED'],
  ['IN_REVIEW:EDIT_AND_APPROVE', 'APPROVED'],
  ['IN_REVIEW:HOLD', 'HELD'],
  ['HELD:REOPEN', 'IN_REVIEW'],
  ['DRAFT:DELETE', 'DELETED'],
  ['IN_REVIEW:DELETE', 'DELETED'],
  ['HELD:DELETE', 'DELETED'],
]);

export function transitionQuestion(current: QuestionState, command: QuestionCommand): QuestionState {
  const next = questionTransitions.get(`${current}:${command}`);
  if (!next) {
    throw new DomainError('INVALID_QUESTION_TRANSITION', `${current} 상태에서 ${command} 명령을 실행할 수 없습니다.`, { current, command });
  }
  return next;
}

