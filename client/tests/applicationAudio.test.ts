import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApplicationAudioPipeline } from '../src/applicationAudio';

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
