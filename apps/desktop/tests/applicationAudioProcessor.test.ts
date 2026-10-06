import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PcmChunkQueue } from '../electron/pcmChunkQueue';

const source = readFileSync(new URL('../src/features/media/application-audio/applicationAudioProcessor.js', import.meta.url), 'utf8');
function harness(rate = 48000) {
  let Processor: any;
  const messages: any[] = [];
  runInNewContext(source, { sampleRate: rate, Float32Array, DataView,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (value: any) => messages.push(value) }; },
    registerProcessor: (_: string, value: any) => { Processor = value; },
  });
  const processor = new Processor();
  const render = (frames = 128) => {
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    const alive = processor.process([], [channels]);
    return { left: channels[0], right: channels[1], alive };
  };
  const push = (frames: number, start = 0, fn = (i: number) => Math.sin(2 * Math.PI * 1125 * i / 48000) * 0.25) => {
    const data = new ArrayBuffer(frames * 4);
    const view = new DataView(data);
    for (let i = 0; i < frames; i++) {
      const value = Math.round(fn(start + i) * 32767);
      view.setInt16(i * 4, value, true); view.setInt16(i * 4 + 2, -value, true);
    }
    processor.port.onmessage({ data: { type: 'pcm', buffer: data, sequence: start } });
    return data;
  };
  return { processor, render, push, messages };
}

test('ring starts with 30 ms of capture and emits stereo silence before priming', () => {
  const h = harness();
  assert.equal(h.messages[0].type, 'ready');
  assert.ok(h.render().left.every(v => v === 0));
  h.push(960);
  assert.ok(h.render().left.every(v => v === 0));
  h.push(480, 960);
  assert.ok(h.render(256).left.some(v => v !== 0));
  assert.equal(h.processor.target, 1440);
});

test('48 kHz preserves PCM exactly after fade, across variable render quanta', () => {
  const h = harness();
  const data = h.push(5000);
  const view = new DataView(data);
  let offset = 0;
  for (const frames of [128, 64, 256, 128, 64, 256, 128]) {
    const out = h.render(frames);
    for (let i = 0; i < frames; i++) if (offset + i >= 240) {
      assert.equal(out.left[i], view.getInt16((offset + i) * 4, true) / 32768);
      assert.equal(out.right[i], -out.left[i] || 0);
    }
    offset += frames;
  }
  assert.equal(h.processor.underflows, 0);
});

test('stall fades to silence, raises water level, then resumes without hard DC edges', () => {
  const h = harness();
  h.push(1440, 0, () => 0.5);
  const samples: number[] = [];
  for (let i = 0; i < 16; i++) samples.push(...h.render().left);
  assert.equal(h.processor.underflows, 1);
  assert.equal(h.processor.target, 1920);
  assert.ok(samples.slice(-128).every(v => v === 0));
  h.push(1920, 0, () => -0.5);
  samples.push(...h.render(256).left);
  let step = 0;
  for (let i = 1; i < samples.length; i++) step = Math.max(step, Math.abs(samples[i] - samples[i - 1]));
  assert.ok(step < 0.003, `5 ms fade must avoid a pop: ${step}`);
});

test('overflow retains newest stereo frames and never exceeds 120 ms', () => {
  const h = harness();
  h.push(5760, 0, () => 0.5);
  h.render(256);
  h.push(48000, 0, i => i >= 48000 - 5760 ? -0.5 : 0.5);
  assert.equal(h.processor.count, h.processor.target + 480);
  assert.ok(h.processor.droppedFrames > 40000);
  const leftRing = h.processor.left;
  const out = h.render(512);
  assert.ok(out.left.slice(240).every(v => v < -0.49));
  assert.equal(h.processor.left, leftRing);
});

test('stable streaming preserves sample clock and sustained tone without repeated underflows', () => {
  const h = harness();
  let supplied = 1440;
  h.push(supplied);
  let rendered = 0;
  for (let quantum = 0; quantum < 48000 * 25 / 128; quantum++) {
    while (supplied < rendered + 1440) { h.push(480, supplied); supplied += 480; }
    const out = h.render();
    for (let i = 0; i < 128; i++) if (rendered + i > 240) {
      const expected = Math.round(Math.sin(2 * Math.PI * 1125 * (rendered + i) / 48000) * 0.25 * 32767) / 32768;
      assert.equal(out.left[i], expected || 0);
    }
    rendered += 128;
  }
  assert.equal(h.processor.underflows, 0);
  assert.equal(h.processor.droppedFrames, 0);
  assert.equal(h.processor.target, 960);
  // Lower target does not accelerate/repitch already-buffered music.
  assert.ok(h.processor.count <= 1440 + 480);
});

test('44.1 kHz context consumes the correct 48 kHz input clock without pitch shift', () => {
  const h = harness(44100);
  let supplied = 1440, rendered = 0;
  h.push(supplied);
  let zeroCrossings = 0, last = 0;
  for (let quantum = 0; quantum < 44100 * 4 / 128; quantum++) {
    while (supplied < rendered * 48000 / 44100 + 1440) { h.push(480, supplied); supplied += 480; }
    const out = h.render();
    for (const value of out.left) { if (last < 0 && value >= 0) zeroCrossings++; last = value; }
    rendered += 128;
  }
  assert.ok(Math.abs(zeroCrossings / (rendered / 44100) - 1125) < 1);
  assert.equal(h.processor.underflows, 0);
  assert.equal(h.processor.droppedFrames, 0);
});

test('close stops processor and suppresses new PCM and diagnostics', () => {
  const h = harness();
  h.push(1440); h.render();
  h.processor.port.onmessage({ data: { type: 'close' } });
  const count = h.messages.length;
  h.push(480);
  assert.equal(h.render().alive, false);
  assert.equal(h.processor.count, 0);
  assert.equal(h.messages.length, count);
});

test('pending queues own input, bound stale PCM and retain complete newest frames', () => {
  const q = new PcmChunkQueue(16);
  const input = new Uint8Array([1,1,1,1,2,2,2,2,3,3,3,3]);
  q.push(input); input.fill(9);
  q.push(new Uint8Array([4,4,4,4,5,5,5,5,8]));
  assert.equal(q.byteLength, 16);
  assert.equal(q.droppedFrames, 1);
  assert.deepEqual([...q.drain()!], [2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5]);
  assert.equal(q.drain(), null);
  q.clear(); assert.equal(q.droppedFrames, 0);
});
