type TaskErrorHandler = (error: unknown, taskId: string) => void;
type ClaimableTask = { id:string };

export class TaskSlotPool {
  private readonly active = new Map<
    string,
    { kind:string; promise:Promise<void> }
  >();

  constructor(
    private readonly limits: Readonly<Record<string, number>>,
    private readonly onError: TaskErrorHandler = () => undefined,
  ) {
    for (const [kind, limit] of Object.entries(limits)) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError(`Task slot limit for ${kind} must be positive.`);
      }
    }
  }

  available(kind: string) {
    const limit = this.limits[kind] ?? 0;
    let active = 0;
    for (const task of this.active.values()) {
      if (task.kind === kind) active += 1;
    }
    return Math.max(0, limit - active);
  }

  start(
    kind: string,
    taskId: string,
    operation: () => Promise<unknown>,
  ) {
    if (this.active.has(taskId) || this.available(kind) < 1) return false;
    const promise = Promise.resolve()
      .then(async () => {
        await operation();
      })
      .catch((error: unknown) => {
        this.onError(error, taskId);
      })
      .finally(() => {
        this.active.delete(taskId);
      });
    this.active.set(taskId, { kind, promise });
    return true;
  }

  async drain() {
    while (this.active.size) {
      await Promise.all(
        [...this.active.values()].map((task) => task.promise),
      );
    }
  }
}

export async function fillTaskSlots<T extends ClaimableTask>(options: {
  pool:TaskSlotPool;
  kind:string;
  claim:(limit: number) => Promise<readonly T[]>;
  run:(task: T) => Promise<unknown>;
  onClaimError?:(error: unknown, kind: string) => void;
}) {
  const available = options.pool.available(options.kind);
  if (available < 1) return 0;
  let tasks: readonly T[];
  try {
    tasks = await options.claim(available);
  } catch (error) {
    options.onClaimError?.(error, options.kind);
    return 0;
  }
  let started = 0;
  for (const task of tasks) {
    if (options.pool.start(
      options.kind,
      task.id,
      () => options.run(task),
    )) {
      started += 1;
    }
  }
  return started;
}
