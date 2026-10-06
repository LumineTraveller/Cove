import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const TARGET_LUFS = -18;
const TARGET_RMS_DBFS = -20;
const MAX_TRUE_PEAK_DBTP = -1;
const MAX_BOOST_DB = 10;

export interface SoundpackLevels {
  loudness: number;
  truePeak: number;
  shortClip: boolean;
}

/** Keep a large transient or a near-silent recording from forcing unsafe gain. */
export function soundpackGainDb(levels: SoundpackLevels): number {
  const target = levels.shortClip ? TARGET_RMS_DBFS : TARGET_LUFS;
  return Math.min(target - levels.loudness, MAX_TRUE_PEAK_DBTP - levels.truePeak, MAX_BOOST_DB);
}

function ffmpegExecutable(): string {
  const configured = process.env.COVE_FFMPEG_PATH?.trim();
  const bundled = require('ffmpeg-static') as string | null;
  const executable =
    configured || bundled?.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (!executable || !fs.existsSync(executable)) throw new Error('找不到 FFmpeg，无法处理语音包');
  return executable;
}

async function runFfmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync(
      ffmpegExecutable(),
      ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', ...args],
      { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    return stderr;
  } catch (cause) {
    const error = cause as Error & { stderr?: string; killed?: boolean };
    if (error.killed) throw new Error('语音包处理超时，请选择较短的片段');
    throw new Error(
      `语音包无法解码或处理：${
        error.stderr?.split(/\r?\n/).filter(Boolean).at(-1) || error.message
      }`,
    );
  }
}

function lastLevel(log: string, label: string): number {
  const values = [...log.matchAll(new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?|-inf)`, 'g'))];
  return Number(values.at(-1)?.[1]);
}

export async function measureSoundpack(source: string): Promise<SoundpackLevels> {
  const report = await runFfmpeg([
    '-i',
    source,
    '-map',
    '0:a:0',
    '-af',
    'loudnorm=I=-18:TP=-1:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const match = report.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error('无法测量语音包响度');
  const levels = JSON.parse(match[0]) as { input_i: string; input_tp: string };
  const loudness = Number(levels.input_i);
  const truePeak = Number(levels.input_tp);
  if (Number.isFinite(loudness) && Number.isFinite(truePeak))
    return { loudness, truePeak, shortClip: false };

  // Integrated LUFS is undefined for very short clips. Use their whole-clip RMS
  // instead of incorrectly treating a short sound effect as digital silence.
  const shortReport = await runFfmpeg([
    '-i',
    source,
    '-map',
    '0:a:0',
    '-af',
    'astats=metadata=0:reset=0',
    '-f',
    'null',
    '-',
  ]);
  const rms = lastLevel(shortReport, 'RMS level dB');
  const peak = lastLevel(shortReport, 'Peak level dB');
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) throw new Error('语音包没有可用的声音');
  return { loudness: rms, truePeak: peak, shortClip: true };
}

/** Decode once for measurement and write a universally playable MP3 copy. */
export async function normalizeSoundpack(
  source: string,
  destination: string,
): Promise<SoundpackLevels & { gainDb: number }> {
  const levels = await measureSoundpack(source);
  const gainDb = soundpackGainDb(levels);
  await runFfmpeg([
    '-y',
    '-i',
    source,
    '-map',
    '0:a:0',
    '-map_metadata',
    '-1',
    '-af',
    `volume=${gainDb.toFixed(3)}dB,alimiter=limit=0.89125:level=false`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-f',
    'mp3',
    destination,
  ]);
  return { ...levels, gainDb };
}
