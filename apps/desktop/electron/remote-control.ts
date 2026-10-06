import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { RemoteInputQueue } from './remote-input-queue';

export type { RemoteControlActivation } from './remote-control-activation';

export type RemoteControlInput =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'button'; button: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number; x: number; y: number }
  | { type: 'key'; code: string; down: boolean };

const finiteUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const safeKey = /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;

export function isRemoteControlInput(value: unknown): value is RemoteControlInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.type === 'pointer') return finiteUnit(input.x) && finiteUnit(input.y);
  if (input.type === 'button') return (input.button === 'left' || input.button === 'right' || input.button === 'middle')
    && typeof input.down === 'boolean' && finiteUnit(input.x) && finiteUnit(input.y);
  if (input.type === 'wheel') return typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) && Math.abs(input.deltaX) <= 1200
    && typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) && Math.abs(input.deltaY) <= 1200
    && finiteUnit(input.x) && finiteUnit(input.y);
  return input.type === 'key' && typeof input.code === 'string' && safeKey.test(input.code) && typeof input.down === 'boolean';
}

export class RemoteInputController {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private queue: RemoteInputQueue | null = null;
  private readiness: Promise<boolean> | null = null;
  private resolveReadiness: ((ready: boolean) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped: Promise<void> = Promise.resolve();

  constructor(private readonly onFailure: (reason: string) => void = () => {}) {}

  get supported(): boolean { return process.platform === 'win32'; }

  setActive(sessionId: string | null): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    if (!sessionId) { this.stop(); return Promise.resolve(true); }
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) return Promise.resolve(false);
    if (sessionId === this.sessionId && this.readiness) return this.readiness;
    this.stop();
    const previousStopped = this.stopped;
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, 'remote-input-helper.exe')
      : path.join(app.getAppPath(), 'build', 'remote-input-helper.exe');
    if (!fs.existsSync(executable)) return Promise.resolve(false);
    try {
      const helper = spawn(executable, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.helper = helper;
      this.sessionId = sessionId;
      const readiness = new Promise<boolean>(resolve => { this.resolveReadiness = resolve; });
      this.readiness = readiness;
      this.queue = new RemoteInputQueue(helper.stdin, reason => this.fail(helper, reason));
      // Keep an error listener after the queue is closed; late EPIPE must not
      // crash Electron or restart a helper whose authorization was revoked.
      helper.stdin.on('error', () => this.fail(helper, '远程输入管道已关闭'));
      helper.on('exit', () => this.fail(helper, '远程输入组件已退出，控制已终止'));
      helper.on('error', () => this.fail(helper, '远程输入组件启动失败'));
      helper.stderr.resume();
      let output = '';
      helper.stdout.on('data', (chunk: Buffer) => {
        if (this.helper !== helper) return;
        output += chunk.toString('utf8');
        if (output.length > 4096) { this.fail(helper, '远程输入组件响应无效'); return; }
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { ready?: boolean; seq?: number; error?: boolean };
            if (message.error) { this.fail(helper, '远程输入执行失败，控制已终止'); return; }
            if (message.ready && this.resolveReadiness) {
              // The old helper's ReleaseAll must finish before a new helper
              // injects a press, otherwise that old release can undo the press.
              void previousStopped.then(() => {
                if (this.helper !== helper || !this.resolveReadiness) return;
                if (this.readyTimer !== null) clearTimeout(this.readyTimer);
                this.readyTimer = null;
                this.queue?.markReady();
                this.resolveReadiness?.(this.helper === helper);
                this.resolveReadiness = null;
              });
            } else if (typeof message.seq === 'number') this.queue?.acknowledge(message.seq);
          } catch {
            this.fail(helper, '远程输入组件响应无效');
            return;
          }
        }
      });
      this.readyTimer = setTimeout(() => this.fail(helper, '远程输入组件未就绪，控制已终止'), 2000);
      return readiness;
    } catch {
      this.stop();
      return Promise.resolve(false);
    }
  }

  send(sessionId: string, input: RemoteControlInput): boolean {
    if (!this.supported || sessionId !== this.sessionId || !isRemoteControlInput(input)) return false;
    // true means accepted by the bounded local queue, not Windows injection success.
    return this.queue?.enqueue(input) ?? false;
  }

  stop() {
    this.sessionId = null;
    this.resolveReadiness?.(false);
    this.resolveReadiness = null;
    this.readiness = null;
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.queue?.close();
    this.queue = null;
    if (!this.helper) return;
    const helper = this.helper;
    this.helper = null;
    const closed = new Promise<void>(resolve => helper.once('close', () => resolve()));
    this.stopped = Promise.all([this.stopped, closed]).then(() => {});
    // At most the already executing command precedes this stop. Pending moves
    // and edges were discarded above; the helper releases held input in finally.
    try { helper.stdin.end('{"type":"stop"}\n'); } catch { }
    setTimeout(() => { if (helper.exitCode === null && !helper.killed) helper.kill(); }, 500).unref();
  }

  private fail(helper: ChildProcessWithoutNullStreams, reason: string) {
    if (this.helper !== helper) return;
    this.stop();
    this.onFailure(reason);
  }
}
