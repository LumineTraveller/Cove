import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApplicationAudioPipeline } from '../src/features/media/application-audio/applicationAudio';

function audioHarness(t: TestContext) {
  const sources: any[] = [];
  const gains: any[] = [];
  const track = { stop: t.mock.fn() };
  const context = {
    currentTime: 0, sampleRate: 48_000, state: 'running',
    close: t.mock.fn(async () => {}),
    createGain() {
      const node = {
        gain: { value: 1, setValueAtTime: t.mock.fn(), linearRampToValueAtTime: t.mock.fn() },
        connect: t.mock.fn(), disconnect: t.mock.fn(),
      };
      gains.push(node);
      return node;
    },
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [track], getTracks: () => [track] } }),
    createBuffer(channels: number, frames: number, sampleRate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / sampleRate, length: frames, getChannelData: (channel: number) => data[channel] };
    },
    createBufferSource() {
      const node = {
        buffer: null as any, onended: null as null | (() => void),
        connect: t.mock.fn(), disconnect: t.mock.fn(), start: t.mock.fn(), stop: t.mock.fn(),
      };
      sources.push(node);
      return node;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { return context; } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  return { pipeline: new ApplicationAudioPipeline(0.7), context, sources, gains, track };
}

const pcm = (seconds = 0.04) => new Uint8Array(Math.round(48_000 * seconds) * 4);

function workletHarness(t: TestContext, ready = true) {
  const h = audioHarness(t);
  const nodes: any[] = [];
  const context = h.context as any;
  context.audioWorklet = { addModule: t.mock.fn(async () => {}) };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    port = { onmessage: null as any, postMessage: t.mock.fn(), close: t.mock.fn() };
    onprocessorerror: any = null;
    connect = t.mock.fn(() => { if (ready) queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } })); });
    disconnect = t.mock.fn();
    constructor() { nodes.push(this); }
  } });
  t.after(() => {
    h.pipeline.close();
    if (previous) Object.defineProperty(globalThis, 'AudioWorkletNode', previous);
    else Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
  });
  return { ...h, nodes };
}

test('worklet starts once, primes the same track and bounds MessagePort messages while ACK is delayed', async t => {
  const h = workletHarness(t);
  await Promise.all([h.pipeline.resume(), h.pipeline.resume()]);
  assert.equal(h.nodes.length, 1);
  assert.equal((h.context as any).audioWorklet.addModule.mock.callCount(), 1);
  h.pipeline.prime(); assert.equal(h.sources.length, 0);
  const input = pcm(0.01); input.fill(1);
  h.pipeline.pushPcm(input);
  assert.equal(input.byteLength, 1920, 'do not detach caller PCM');
  input.fill(9);
  const port = h.nodes[0].port;
  assert.equal(new Uint8Array(port.postMessage.mock.calls[0].arguments[0].buffer)[0], 1);
  for (let i = 0; i < 100; i++) h.pipeline.pushPcm(pcm(0.01));
  assert.equal(port.postMessage.mock.callCount(), 1);
  assert.equal(h.pipeline.diagnostics.pendingMs, 120);
  const sequence = port.postMessage.mock.calls[0].arguments[0].sequence;
  port.onmessage({ data: { type: 'accepted', sequence: sequence + 1 } });
  assert.equal(port.postMessage.mock.callCount(), 1);
  port.onmessage({ data: { type: 'accepted', sequence } });
  assert.equal(port.postMessage.mock.callCount(), 2);
  assert.equal(port.postMessage.mock.calls[1].arguments[0].buffer.byteLength, 23040);
  assert.equal(h.pipeline.gain.gain.value, 0.7);
});

test('closing while module loading prevents late worklet creation', async t => {
  const h = workletHarness(t);
  let loaded!: () => void;
  (h.context as any).audioWorklet.addModule = () => new Promise<void>(resolve => { loaded = resolve; });
  const pending = h.pipeline.resume();
  h.pipeline.close(); loaded(); await pending;
  assert.equal(h.nodes.length, 0);
  assert.equal(h.track.stop.mock.callCount(), 1);
});

test('closing while processor readiness is pending disconnects and closes its port once', async t => {
  const h = workletHarness(t, false);
  const pending = h.pipeline.resume();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.nodes.length, 1);
  h.pipeline.close(); await pending;
  assert.equal(h.nodes[0].disconnect.mock.callCount(), 1);
  assert.equal(h.nodes[0].port.close.mock.callCount(), 1);
  assert.equal(h.nodes[0].port.onmessage, null);
});

