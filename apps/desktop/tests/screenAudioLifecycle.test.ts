import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenAudio, type useScreenAudioDependencies } from '../src/features/media/screen/useScreenAudio';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const producer = (id: string) => ({ id, closed: false, closes: 0, pause() {}, close() { this.closed = true; this.closes++; } });

function fixture(t: TestContext) {
  let api!: ReturnType<typeof useScreenAudio>;
  t.after(() => api.closeScreenAudio());
  const replace = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  };
  const contexts: any[] = [], subscriptions: any[] = [], produced: any[] = [], events: any[] = [];
  let bridgeStarts = 0, bridgeStops = 0, sequence = 0;
  let capture = async () => ({ ok: true, error: undefined as string | undefined });
  let publish = async (_: any) => producer(`audio-${++sequence}`);
  let suspend: (() => Promise<void>) | null = null;
  const ref = () => ({ current: null as any });
  const mediaGeneration = { current: 0 }, screenAudioProducer = ref(), screenAudioPipeline = ref(), screenAudioUnsubscribe = ref();
  const sendTransport = { current: { produce: async (options: any) => { produced.push(options); return publish(options); } } as any };
  replace('AudioContext', class {
    constructor() {
      const resume = suspend;
      const track = { readyState: 'live', stops: 0, stop() { this.stops++; this.readyState = 'ended'; } };
      const gain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      const context = {
        state: resume ? 'suspended' : 'running', sampleRate: 48000, currentTime: 0, track, closes: 0,
        close: async () => { context.closes++; context.state = 'closed'; },
        resume: async () => { await resume?.(); if (context.state !== 'closed') context.state = 'running'; },
        createGain: gain,
        createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [track], getTracks: () => [track] } }),
        createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate }),
        createBufferSource: () => ({ buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} }),
      };
      contexts.push(context);
      return context;
    }
  });
  replace('window', { coveScreenAudio: {
    start: () => { bridgeStarts++; return capture(); },
    stop: async () => { bridgeStops++; return true; },
    onChunk: (listener: (data: Uint8Array) => void) => {
      const subscription = { listener, removals: 0 }; subscriptions.push(subscription);
      return () => { subscription.removals++; };
    },
  } });
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const deps = {
    mediaGeneration, screenAudioProducer, screenAudioPipeline, screenAudioUnsubscribe, sendTransport,
    socket: { id: 'desktop', connected: true, emit: (...args: any[]) => events.push(args) },
    screenShareVolumeRef: { current: 1 }, forceMutedRef: { current: false }, screenDemandActiveRef: { current: true },
  } as unknown as useScreenAudioDependencies;
  function Probe() { api = useScreenAudio(deps); return null; }
  renderToStaticMarkup(createElement(Probe));
  return { api, contexts, subscriptions, produced, events, mediaGeneration, sendTransport, screenAudioProducer, screenAudioPipeline,
    bridgeStarts: () => bridgeStarts, bridgeStops: () => bridgeStops,
    capture: (next: typeof capture) => { capture = next; }, publish: (next: typeof publish) => { publish = next; },
    suspend: (next: typeof suspend) => { suspend = next; } };
}

test('closing while native start ACK is pending cannot publish or restore its pipeline', async t => {
  const f = fixture(t), pending = deferred<{ ok: boolean; error: undefined }>();
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenAudio().catch(error => error);
  await settle();
  f.api.closeScreenAudio();
  pending.resolve({ ok: true, error: undefined });
  await oldStart;
  assert.equal(f.produced.length, 0);
  assert.equal(f.screenAudioProducer.current, null);
  assert.equal(f.screenAudioPipeline.current, null);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.subscriptions[0].removals, 1);
});

for (const ok of [true, false]) test(`old native start ${ok ? 'success' : 'failure'} cannot overwrite or stop a newer audio pipeline`, async t => {
  const f = fixture(t), pending = deferred<{ ok: boolean; error: string | undefined }>();
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenAudio().catch(error => error);
  await settle();
  f.api.closeScreenAudio();
  f.capture(async () => ({ ok: true, error: undefined }));
  await f.api.startScreenAudio();
  const currentProducer = f.screenAudioProducer.current, currentPipeline = f.screenAudioPipeline.current;
  const stops = f.bridgeStops();
  pending.resolve({ ok, error: ok ? undefined : 'old native failure' });
  await oldStart;
  assert.equal(f.produced.length, 1);
  assert.equal(f.screenAudioProducer.current, currentProducer);
  assert.equal(f.screenAudioPipeline.current, currentPipeline);
  assert.equal(currentProducer.closed, false);
  assert.equal(f.contexts[1].closes, 0);
  assert.equal(f.bridgeStops(), stops);
  assert.equal(f.contexts[0].closes, 1);
});

test('a producer returned after audio stop closes itself without replacing the newer producer', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof producer>>(), stale = producer('stale');
  f.publish(() => pending.promise);
  const oldStart = f.api.startScreenAudio().catch(error => error);
  await settle();
  assert.equal(f.produced.length, 1);
  f.api.closeScreenAudio();
  f.publish(async () => producer('current'));
  await f.api.startScreenAudio();
  const current = f.screenAudioProducer.current, stops = f.bridgeStops();
  pending.resolve(stale);
  await oldStart;
  assert.equal(stale.closed, true);
  assert.equal(current.closed, false);
  assert.equal(f.screenAudioProducer.current, current);
  assert.equal(f.bridgeStops(), stops);
});

test('voice generation and transport replacement invalidate a pending audio capture', async t => {
  const f = fixture(t), pending = deferred<{ ok: boolean; error: undefined }>();
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenAudio().catch(error => error);
  await settle();
  f.mediaGeneration.current++;
  let replacementPublishes = 0;
  f.sendTransport.current = { produce: async () => { replacementPublishes++; return producer('replacement'); } };
  pending.resolve({ ok: true, error: undefined });
  await oldStart;
  assert.equal(replacementPublishes, 0);
  assert.equal(f.screenAudioProducer.current, null);
  assert.equal(f.contexts[0].closes, 1);
});

test('repeated audio start while its native ACK is pending uses a single pipeline and request', async t => {
  const f = fixture(t), pending = deferred<{ ok: boolean; error: undefined }>();
  f.capture(() => pending.promise);
  const first = f.api.startScreenAudio(), second = f.api.startScreenAudio();
  await settle();
  const starts = f.bridgeStarts(), pipelines = f.contexts.length;
  pending.resolve({ ok: true, error: undefined });
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(pipelines, 1);
  assert.equal(f.produced.length, 1);
});

test('closing while AudioContext resume is pending never starts native capture afterwards', async t => {
  const f = fixture(t), pending = deferred<void>();
  f.suspend(() => pending.promise);
  const oldStart = f.api.startScreenAudio().catch(error => error);
  f.api.closeScreenAudio();
  assert.equal(f.contexts[0].closes, 1);
  pending.resolve();
  await oldStart;
  assert.equal(f.bridgeStarts(), 0);
  assert.equal(f.produced.length, 0);
  assert.equal(f.screenAudioPipeline.current, null);
});

test('the owning video publication can invalidate native audio without reviving its producer', async t => {
  const f = fixture(t), pending = deferred<{ ok: boolean; error: undefined }>();
  let current = true;
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenAudio(() => current).catch(error => error);
  await settle();
  current = false;
  pending.resolve({ ok: true, error: undefined });
  await oldStart;
  assert.equal(f.produced.length, 0);
  assert.equal(f.contexts[0].closes, 1);
  assert.equal(f.screenAudioPipeline.current, null);
});
