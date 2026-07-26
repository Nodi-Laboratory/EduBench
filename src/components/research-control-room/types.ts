export type DatabaseSignal = {
  state: 'HEALTHY' | 'DOWN';
  latencyMs: number | null;
};

export type WorkerSignal = {
  state: 'HEALTHY' | 'IDLE' | 'STALE';
  activeLeases: number;
  staleLeases: number;
};

export type QueueSignal = {
  pending: number;
  retryWait: number;
  leased: number;
};

export type PipelineStage = {
  key: string;
  label: string;
  active: number;
  failed: number;
  ready: number;
};

export type ActiveOperation = {
  aggregateType: string;
  aggregateId: string;
  label: string;
  stage: string;
  state: string;
  progress: Record<string, unknown> | null;
  updatedAt: string;
  error: {
    code: string | null;
    message: string;
  } | null;
};

export type ControlRoomFailure = {
  aggregateType: string;
  aggregateId: string;
  label: string;
  stage: string;
  code: string;
  message: string;
  updatedAt: string;
};

export type ControlRoomEvent = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  stage: string;
  state: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ActiveProfile = {
  kind: string;
  id: string;
  version: string;
  title: string;
  hash: string;
  activatedAt: string;
};

export type ScoreboardRow = {
  runId: string;
  runLabel: string;
  model: string;
  metric: string;
  mean: number | null;
  scored: number;
  eligible: number;
};

export type ControlRoomSnapshot = {
  eventCursor: string;
  generatedAt: string;
  system: {
    database: DatabaseSignal | null;
    worker: WorkerSignal | null;
    queue: QueueSignal | null;
  } | null;
  pipelineStages: PipelineStage[];
  activeOperations: ActiveOperation[];
  failures: ControlRoomFailure[];
  failureTotal: number;
  recentEvents: ControlRoomEvent[];
  profiles: ActiveProfile[];
  scoreboard: ScoreboardRow[];
  scoreboardTotal: number;
};

export type InspectorRecord = {
  kind: 'stage' | 'operation' | 'failure' | 'event';
  title: string;
  summary: string;
  stage: string;
  state: string;
  occurredAt: string | null;
  payload: unknown;
};
