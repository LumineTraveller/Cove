import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import { app, type WebContents } from 'electron';

const execFileAsync = promisify(execFile);

interface LoopbackCapture {
  start(processId: number, includeProcessTree: boolean, callback: (chunk: Buffer) => void): void;
  stop(): void;
}

interface LoopbackCaptureModule {
  LoopbackCapture: new () => LoopbackCapture;
}

export interface ApplicationAudioSource {
  id: string;
  name: string;
  processId: number;
  processName: string;
  /** Windows app icon encoded as a data URL for renderer-safe display. */
  iconDataUrl?: string;
}

// The creation timestamp prevents a stale selection from targeting a different
// application after Windows recycles its PID. IDs never depend on window state.
const sourceIdPattern = /^process:([1-9]\d{0,9}):([1-9]\d{0,18})$/;

function readSource(value: unknown): ApplicationAudioSource | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const match = typeof record.id === 'string' ? sourceIdPattern.exec(record.id) : null;
  if (!match || !Number.isSafeInteger(record.processId) || record.processId !== Number(match[1])
    || typeof record.processName !== 'string' || !record.processName
    || typeof record.name !== 'string' || !record.name) return null;
  return {
    id: record.id as string, name: record.name,
    processId: record.processId as number, processName: record.processName,
    ...(typeof record.iconDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(record.iconDataUrl)
      ? { iconDataUrl: record.iconDataUrl } : {}),
  };
}

async function querySources(command: 'list' | 'resolve', sourceId?: string): Promise<unknown> {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'application-audio-helper.exe')
    : path.resolve(__dirname, '..', 'build', 'application-audio-helper.exe');
  const { stdout, stderr } = await execFileAsync(executable,
    [command, String(process.pid), ...(sourceId ? [sourceId] : [])],
    { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  if (stderr.trim()) console.warn('[application-audio] 枚举诊断:', stderr.trim());
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

export async function listApplicationAudioSources(): Promise<ApplicationAudioSource[]> {
  if (process.platform !== 'win32') return [];
  // Core Audio sessions include tray/background players. EnumWindows adds
  // ordinary apps (including minimized windows) even before playback starts.
  const records = await querySources('list');
  if (!Array.isArray(records)) throw new Error('应用音频列表响应无效。');
  const sources: ApplicationAudioSource[] = [];
  const seen = new Set<number>();
  for (const record of records) {
    const source = readSource(record);
    if (!source || seen.has(source.processId) || source.processId === process.pid) continue;
    seen.add(source.processId);
    sources.push(source);
  }
  return sources;
}

export async function resolveApplicationAudioSource(sourceId: string): Promise<ApplicationAudioSource | null> {
  if (process.platform !== 'win32' || !sourceIdPattern.test(sourceId)) return null;
  // Do not re-enumerate windows or sessions: hiding a window, pausing playback,
  // or moving it to the tray after selection must not prevent capture startup.
  const source = readSource(await querySources('resolve', sourceId));
  return source?.id === sourceId && source.processId !== process.pid ? source : null;
}

export class ApplicationAudioCaptureController {
  constructor(private readonly chunkChannel = 'cove:application-audio:chunk') {}

  private capture: LoopbackCapture | null = null;
  private owner: WebContents | null = null;
  private queued: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  private startCapture(
    owner: WebContents,
    start: (capture: LoopbackCapture, onChunk: (chunk: Buffer) => void) => void,
  ) {
    this.stop();
    if (process.platform !== 'win32') throw new Error('应用音频共享目前仅支持 Windows。');
    // N-API keeps this binary ABI-stable across Node and Electron releases.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require('loopback-capture') as LoopbackCaptureModule;
    const capture = new addon.LoopbackCapture();
    this.capture = capture;
    this.owner = owner;
    this.flushTimer = setInterval(() => this.flush(), 40);
    try {
      start(capture, chunk => {
        if (this.capture !== capture || !Buffer.isBuffer(chunk) || !chunk.length) return;
        this.queued.push(chunk);
      });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  start(owner: WebContents, source: ApplicationAudioSource) {
    this.startCapture(owner, (capture, onChunk) => {
      // Include the selected process tree so child processes (for example a
      // browser's GPU/audio process) are captured as part of the application.
      capture.start(source.processId, true, onChunk);
    });
  }

  /**
   * Capture desktop audio while excluding Cove's process tree. Windows'
   * process-loopback API supports this mode natively; unlike Electron's
   * global `loopback` source it cannot feed Cove's own voice/chat playback
   * back into a screen-share audio track.
   */
  startExcludingProcess(owner: WebContents, processId: number) {
    if (!Number.isSafeInteger(processId) || processId <= 0)
      throw new Error('无效的 Cove 进程标识。');
    this.startCapture(owner, (capture, onChunk) => {
      capture.start(processId, false, onChunk);
    });
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.queued = [];
    const capture = this.capture;
    this.capture = null;
    this.owner = null;
    if (capture) {
      try { capture.stop(); } catch (error) { console.warn('[application-audio] 停止捕获失败', error); }
    }
  }

  private flush() {
    const owner = this.owner;
    if (!owner || owner.isDestroyed() || !this.queued.length) return;
    const chunk = this.queued.length === 1 ? this.queued[0] : Buffer.concat(this.queued);
    this.queued = [];
    // The addon produces signed 16-bit PCM, 48 kHz, stereo. Electron IPC
    // structured-clones the Uint8Array; no filesystem or external process data
    // is exposed to the renderer.
    owner.send(this.chunkChannel, new Uint8Array(chunk));
  }
}
