import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AudioPlayoutConsumer,
  AudioPlayoutPolicy,
  resolveAudioPlayoutMode,
} from '../src/features/media/transport/audioPlayoutPolicy';

type Stats = {
  timestamp: number;
  packetsLost: number;
  packetsReceived: number;
  jitter: number;
  concealedSamples: number;
  concealmentEvents: number;
  totalSamplesReceived: number;
};

const cleanStats = (overrides: Partial<Stats> = {}): Stats => ({
  timestamp: 1_000,
  packetsLost: 0,
  packetsReceived: 50,
  jitter: 0.005,
  concealedSamples: 0,
  concealmentEvents: 0,
  totalSamplesReceived: 48_000,
  ...overrides,
});

function policyFixture(options: { synchronized?: boolean; videoReceiver?: Record<string, unknown> } = {}) {
  let now = 1_000;
  let stats = cleanStats();
  let onGetStats: (() => Promise<Map<string, object>>) | null = null;
  const receiver: Record<string, unknown> = { jitterBufferTarget: null, playoutDelayHint: null };
  const listeners = new Map<string, Set<() => void>>();
  const observerCloseListeners = new Set<() => void>();
  const consumer: AudioPlayoutConsumer = {
    id: 'audio-1',
    kind: 'audio',
    closed: false,
    track: { readyState: 'live' },
    rtpReceiver: receiver,
    observer: {
      on(event, listener) { if (event === 'close') observerCloseListeners.add(listener); },
      off(event, listener) { if (event === 'close') observerCloseListeners.delete(listener); },
    },
    async getStats() {
      if (onGetStats) return onGetStats();
      return new Map([['audio', {
        type: 'inbound-rtp',
        kind: 'audio',
        ...stats,
      }]]);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const policy = new AudioPlayoutPolicy('adaptive', {
    now: () => now,
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as typeof globalThis.clearInterval,
  });
  const stop = policy.watch(consumer, 'peer-1-screen', 'audio', options.synchronized ?? false);
  let videoConsumer: AudioPlayoutConsumer | undefined;
  if (options.synchronized) {
    videoConsumer = {
      id: 'video-1',
      kind: 'video',
      closed: false,
      track: { readyState: 'live' },
      rtpReceiver: (options.videoReceiver ?? { jitterBufferTarget: null }) as AudioPlayoutConsumer['rtpReceiver'],
      async getStats() { return new Map(); },
      on() {},
      off() {},
    };
    policy.watch(videoConsumer, 'peer-1-screen', 'video', true);
  }
  return {
    consumer,
    receiver,
    videoConsumer,
    listeners,
    observerCloseListeners,
    policy,
    setStats(next: Partial<Stats>) { stats = { ...stats, ...next }; },
    setGetStats(callback: (() => Promise<Map<string, object>>) | null) { onGetStats = callback; },
    setNow(value: number) { now = value; },
    async tick(overrides: Partial<Stats> = {}, elapsedMs = 1_000) {
      now += elapsedMs;
      stats = {
        ...stats,
        ...overrides,
        timestamp: overrides.timestamp ?? stats.timestamp + elapsedMs,
      };
      await policy.sampleNow();
    },
    async baseline() { await policy.sampleNow(); },
    emitClose() {
      consumer.closed = true;
      for (const listener of [...observerCloseListeners]) listener();
    },
    stop,
  };
}

test('mode selection keeps browser-native opt-in and honors the explicit legacy A/B profile', () => {
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
  assert.equal(resolveAudioPlayoutMode(), 'adaptive');
  assert.equal(resolveAudioPlayoutMode('adaptive'), 'adaptive');
  assert.equal(resolveAudioPlayoutMode(undefined, storage({ 'cove:adaptive-audio-playout': '1' })), 'native');
  assert.equal(resolveAudioPlayoutMode(undefined, storage({ 'cove:legacy-audio-playout': '1' })), 'legacy');
  assert.equal(resolveAudioPlayoutMode('legacy', storage({ 'cove:adaptive-audio-playout': '1' })), 'legacy');
  assert.equal(resolveAudioPlayoutMode('legacy', { getItem() { throw new Error('denied'); } }), 'legacy');
});

test('managed mode prefers millisecond jitterBufferTarget and applies a conservative 40ms start', () => {
  const f = policyFixture();
  assert.equal(f.receiver.jitterBufferTarget, 40);
  assert.equal(f.receiver.playoutDelayHint, null);
  f.stop();
  assert.equal(f.receiver.jitterBufferTarget, null);
  f.policy.dispose();
});

test('playoutDelayHint fallback converts milliseconds to seconds', () => {
  const policy = new AudioPlayoutPolicy('adaptive', {
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as typeof globalThis.clearInterval,
  });
  const receiver = { playoutDelayHint: null };
  const consumer = {
    id: 'audio-fallback', kind: 'audio', track: { readyState: 'live' },
    rtpReceiver: receiver, async getStats() { return new Map(); }, on() {}, off() {},
  } as AudioPlayoutConsumer;
  const stop = policy.watch(consumer, 'mic-peer', 'audio');
  assert.equal(receiver.playoutDelayHint, 0.04);
  stop();
  assert.equal(receiver.playoutDelayHint, null);
  policy.dispose();
});

test('unsupported receivers retain browser defaults and do not start managed changes', async () => {
  const policy = new AudioPlayoutPolicy('adaptive', {
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as typeof globalThis.clearInterval,
  });
  const receiver = {};
  const consumer = {
    id: 'audio-unsupported', kind: 'audio', track: { readyState: 'live' }, rtpReceiver: receiver,
    async getStats() { return new Map(); }, on() {}, off() {},
  } as AudioPlayoutConsumer;
  const stop = policy.watch(consumer, 'mic-peer', 'audio');
  await policy.sampleNow();
  assert.deepEqual(receiver, {});
  stop();
  policy.dispose();
});

test('clean windows lower the target to 20ms only after the full stable window', async () => {
  const f = policyFixture();
  await f.baseline();
  for (let i = 0; i < 7; i++) await f.tick({
    packetsReceived: (i + 2) * 50,
    totalSamplesReceived: (i + 2) * 48_000,
  });
  assert.equal(f.receiver.jitterBufferTarget, 40);
  await f.tick({ packetsReceived: 450, totalSamplesReceived: 432_000 });
  assert.equal(f.receiver.jitterBufferTarget, 20);
  f.stop();
  f.policy.dispose();
});

test('jitter, interval loss, or concealment increases raise the target promptly', async t => {
  for (const degradation of ['jitter', 'loss', 'concealment'] as const) {
    await t.test(degradation, async () => {
      const f = policyFixture();
      await f.baseline();
      const update: Partial<Stats> = {
        packetsReceived: 98,
        totalSamplesReceived: 96_000,
        timestamp: 2_000,
      };
      if (degradation === 'jitter') update.jitter = 0.035;
      if (degradation === 'loss') update.packetsLost = 2;
      if (degradation === 'concealment') {
        update.concealedSamples = 600;
        update.concealmentEvents = 1;
      }
      await f.tick(update);
      assert.equal(f.receiver.jitterBufferTarget, 80);
      f.stop();
      f.policy.dispose();
    });
  }
});

test('severe impairment can raise the target to 120ms', async () => {
  const f = policyFixture();
  await f.baseline();
  await f.tick({
    timestamp: 2_000,
    packetsReceived: 95,
    packetsLost: 5,
    jitter: 0.09,
    concealedSamples: 3_000,
    concealmentEvents: 1,
    totalSamplesReceived: 96_000,
  });
  assert.equal(f.receiver.jitterBufferTarget, 120);
  f.stop();
  f.policy.dispose();
});

test('recovery requires clean windows and a long cooldown before stepping down', async () => {
  const f = policyFixture();
  await f.baseline();
  await f.tick({ packetsReceived: 98, packetsLost: 2, timestamp: 2_000 });
  assert.equal(f.receiver.jitterBufferTarget, 80);

  for (let i = 0; i < 7; i++) await f.tick({
    packetsReceived: 148 + i * 50,
    totalSamplesReceived: 144_000 + i * 48_000,
  });
  assert.equal(f.receiver.jitterBufferTarget, 80);
  for (let i = 0; i < 5; i++) await f.tick({
    packetsReceived: 498 + i * 50,
    totalSamplesReceived: 480_000 + i * 48_000,
  });
  assert.equal(f.receiver.jitterBufferTarget, 40);
  f.stop();
  f.policy.dispose();
});

test('missing counters, stale windows, resets, and stats errors never count as healthy', async () => {
  const f = policyFixture();
  await f.baseline();
  await f.tick({ packetsReceived: 98, packetsLost: 2, timestamp: 2_000 });
  assert.equal(f.receiver.jitterBufferTarget, 80);

  f.setGetStats(async () => new Map([['audio', {
    type: 'inbound-rtp', kind: 'audio', timestamp: 3_000,
    packetsLost: 0, packetsReceived: 150, jitter: 0.005,
    // Missing concealment counters invalidate the window instead of looking clean.
  }]]));
  await f.tick({ timestamp: 3_000 });
  assert.equal(f.receiver.jitterBufferTarget, 80);

  f.setGetStats(null);
  f.setStats(cleanStats({ timestamp: 4_000, packetsReceived: 150, packetsLost: 2 }));
  await f.tick({ timestamp: 4_000 }); // fresh baseline after missing stats
  await f.tick({ timestamp: 4_000 }); // stale timestamp
  assert.equal(f.receiver.jitterBufferTarget, 80);
  await f.tick({
    timestamp: 5_000,
    packetsReceived: 5,
    packetsLost: 0,
    totalSamplesReceived: 1_000,
  }); // counter reset: baseline only
  assert.equal(f.receiver.jitterBufferTarget, 80);

  f.setGetStats(async () => { throw new Error('stats unavailable'); });
  for (let i = 0; i < 12; i++) await f.tick({ timestamp: 6_000 + i * 1_000 });
  assert.equal(f.receiver.jitterBufferTarget, 80);
  f.stop();
  f.policy.dispose();
});

test('audio and video in a synchronized screen group receive the same target', async () => {
  const f = policyFixture({ synchronized: true });
  assert.equal(f.receiver.jitterBufferTarget, 40);
  assert.equal(f.videoConsumer?.rtpReceiver?.jitterBufferTarget, 40);
  await f.baseline();
  await f.tick({ packetsReceived: 98, packetsLost: 2, timestamp: 2_000 });
  assert.equal(f.receiver.jitterBufferTarget, 80);
  assert.equal(f.videoConsumer?.rtpReceiver?.jitterBufferTarget, 80);
  f.stop();
  assert.equal(f.videoConsumer?.rtpReceiver?.jitterBufferTarget, null);
  f.policy.dispose();
});

test('screen video waits for paired audio before applying a target and returns to native when audio leaves', () => {
  const policy = new AudioPlayoutPolicy('adaptive', {
    setInterval: (() => 1) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as typeof globalThis.clearInterval,
  });
  const videoReceiver = { jitterBufferTarget: null };
  const videoConsumer: AudioPlayoutConsumer = {
    id: 'video-first', kind: 'video', track: { readyState: 'live' }, rtpReceiver: videoReceiver,
    async getStats() { return new Map(); },
  };
  const stopVideo = policy.watch(videoConsumer, 'paired-screen', 'video', true);
  assert.equal(videoReceiver.jitterBufferTarget, null);

  const audioReceiver = { jitterBufferTarget: null };
  const audioConsumer: AudioPlayoutConsumer = {
    id: 'audio-second', kind: 'audio', track: { readyState: 'live' }, rtpReceiver: audioReceiver,
    async getStats() { return new Map(); },
  };
  const stopAudio = policy.watch(audioConsumer, 'paired-screen', 'audio', true);
  assert.equal(videoReceiver.jitterBufferTarget, 40);
  assert.equal(audioReceiver.jitterBufferTarget, 40);
  stopAudio();
  assert.equal(videoReceiver.jitterBufferTarget, null);
  stopVideo();
  policy.dispose();
});

test('an unsupported receiver disables adjustment for the whole synchronized group', () => {
  const f = policyFixture({ synchronized: true, videoReceiver: {} });
  assert.equal(f.receiver.jitterBufferTarget, null);
  assert.deepEqual(f.videoConsumer?.rtpReceiver, {});
  f.stop();
  f.policy.dispose();
});

test('a receiver setter failure during an update disables and resets the whole synchronized group', async () => {
  let videoTarget: number | null = null;
  const videoReceiver: Record<string, unknown> = {};
  Object.defineProperty(videoReceiver, 'jitterBufferTarget', {
    configurable: true,
    get() { return videoTarget; },
    set(value: number | null) {
      if (value === 80) throw new Error('receiver rejected target');
      videoTarget = value;
    },
  });
  const f = policyFixture({ synchronized: true, videoReceiver });
  assert.equal(f.receiver.jitterBufferTarget, 40);
  assert.equal(videoTarget, 40);
  await f.baseline();
  await f.tick({ packetsReceived: 98, packetsLost: 2, timestamp: 2_000 });
  assert.equal(f.receiver.jitterBufferTarget, null);
  assert.equal(videoTarget, null);
  f.stop();
  f.policy.dispose();
});

test('observer close, transport close, track end, explicit stop, and global dispose detach the watcher', async t => {
  for (const ending of ['observer-close', 'transportclose', 'trackended', 'stop', 'dispose'] as const) {
    await t.test(ending, async () => {
      const f = policyFixture();
      const values: number[] = [];
      Object.defineProperty(f.receiver, 'jitterBufferTarget', {
        configurable: true,
        get() { return values.at(-1) ?? null; },
        set(value: number | null) { values.push(value as number); },
      });
      // Re-register to exercise cleanup observation with the instrumented receiver.
      f.stop();
      const stop = f.policy.watch(f.consumer, 'peer-1-screen', 'audio');
      await f.baseline();
      if (ending === 'dispose') f.policy.dispose();
      else if (ending === 'observer-close') f.emitClose();
      else if (ending === 'stop') stop();
      else for (const listener of f.listeners.get(ending) ?? []) listener();
      if (ending !== 'dispose') stop();
      const writesAtStop = values.length;
      await f.tick({ timestamp: 2_000, jitter: 0.09 });
      assert.equal(values.length, writesAtStop);
      assert.ok(values.includes(40));
    });
  }
});

test('a stats request finishing after stop cannot write to the receiver', async () => {
  const f = policyFixture();
  await f.baseline();
  let finish!: (value: Map<string, object>) => void;
  f.setGetStats(() => new Promise((resolve) => { finish = resolve; }));
  f.setNow(2_000);
  const pending = f.policy.sampleNow();
  const writes: unknown[] = [];
  Object.defineProperty(f.receiver, 'jitterBufferTarget', {
    configurable: true,
    get() { return writes.at(-1) ?? null; },
    set(value) { writes.push(value); },
  });
  f.stop();
  const writesAtStop = writes.length;
  finish(new Map([['audio', {
    type: 'inbound-rtp', kind: 'audio', ...cleanStats({ timestamp: 2_000, jitter: 0.09 }),
  }]]));
  await pending;
  assert.equal(writes.length, writesAtStop);
  assert.equal(writes.at(-1), null);
  f.policy.dispose();
});
