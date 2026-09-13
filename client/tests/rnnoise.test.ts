import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { acquireMicrophoneCandidate } from '../src/microphoneCandidate';
import { createMicrophoneConstraints } from '../src/audioDevices';
import type { ProcessedMicrophone } from '../src/microphoneProcessing';

test('experimental capture disables native NS but retains AEC/AGC and device identity', () => {
  const system = createMicrophoneConstraints('usb');
  assert.equal(system.noiseSuppression, true);
  assert.deepEqual(createMicrophoneConstraints('usb', 'rnnoise'), { ...system, noiseSuppression: { exact: false } });
});

function stream(ns: boolean) {
  let stopped = false;
  const track = { readyState: 'live', getSettings: () => ({ noiseSuppression: ns, echoCancellation: 'all' }), stop() { stopped = true; } };
  return { value: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, stopped: () => stopped, track };
}
const processed = (raw: MediaStream): ProcessedMicrophone => ({ stream: raw, context: null, gain: null });

test('system default does not load the RNNoise path', async () => {
  const raw = stream(true);
  const candidate = await acquireMicrophoneCandidate('system', async (mode) => {
    assert.equal(mode, 'system'); return raw.value;
  }, async (raw, mode) => { assert.equal(mode, 'system'); return processed(raw); });
  assert.equal(candidate.mode, 'system');
  assert.equal(candidate.warning, null);
});

test('working RNNoise candidate stays experimental and returns its processed stream', async () => {
  const raw = stream(false), output = stream(false);
  const candidate = await acquireMicrophoneCandidate('rnnoise', async () => raw.value, async () => processed(output.value));
  assert.equal(candidate.mode, 'rnnoise');
  assert.equal(candidate.processed.stream, output.value);
  assert.equal(raw.stopped(), false);
});

for (const failure of ['capture', 'processor', 'double-ns', 'ended']) {
  test(`RNNoise ${failure} failure reacquires native NS, never publishes the unprocessed experiment`, async () => {
    const raw = stream(failure === 'double-ns'), fallback = stream(true), output = stream(false);
    if (failure === 'ended') output.track.readyState = 'ended';
    const attempts: string[] = [];
    let closed = 0;
    const result = await acquireMicrophoneCandidate('rnnoise', async (mode) => {
      attempts.push(mode);
      if (mode === 'rnnoise' && failure === 'capture') throw Error('capture failed');
      return mode === 'system' ? fallback.value : raw.value;
    }, async (input, mode) => {
      if (mode === 'system') return processed(input);
      if (failure === 'processor') throw Error('processor failed');
      return { ...processed(output.value), context: { close: async () => { closed++; } } as AudioContext };
    });
    assert.deepEqual(attempts, ['rnnoise', 'system']);
    assert.equal(result.mode, 'system');
    assert.equal(result.raw, fallback.value);
    assert.equal(result.processed.stream, fallback.value);
    assert.match(result.warning!, /已回退到系统降噪/);
    assert.equal(raw.stopped(), failure !== 'capture');
    assert.equal(fallback.stopped(), false);
    assert.equal(closed, failure === 'ended' ? 1 : 0);
  });
}

test('if both modes fail, the caller receives an error and may retain its existing producer', async () => {
  const raw = stream(false), fallback = stream(true);
  await assert.rejects(acquireMicrophoneCandidate('rnnoise', async (mode) => mode === 'rnnoise' ? raw.value : fallback.value,
    async () => { throw Error('unavailable'); }), /unavailable/);
  assert.equal(raw.stopped(), true);
  assert.equal(fallback.stopped(), true);
});

test('RNNoise frame bridge preserves every sample and constant delay across quantum boundaries', async () => {
  let Processor: any;
  const heap = new Float32Array(4096);
  const messages: unknown[] = [];
  let frames = 0, frees = 0;
  const module = {
    HEAPF32: heap, _malloc: () => 16, _rnnoise_create: () => 4,
    _rnnoise_process_frame(state: number, output: number, input: number) {
      assert.equal(state, 4); assert.equal(output, 16); assert.equal(input, 16);
      assert.ok(Math.max(...heap.subarray(4, 484)) > 1000, 'input uses 16-bit PCM scale');
      frames++;
    },
    _rnnoise_destroy() { frees++; }, _free() { frees++; },
  };
  const moduleOptions: { wasmBinary?: ArrayBuffer }[] = [];
  runInNewContext(readFileSync(new URL('../src/rnnoiseProcessor.js', import.meta.url), 'utf8'), {
    sampleRate: 48000,
    createRNNWasmModuleSync: (options: { wasmBinary?: ArrayBuffer }) => {
      moduleOptions.push(options);
      return module;
    },
    AudioWorkletProcessor: class { port = { onmessage: (_: unknown) => {}, postMessage: (data: unknown) => messages.push(data) }; },
    registerProcessor: (_: string, value: unknown) => { Processor = value; },
  });
  const p = new Processor();
  p.port.onmessage({ data: { type: 'wasm', wasmBinary: new ArrayBuffer(0) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(moduleOptions.length, 1);
  assert.ok(moduleOptions[0].wasmBinary instanceof ArrayBuffer);
  const input = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin(i * 0.137) * 0.2);
  const output = new Float32Array(input.length);
  let offset = 0;
  for (let block = 0; offset < input.length; block++) {
    const count = Math.min([128, 64, 256, 128][block % 4], input.length - offset);
    const first = new Float32Array(count), second = new Float32Array(count);
    assert.equal(p.process([[input.subarray(offset, offset + count)]], [[first, second]]), true);
    assert.deepEqual(second, first);
    output.set(first, offset);
    offset += count;
  }
  assert.ok(output.subarray(0, 480).every((x) => x === 0));
  assert.deepEqual(output.subarray(480), input.subarray(0, input.length - 480));
  assert.equal(frames, 100);
  assert.equal((messages[0] as { type: string }).type, 'ready');
  p.port.onmessage({ data: { type: 'dispose' } });
  p.port.onmessage({ data: { type: 'dispose' } });
  assert.equal(frees, 2);
  assert.equal(p.process([], [[new Float32Array(128)]]), false);
});
