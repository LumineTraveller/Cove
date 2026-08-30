import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';

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

  get supported(): boolean { return process.platform === 'win32'; }

  setActive(sessionId: string | null): boolean {
    if (!this.supported) return false;
    if (!sessionId) { this.stop(); return true; }
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) return false;
    this.sessionId = sessionId;
    return this.ensureHelper();
  }

  send(sessionId: string, input: RemoteControlInput): boolean {
    if (!this.supported || !this.sessionId || sessionId !== this.sessionId || !isRemoteControlInput(input) || !this.ensureHelper()) return false;
    try { return this.helper!.stdin.write(`${JSON.stringify(input)}\n`); }
    catch { this.stop(); return false; }
  }

  stop() {
    this.sessionId = null;
    if (!this.helper) return;
    const helper = this.helper;
    this.helper = null;
    try { helper.stdin.end(); } catch { }
    setTimeout(() => { if (!helper.killed) helper.kill(); }, 500).unref();
  }

  private ensureHelper(): boolean {
    if (this.helper && !this.helper.killed) return true;
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, 'remote-input-helper.exe')
      : path.join(app.getAppPath(), 'build', 'remote-input-helper.exe');
    if (!fs.existsSync(executable)) return false;
    try {
      const helper = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      helper.on('exit', () => { if (this.helper === helper) this.helper = null; });
      helper.on('error', () => { if (this.helper === helper) this.helper = null; });
      this.helper = helper;
      return true;
    } catch { return false; }
  }
}
