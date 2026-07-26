import { effectiveDocumentParseConcurrency } from '@/domain/document-parse-config';
import { db } from '@/server/db/pool';
import type { RequestConcurrencyGate } from './concurrency-gate';

export type AdvisoryLockClient = {
  query<T>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows:T[] }>;
  release(destroy?: boolean): void;
};

export type AdvisoryLockPool = {
  connect(): Promise<AdvisoryLockClient>;
};

type PostgresGateOptions = {
  namespace: number;
  limit: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForSlot(
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once:true });
    removeAbortListener = () =>
      signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([sleep(delayMs), aborted]);
  } finally {
    removeAbortListener();
  }
}

async function connectWithSignal(
  pool: AdvisoryLockPool,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const pendingConnection = pool.connect();
  if (!signal) return pendingConnection;
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once:true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([pendingConnection, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void pendingConnection.then(
        (client) => client.release(),
        () => undefined,
      );
    }
    throw error;
  } finally {
    removeAbortListener();
  }
}

export class PostgresAdvisoryConcurrencyGate
implements RequestConcurrencyGate {
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly pool: AdvisoryLockPool,
    private readonly options: PostgresGateOptions,
  ) {
    if (
      !Number.isInteger(options.limit)
      || options.limit < 1
      || !Number.isInteger(options.namespace)
    ) {
      throw new TypeError(
        'PostgreSQL concurrency gate requires an integer namespace and positive limit.',
      );
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async acquire(signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      const client = await connectWithSignal(this.pool, signal);
      let acquiredSlot: number | null = null;
      try {
        for (let slot = 0; slot < this.options.limit; slot += 1) {
          signal?.throwIfAborted();
          const result = await client.query<{ locked:boolean }>(
            'select pg_try_advisory_lock($1::int,$2::int) locked',
            [this.options.namespace, slot],
          );
          if (result.rows[0]?.locked) {
            acquiredSlot = slot;
            return { client, slot };
          }
        }
      } finally {
        if (acquiredSlot == null) client.release();
      }
      await waitForSlot(
        this.pollIntervalMs,
        this.sleep,
        signal,
      );
    }
  }

  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { client, slot } = await this.acquire(signal);
    let destroyClient = false;
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      try {
        await client.query(
          'select pg_advisory_unlock($1::int,$2::int) unlocked',
          [this.options.namespace, slot],
        );
      } catch {
        destroyClient = true;
      } finally {
        client.release(destroyClient);
      }
    }
  }
}

export const upstageDocumentParseDistributedGate =
  new PostgresAdvisoryConcurrencyGate(db, {
    namespace:45_321,
    limit:effectiveDocumentParseConcurrency(Number.MAX_SAFE_INTEGER),
  });
