import { spawn } from 'child_process';
import fs from 'fs';
import { soundpackCancelled, SoundpackProcessingError } from './soundpackWorkQueue';

function ffmpegExecutable(): string {
  const configured = process.env.COVE_FFMPEG_PATH?.trim();
  const bundled = require('ffmpeg-static') as string | null;
  const executable = configured || bundled?.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (!executable || !fs.existsSync(executable)) throw new Error('找不到 FFmpeg，无法处理语音包');
  return executable;
}

interface FfmpegRunnerOptions {
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  maxReportBytes?: number;
}

/** Resolves/rejects only on child close, including abort/timeout. Callers may then
 * safely remove output files and release the queue slot without a live writer. */
export function createSoundpackFfmpegRunner(options: FfmpegRunnerOptions = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  return async (args: string[], signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) throw soundpackCancelled();
    const executable = ffmpegExecutable();
    return new Promise<string>((resolve, reject) => {
      const child = spawnProcess(executable, [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
        '-threads', '1', '-filter_threads', '1', ...args,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let failure: Error | undefined;
      const chunks: Buffer[] = [];
      let reportBytes = 0;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        child.kill('SIGKILL');
      };
      const onAbort = () => stop(soundpackCancelled());
      const timer = setTimeout(() => stop(new SoundpackProcessingError(
        'SOUNDPACK_PROCESSING_TIMEOUT', '语音包处理超时，请选择较短的片段',
      )), options.timeoutMs ?? 30_000);
      child.stderr?.on('data', (chunk: Buffer) => {
        if (failure) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        reportBytes += bytes.length;
        if (reportBytes > (options.maxReportBytes ?? 256 * 1024)) {
          stop(new Error('语音包处理输出过多，请检查音频文件'));
          return;
        }
        chunks.push(bytes);
      });
      child.once('error', (error: Error) => {
        failure ??= new Error(`语音包无法解码或转码：${error.message}`);
      });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const report = Buffer.concat(chunks).toString('utf8');
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(
          `语音包无法解码或转码：${report.split(/\r?\n/).filter(Boolean).at(-1) || `FFmpeg exited (${code})`}`,
        ));
        else resolve(report);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
}

export const runSoundpackFfmpeg = createSoundpackFfmpegRunner();
