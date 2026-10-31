export type NativeFrameWriteResult = 'written' | 'superseded' | 'expired' | 'stopped';
export type NativeFrameDropReason = 'superseded' | 'expired';

export interface NativeFrameWriteQueueOptions<T> {
  write(frame: T): Promise<void>;
  now(): number;
  maxPendingAgeMs: number;
  onWritten?(durationMs: number, queueAgeMs: number): void;
  onDropped?(reason: NativeFrameDropReason): void;
  onFailure?(error: unknown): void;
}

interface Entry<T> {
  frame: T;
  queuedAt: number;
  resolve(result: NativeFrameWriteResult): void;
}

/**
 * Runs one write and retains only the newest waiting frame. A settled submit()
 * lets the caller close its own VideoFrame; this queue never closes frames or
 * authorizes GPU texture reuse. The preload permit and allReferencesReleased
 * barriers continue to own slot credits, including after stop().
 */
export function createNativeFrameWriteQueue<T>(options: NativeFrameWriteQueueOptions<T>) {
  if (!Number.isFinite(options.maxPendingAgeMs) || options.maxPendingAgeMs < 0)
    throw new RangeError('Invalid maximum pending frame age');

  let active: Entry<T> | undefined;
  let pending: Entry<T> | undefined;
  let stopped = false;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    active?.resolve('stopped');
    pending?.resolve('stopped');
    active = pending = undefined;
  }

  function fail(error: unknown): void {
    if (stopped) return;
    stop();
    // A diagnostic/error handler cannot leave any submit promise unsettled.
    try { options.onFailure?.(error); } catch { /* The queue is already stopped. */ }
  }

  function dropped(entry: Entry<T>, reason: NativeFrameDropReason): void {
    entry.resolve(reason);
    try { options.onDropped?.(reason); } catch (error) { fail(error); }
  }

  function drain(): void {
    if (stopped || active || !pending) return;
    const next = pending;
    pending = undefined;
    const age = Math.max(0, options.now() - next.queuedAt);
    if (age > options.maxPendingAgeMs) {
      dropped(next, 'expired');
      // onDropped may synchronously submit a new frame or stop the queue.
      drain();
      return;
    }
    start(next, age);
  }

  function start(entry: Entry<T>, queueAgeMs: number): void {
    active = entry;
    const startedAt = options.now();
    let write: Promise<void>;
    try { write = options.write(entry.frame); }
    catch (error) { fail(error); return; }
    // Always attach both reactions, even if stop() wins first. A late writer
    // rejection must neither revive this queue nor become unhandled.
    void Promise.resolve(write).then(() => {
      if (stopped || active !== entry) return;
      entry.resolve('written');
      try { options.onWritten?.(Math.max(0, options.now() - startedAt), queueAgeMs); }
      catch (error) { fail(error); return; }
      // Keep active set during onWritten so reentrant submit() stays bounded.
      if (stopped || active !== entry) return;
      active = undefined;
      drain();
    }, error => {
      if (!stopped && active === entry) fail(error);
    });
  }

  function submit(frame: T): Promise<NativeFrameWriteResult> {
    if (stopped) return Promise.resolve('stopped');
    let resolve!: Entry<T>['resolve'];
    const result = new Promise<NativeFrameWriteResult>(res => { resolve = res; });
    const entry: Entry<T> = { frame, queuedAt: options.now(), resolve };
    if (active) {
      const previous = pending;
      pending = entry;
      if (previous) dropped(previous, 'superseded');
    } else {
      start(entry, 0);
    }
    return result;
  }

  return { submit, stop };
}