test('processor failure restores compatible audio without replacing track or user volume', async t => {
  const h = workletHarness(t);
  await h.pipeline.resume();
  const track = h.pipeline.track;
  h.pipeline.pushPcm(pcm());
  h.nodes[0].onprocessorerror();
  assert.equal(h.pipeline.diagnostics.mode, 'legacy');
  assert.equal(h.pipeline.track, track);
  h.pipeline.pushPcm(pcm());
  assert.equal(h.sources.length, 2, 'warmup plus compatible PCM source');
  assert.equal(h.pipeline.gain.gain.value, 0.7);
  assert.equal(h.nodes[0].disconnect.mock.callCount(), 1);
});

test('normal PCM scheduling preserves 80ms lead and does not cancel consecutive chunks', t => {
  const h = audioHarness(t);
  h.pipeline.pushPcm(pcm());
  h.context.currentTime = 0.04;
  h.pipeline.pushPcm(pcm());
  assert.equal(h.sources[0].start.mock.calls[0].arguments[0], 0.08);
  assert.equal(h.sources[1].start.mock.calls[0].arguments[0], 0.12);
  assert.ok(h.sources.every(source => source.stop.mock.callCount() === 0));
});

test('an overrun cancels the old scheduled sources before restarting the timeline', t => {
  const h = audioHarness(t);
  for (let i = 0; i < 9; i++) h.pipeline.pushPcm(pcm());
  const restarted = h.sources.findIndex((source, index) => index > 0 && source.start.mock.calls[0].arguments[0] === 0.08);
  assert.ok(restarted > 0);
  for (const source of h.sources.slice(0, restarted)) {
    assert.equal(source.stop.mock.callCount(), 1, 'rescheduling must cancel the real audio, not just nextStart');
    assert.equal(source.disconnect.mock.callCount(), 1);
  }
});

test('a large stale chunk keeps only its newest audio within the existing 350ms horizon', t => {
  const h = audioHarness(t);
  const chunk = pcm(1);
  new DataView(chunk.buffer).setInt16(chunk.byteLength - 4, 16384, true);
  h.pipeline.pushPcm(chunk);
  const source = h.sources[0];
  assert.ok(source.start.mock.calls[0].arguments[0] + source.buffer.duration <= 0.350001);
  assert.equal(source.buffer.getChannelData(0).at(-1), 0.5);
});

test('a late chunk fades interrupted playback and close also cleans the fading source', t => {
  const h = audioHarness(t);
  h.pipeline.pushPcm(pcm());
  h.context.currentTime = 0.10;
  h.pipeline.pushPcm(pcm());
  assert.deepEqual(h.sources[0].stop.mock.calls[0].arguments, [0.10500000000000001]);
  assert.deepEqual(h.gains[1].gain.linearRampToValueAtTime.mock.calls[0].arguments, [0, 0.10500000000000001]);
  assert.equal(h.sources[0].disconnect.mock.callCount(), 0, 'allow the 5ms fade to finish');
  assert.equal(h.sources[1].start.mock.calls[0].arguments[0], 0.18);
  assert.equal(h.pipeline.gain.gain.value, 0.7);
  h.pipeline.close();
  assert.equal(h.sources[0].disconnect.mock.callCount(), 1);
  assert.equal(h.sources[1].disconnect.mock.callCount(), 1);
});

test('ended and closed sources are disconnected, including warmup, without changing volume', t => {
  const h = audioHarness(t);
  h.pipeline.prime();
  h.pipeline.pushPcm(pcm());
  assert.equal(h.sources[0].stop.mock.callCount(), 0, 'PCM startup must not remove the SSRC warmup');
  assert.equal(h.pipeline.gain.gain.value, 0.7);
  h.sources[1].onended?.();
  assert.equal(h.sources[1].disconnect.mock.callCount(), 1);
  h.pipeline.close();
  h.pipeline.close();
  assert.equal(h.sources[0].stop.mock.callCount(), 1);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.context.close.mock.callCount(), 1);
  h.pipeline.pushPcm(pcm());
  assert.equal(h.sources.length, 2);
});
