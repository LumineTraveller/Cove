export type SoundpackProcessingCode =
  | 'SOUNDPACK_QUEUE_FULL' | 'SOUNDPACK_QUEUE_TIMEOUT'
  | 'SOUNDPACK_PROCESSING_TIMEOUT' | 'SOUNDPACK_CANCELLED';

export class SoundpackProcessingError extends Error {
  constructor(readonly code: SoundpackProcessingCode, message: string) {
    super(message);
    this.name = 'SoundpackProcessingError';
  }
}

export const soundpackCancelled = () =>
  new SoundpackProcessingError('SOUNDPACK_CANCELLED', '语音包处理已取消');

interface QueueOptions {
  concurrency?: number;
  maxQueued?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
}

/** A slot owns the entire measure/encode operation, including cancellation cleanup.
 * Aborting a running task does not release its slot until its worker settles. */
export class SoundpackWorkQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;

  constructor(options: QueueOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.maxQueued = options.maxQueued ?? 16;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    for (const value of [this.concurrency, this.maxWaitMs, this.timeoutMs])
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Queue limits must be positive integers');
    if (!Number.isSafeInteger(this.maxQueued) || this.maxQueued < 0)
      throw new RangeError('Queue capacity must be a non-negative integer');
  }

  run<T>(worker: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(soundpackCancelled());
    return new Promise<T>((resolve, reject) => {
      let state: 'queued' | 'running' | 'finished' = 'queued';
      let cancellation: SoundpackProcessingError | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const abort = (error: SoundpackProcessingError) => {
        if (state === 'finished' || cancellation) return;
        cancellation = error;
        if (state === 'running') {
          controller.abort();
          return;
        }
        state = 'finished';
        const index = this.waiting.indexOf(start);
        if (index !== -1) this.waiting.splice(index, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () => abort(soundpackCancelled());
      const finish = (failed: boolean, error: unknown, result?: T) => {
        state = 'finished';
        cleanup();
        this.active -= 1;
        this.drain();
        if (cancellation) reject(cancellation);
        else if (failed) reject(error);
        else resolve(result as T);
      };
      const start = () => {
        if (state !== 'queued') return;
        state = 'running';
        if (timer !== undefined) clearTimeout(timer);
        this.active += 1;
        timer = setTimeout(() => abort(new SoundpackProcessingError(
          'SOUNDPACK_PROCESSING_TIMEOUT', '语音包处理超时，请选择较短的片段',
        )), this.timeoutMs);
        Promise.resolve().then(() => {
          if (cancellation) throw cancellation;
          return worker(controller.signal);
        }).then(result => finish(false, undefined, result), error => finish(true, error));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (this.active < this.concurrency) start();
      else if (this.waiting.length >= this.maxQueued) {
        state = 'finished';
        cleanup();
        reject(new SoundpackProcessingError('SOUNDPACK_QUEUE_FULL', '语音包处理繁忙，请稍后重试（等待队列已满）'));
      } else {
        this.waiting.push(start);
        timer = setTimeout(() => abort(new SoundpackProcessingError(
          'SOUNDPACK_QUEUE_TIMEOUT', '语音包等待处理超时，请稍后重试',
        )), this.maxWaitMs);
      }
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) this.waiting.shift()!();
  }
}

/** Shared by uploads, background normalization and direct measurements. */
export const soundpackWorkQueue = new SoundpackWorkQueue();
