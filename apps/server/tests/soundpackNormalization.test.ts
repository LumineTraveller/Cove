import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { measureSoundpack, normalizeSoundpack, soundpackGainDb } from '../src/features/soundpacks/soundpackNormalization';
import { createSoundpackFfmpegRunner } from '../src/features/soundpacks/soundpackFfmpeg';

const ffmpeg = require('ffmpeg-static') as string;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-soundpack-normalization-'));

test.after(() => {
  assert.equal(path.dirname(directory), os.tmpdir());
  fs.rmSync(directory, { recursive: true, force: true });
});

function tone(name: string, duration: number, gainDb = 0): string {
  const filename = path.join(directory, name);
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${duration}`,
    '-af', `volume=${gainDb}dB`, '-y', filename,
  ], { windowsHide: true });
  return filename;
}

test('equalizes different source levels while preserving originals', async () => {
  const loud = tone('loud.wav', 2);
  const quiet = tone('quiet.wav', 2, -6);
  const loudOriginal = fs.readFileSync(loud);
  const quietOriginal = fs.readFileSync(quiet);
  const loudOut = path.join(directory, 'loud.mp3');
  const quietOut = path.join(directory, 'quiet.mp3');

  await normalizeSoundpack(loud, loudOut);
  await normalizeSoundpack(quiet, quietOut);
  const loudMeasured = await measureSoundpack(loudOut);
  const quietMeasured = await measureSoundpack(quietOut);
  assert.ok(Math.abs(loudMeasured.loudness - quietMeasured.loudness) < 1.5);
  assert.ok(loudMeasured.truePeak <= -0.8);
  assert.ok(quietMeasured.truePeak <= -0.8);
  assert.deepEqual(fs.readFileSync(loud), loudOriginal);
  assert.deepEqual(fs.readFileSync(quiet), quietOriginal);
});

test('handles a clip shorter than the integrated-loudness window', async () => {
  const short = tone('short.wav', 0.15);
  const output = path.join(directory, 'short.mp3');
  const levels = await normalizeSoundpack(short, output);
  assert.ok(Number.isFinite(levels.gainDb));
  assert.ok(fs.statSync(output).size > 0);
});

test('rejects digital silence and caps extreme boosts', async () => {
  const silence = path.join(directory, 'silence.wav');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-y', silence,
  ], { windowsHide: true });
  await assert.rejects(normalizeSoundpack(silence, path.join(directory, 'silence.mp3')), /没有可用的声音/);
  assert.equal(soundpackGainDb({ loudness: -60, truePeak: -30, shortClip: false }), 10);
  assert.equal(soundpackGainDb({ loudness: -30, truePeak: -0.5, shortClip: false }), -0.5);
});

test('cancelling a real synthetic FFmpeg operation waits until its native child is closed', async () => {
  const source = tone('cancel-source.wav', 2);
  const original = fs.readFileSync(source);
  let child!: ChildProcess;
  const runner = createSoundpackFfmpegRunner({ spawnProcess: ((...args: Parameters<typeof spawn>) => {
    child = spawn(...args); return child;
  }) as typeof spawn });
  const controller = new AbortController();
  const result = runner(['-re', '-i', source, '-f', 'null', '-'], controller.signal);
  const cancelled = assert.rejects(result, (error: any) => error.code === 'SOUNDPACK_CANCELLED');
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await cancelled;
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Promise must not settle with a live child');
    assert.deepEqual(fs.readFileSync(source), original);
  } finally { clearTimeout(timer); }
});
