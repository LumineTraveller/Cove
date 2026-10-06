import type { Writable } from 'node:stream';
import type { RemoteControlInput } from './remote-control';

export const MAX_PENDING_INPUTS = 64;
export const MAX_INPUT_AGE_MS = 500;

/**
 * Keep only one command inside the OS pipe until the helper consumes it. The
 * renderer/network never awaits this acknowledgement; it is local pipe flow
 * control, so stop can discard the application queue instead of draining it.
 */
export class RemoteInputQueue {
  private pending: { input: RemoteControlInput; at: number }[] = [];
  private sequence = 0;
  private inFlight: number | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private blocked = false;
  private closed = false;

  constructor(
    private readonly writer: Pick<Writable, 'write' | 'on' | 'off' | 'writableLength'>,
    private readonly onFailure: (reason: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    writer.on('drain', this.onDrain);
    writer.on('error', this.onError);
  }

  markReady() {
    this.ready = true;
    this.pump();
  }

  enqueue(input: RemoteControlInput): boolean {
    if (this.closed) return false;
    const last = this.pending[this.pending.length - 1];
    if (input.type === 'pointer' && last?.input.type === 'pointer') {
      last.input = input;
      last.at = this.now();
    } else {
      if (this.pending.length >= MAX_PENDING_INPUTS) {
        this.fail('远程输入队列已满，已安全停止控制');
        return false;
      }
      this.pending.push({ input, at: this.now() });
    }
    this.pump();
    return !this.closed;
  }

  acknowledge(sequence: number) {
    if (this.closed || this.inFlight !== sequence) return;
    this.inFlight = null;
    if (!this.blocked) this.clearTimeout();
    this.pump();
  }

  private readonly onDrain = () => {
    this.blocked = false;
    if (this.inFlight === null) this.clearTimeout();
    this.pump();
  };

  private readonly onError = () => this.fail('远程输入管道已断开，已停止控制');

  private pump() {
    if (this.closed || !this.ready || this.blocked || this.inFlight !== null) return;
    let next = this.pending.shift();
    while (next && this.now() - next.at > MAX_INPUT_AGE_MS) {
      if (next.input.type !== 'pointer') {
        this.fail('远程输入已过期，已释放按键并停止控制');
        return;
      }
      next = this.pending.shift();
    }
    if (!next) return;
    if (this.writer.writableLength > 4096) {
      this.fail('远程输入管道积压，已停止控制');
      return;
    }
    const sequence = ++this.sequence;
    this.inFlight = sequence;
    this.timeout = setTimeout(() => this.fail('远程输入组件未响应，已停止控制'), MAX_INPUT_AGE_MS);
    try {
      // write(false) has accepted this command. Never enqueue or send it again.
      this.blocked = !this.writer.write(`${JSON.stringify({ ...next.input, seq: sequence })}\n`);
    } catch {
      this.fail('远程输入管道写入失败，已停止控制');
    }
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.close();
    this.onFailure(reason);
  }

  private clearTimeout() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.inFlight = null;
    this.clearTimeout();
    this.writer.off('drain', this.onDrain);
    this.writer.off('error', this.onError);
  }
}
