import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PCM_FRAME_BYTES, SCREEN_PCM_QUEUE_FRAMES } from './pcmChunkQueue';

const greeting = Buffer.from('COVEPCM1');
const headerBytes = 16;

export class ScreenPcmReader {
  private pending: Buffer = Buffer.alloc(0);
  private expectedPosition: bigint | null = null;
  private started = false;

  constructor(
    private readonly ready: () => void,
    private readonly onPcm: (pcm: Uint8Array) => void,
    private readonly onSilence: (frames: number) => void,
  ) {}

  write(chunk: Buffer) {
    const bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    if (!this.started) {
      if (bytes.length < greeting.length) {
        this.pending = bytes;
        return;
      }
      if (!bytes.subarray(0, greeting.length).equals(greeting)) throw new Error('无效的 Windows 屏幕音频响应');
      offset = greeting.length;
      this.started = true;
      this.ready();
    }
    while (bytes.length - offset >= headerBytes) {
      const position = bytes.readBigUInt64LE(offset);
      const frames = bytes.readUInt32LE(offset + 8);
      const size = bytes.readUInt32LE(offset + 12);
      if (!frames || frames > SCREEN_PCM_QUEUE_FRAMES || (size !== 0 && size !== frames * PCM_FRAME_BYTES))
        throw new Error('无效的 Windows 屏幕音频数据');
      const end = offset + headerBytes + size;
      if (end > bytes.length) break;

      if (this.expectedPosition !== null) {
        const gap = position - this.expectedPosition;
        if (gap < 0n) throw new Error('Windows 屏幕音频采样位置回退');
        // The output queue bounds very long gaps. Small gaps keep their exact
        // duration even if the native helper had to discard an old packet.
        if (gap > 0n) this.onSilence(gap > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(gap));
      }
      if (size) this.onPcm(bytes.subarray(offset + headerBytes, end));
      else this.onSilence(frames);
      this.expectedPosition = position + BigInt(frames);
      offset = end;
    }
    this.pending = bytes.subarray(offset);
  }
}

export class WindowsScreenAudioCapture {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelStart: ((error: Error) => void) | null = null;

  constructor(private readonly executable: string) {}

  start(
    processId: number,
    onPcm: (pcm: Uint8Array) => void,
    onSilence: (frames: number) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    this.stop();
    const child = spawn(this.executable, [String(processId), 'exclude'], { windowsHide: true });
    this.child = child;
    return new Promise((resolve, reject) => {
      let stderr = '';
      const fail = (error: Error) => {
        if (this.child !== child) return;
        const cancelStart = this.cancelStart;
        cancelStart?.(error);
        this.stop();
        if (!cancelStart) onError(error);
      };
      const timeout = setTimeout(() => fail(new Error('Windows 屏幕音频采集启动超时')), 5_000);
      this.cancelStart = error => {
        this.cancelStart = null;
        clearTimeout(timeout);
        reject(error);
      };
      const reader = new ScreenPcmReader(() => {
        this.cancelStart = null;
        clearTimeout(timeout);
        resolve();
      }, onPcm, onSilence);

      child.stdin.on('error', () => {});
      child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-1024); });
      child.once('error', fail);
      child.once('close', () => fail(new Error(stderr.trim() || 'Windows 屏幕音频采集已退出')));
      child.stdout.on('error', fail);
      child.stdout.on('data', (bytes: Buffer) => {
        if (this.child !== child) return;
        try { reader.write(bytes); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.cancelStart?.(new Error('Windows 屏幕音频采集已取消'));
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill(), 1_000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}
