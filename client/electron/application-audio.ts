import { execFile } from 'child_process';
import { promisify } from 'util';
import { desktopCapturer, type WebContents } from 'electron';

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
}

interface ProcessWindow {
  processId: number;
  processName: string;
  windowHandle: number;
}

function windowHandleFromSourceId(sourceId: string): number | null {
  const match = /^window:(\d+):/.exec(sourceId);
  if (!match) return null;
  const handle = Number(match[1]);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

async function visibleProcessWindows(handles: number[]): Promise<ProcessWindow[]> {
  if (!handles.length) return [];
  // Handles are parsed from Electron's own DesktopCapturer IDs and kept numeric,
  // so embedding them into this no-profile PowerShell query cannot inject code.
  const script = [
    `$handles = @(${handles.join(',')})`,
    'Get-Process | ForEach-Object {',
    '  if ($handles -contains $_.MainWindowHandle.ToInt64()) {',
    '    [PSCustomObject]@{ processId = $_.Id; processName = $_.ProcessName; windowHandle = $_.MainWindowHandle.ToInt64() }',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 });
    if (!stdout.trim()) return [];
    const parsed: unknown = JSON.parse(stdout);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((value): ProcessWindow[] => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      const processId = Number(record.processId);
      const windowHandle = Number(record.windowHandle);
      const processName = typeof record.processName === 'string' ? record.processName : '';
      return Number.isInteger(processId) && processId > 0 && Number.isSafeInteger(windowHandle) && processName
        ? [{ processId, processName, windowHandle }]
        : [];
    });
  } catch (error) {
    console.warn('[application-audio] 无法读取窗口所属进程', error);
    return [];
  }
}

export async function listApplicationAudioSources(): Promise<ApplicationAudioSource[]> {
  if (process.platform !== 'win32') return [];
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const handles = sources.map(source => windowHandleFromSourceId(source.id)).filter((value): value is number => value !== null);
  const processes = await visibleProcessWindows(handles);
  const processByHandle = new Map(processes.map(process => [process.windowHandle, process]));
  const seen = new Set<number>();
  return sources.flatMap(source => {
    const handle = windowHandleFromSourceId(source.id);
    const process = handle === null ? undefined : processByHandle.get(handle);
    // A process tree is the capture unit. Showing one entry per process avoids
    // duplicate browser/game windows producing the same audio twice.
    if (!process || seen.has(process.processId)) return [];
    seen.add(process.processId);
    return [{ id: source.id, name: source.name, processId: process.processId, processName: process.processName }];
  });
}

export class ApplicationAudioCaptureController {
  private capture: LoopbackCapture | null = null;
  private owner: WebContents | null = null;
  private queued: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  start(owner: WebContents, source: ApplicationAudioSource) {
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
      capture.start(source.processId, true, chunk => {
        if (this.capture !== capture || !Buffer.isBuffer(chunk) || !chunk.length) return;
        this.queued.push(chunk);
      });
    } catch (error) {
      this.stop();
      throw error;
    }
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
    owner.send('cove:application-audio:chunk', new Uint8Array(chunk));
  }
}
