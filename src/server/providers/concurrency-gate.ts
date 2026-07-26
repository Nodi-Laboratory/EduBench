import { effectiveDocumentParseConcurrency } from '@/domain/document-parse-config';

type QueuedCaller = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  removeAbortListener: () => void;
};

export type RequestConcurrencyGate = {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

export class ConcurrencyGate implements RequestConcurrencyGate {
  private active = 0;
  private readonly queue: QueuedCaller[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('Concurrency gate limit must be a positive integer.');
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const caller: QueuedCaller = {
        resolve,
        reject,
        signal,
        removeAbortListener:() => undefined,
      };
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(caller);
          if (index >= 0) this.queue.splice(index, 1);
          caller.removeAbortListener();
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once:true });
        caller.removeAbortListener = () =>
          signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(caller);
    });
  }

  private release() {
    this.active -= 1;
    while (this.queue.length) {
      const caller = this.queue.shift()!;
      caller.removeAbortListener();
      if (caller.signal?.aborted) {
        caller.reject(caller.signal.reason);
        continue;
      }
      this.active += 1;
      caller.resolve();
      break;
    }
  }

  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.release();
    }
  }
}

export const upstageDocumentParseRequestGate = new ConcurrencyGate(
  effectiveDocumentParseConcurrency(Number.MAX_SAFE_INTEGER),
);
