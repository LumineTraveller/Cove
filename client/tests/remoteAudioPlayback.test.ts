import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as audioDevices from '../src/audioDevices';
import * as disconnectGrace from '../src/utils/disconnectGrace';

// Exercise the actual hook callbacks/consumer setup without a room or microphone.
// React scheduling and platform endpoints are fakes; the gain-output code is real.
function playbackHarness() {
  const callbacks: Function[] = [];
  const activations: FakeAudio[] = [];
  const graph: { source: any; gain?: any; stream: any }[] = [];
  const streams: { tracks: { id: string }[] }[] = [];
  const consumed: { producerId: string; streamId: string }[] = [];
  const consumerEvents = new Map<string, Record<string, Function>>();
  const signals = new Map<string, number>();
  const meters: any[] = [];
  const timers: Function[] = [];
  const states: { initial: any; value: any }[] = [];
  let storageBlocked = false;
  class FakeAudio {
    muted = false;
    volume = 1;
    srcObject: unknown = null;
    paused = false;
    constructor() { activations.push(this); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const context = {
    state: 'running',
    destination: {},
    async resume() {},
    async setSinkId(_id: string) {},
    createGain() {
      return { gain: { value: 1 }, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
    },
    createMediaStreamSource(stream: any) {
      const entry: any = { stream };
      entry.source = {
        disconnected: false,
        connect(target: any) {
          entry.gain = target;
          if (target.getByteTimeDomainData) target.trackId = stream.tracks[0].id;
          return target;
        },
        disconnect() { this.disconnected = true; },
      };
      graph.push(entry);
      return entry.source;
    },
    createAnalyser() {
      const meter = {
        trackId: '', fftSize: 512, frequencyBinCount: 256, disconnected: false,
        getByteTimeDomainData(data: Uint8Array) { data.fill(signals.get(this.trackId) ?? 128); },
        disconnect() { this.disconnected = true; },
      };
      meters.push(meter);
      return meter;
    },
  };
  const transport = {
    id: 'transport', on() {},
    async consume(params: any) {
      consumed.push(params);
      const events: Record<string, Function> = {};
      consumerEvents.set(params.producerId, events);
      return {
        id: params.producerId,
        track: { id: params.producerId, kind: 'audio', enabled: true, muted: false, readyState: 'live' },
        on(event: string, handler: Function) { events[event] = handler; },
        close() {},
      };
    },
  };
  const socket = {
    id: 'viewer',
    connected: true,
    on() {},
    off() {},
    once() {},
    emit(_event: string, data: any, callback?: Function) { callback?.(data ?? {}); },
  };
  const exports: any = {};
  const moduleText = fs.readFileSync(new URL('../src/hooks/useWebRTC.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(moduleText, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require: (id: string) => {
      if (id === 'react') return {
        useState: (initial: any) => {
          const value = typeof initial === 'function' ? initial() : initial;
          const state = { initial: value, value };
          states.push(state);
          return [value, (next: any) => { state.value = typeof next === 'function' ? next(state.value) : next; }];
        },
        useRef: (initial: any) => ({ current: initial }),
        useEffect() {},
        useCallback: (callback: Function) => { callbacks.push(callback); return callback; },
      };
      if (id === 'mediasoup-client') return { Device: class {
        rtpCapabilities = {};
        async load() {}
        createRecvTransport() { return transport; }
        createSendTransport() { return transport; }
      } };
      if (id === '../audioDevices') return {
        ...audioDevices,
        createRemoteAudioOutput: (ctx: AudioContext, stream: MediaStream, volume: number) =>
          audioDevices.createRemoteAudioOutput(ctx, stream, volume, new FakeAudio() as unknown as HTMLAudioElement),
      };
      if (id.includes('utils/disconnectGrace')) return disconnectGrace;
      return {};
    },
    Audio: FakeAudio,
    MediaStream: class {
      constructor(public tracks: any[]) { streams.push(this); }
      getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
      addTrack(track: any) { this.tracks.push(track); }
      removeTrack(track: any) { this.tracks = this.tracks.filter(item => item !== track); }
    },
    window: { AudioContext: class { constructor() { return context; } } },
    localStorage: {
      getItem: () => null,
      setItem: () => { if (storageBlocked) throw new Error('storage denied'); },
    },
    document: { addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (callback: Function) => { timers.push(callback); return timers.length; }, clearInterval() {},
  });
  const rtc = exports.useWebRTC(socket, 'test-room');
  const setup = callbacks.find(fn => fn.toString().includes("'ms:capabilities'"));
  const consume = callbacks.find(fn => fn.toString().includes("'ms:consume'"));
  const close = callbacks.find(fn => fn.toString().includes("'ms:close-consumer'"));
  assert.ok(setup && consume && close, 'expected actual hook callbacks');
  const outputFor = (id: string) => {
    const entry = graph.find(entry => entry.stream.tracks[0].id === id && entry.gain?.gain);
    assert.ok(entry, `missing gain output for ${id}`);
    return entry;
  };
  const audibleElementFor = (id: string) => {
    const element = activations.find(element =>
      (element.srcObject as { tracks?: { id: string }[] } | null)?.tracks?.[0]?.id === id && !element.muted);
    assert.ok(element, `missing audible media element for ${id}`);
    return element;
  };
  return {
    rtc, setup, consume, close, activations, streams, consumed, outputFor, audibleElementFor,
    context, meters, signals,
    tickMeters: () => timers.forEach(callback => callback()),
    levels: () => states.find(state => state.initial === rtc.sharedAudioLevels)?.value,
    voiceLevels: () => states.find(state => state.initial === rtc.speakingLevels)?.value,
    blockStorage: () => { storageBlocked = true; },
    endTrack: (id: string) => consumerEvents.get(id)?.trackended?.(),
  };
}

test('screen audio plays through its own gain output instead of the video element', async () => {
  const h = playbackHarness();
  assert.equal(await h.setup(), true);
  h.rtc.setScreenReceiveVolume(0.25);
  assert.equal(await h.consume('video-1', 'alice', 'video', { type: 'screen' }), true);
  assert.equal(await h.consume('screen-1', 'alice', 'audio', { type: 'screen-audio' }), true);
  assert.equal(await h.consume('mic-1', 'alice', 'audio', { type: 'mic' }), true);
  assert.equal(await h.consume('app-1', 'alice', 'audio', { type: 'application-audio' }), true);
  const screen = h.streams.find(stream => stream.tracks.some(track => track.id === 'video-1'));
  assert.deepEqual(Array.from(screen?.tracks ?? [], track => track.id), ['video-1'],
    'the picture stream must stay video-only: element volume cannot scale MediaStream playback');
  // 媒体元素的 volume 对 MediaStream 无效，只有增益通路能真正改变响度。
  assert.equal(h.outputFor('screen-1').gain.gain.value, 0.25);
  h.rtc.setScreenReceiveVolume(1.5);
  assert.equal(h.outputFor('screen-1').gain.gain.value, 1.5, 'boost above 100% stays on the gain path');
  h.rtc.setScreenReceiveVolume(0);
  assert.equal(h.outputFor('screen-1').gain.gain.value, 0);
  assert.throws(() => h.audibleElementFor('screen-1'), undefined,
    'screen audio must not play through an audible media element');
  assert.equal(h.consumed.find(item => item.producerId === 'video-1')?.streamId, 'screen-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'screen-1')?.streamId, 'screen-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'mic-1')?.streamId, 'mic-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'app-1')?.streamId, 'application-audio-alice');
  h.rtc.setMemberVolume('alice', 'user-alice', 0.7);
  assert.equal(h.outputFor('mic-1').gain.gain.value, 0.7);
  assert.equal(h.outputFor('screen-1').gain.gain.value, 0, 'member volume must not touch screen audio');
  h.blockStorage();
  h.rtc.setScreenReceiveVolume(1);
  h.close('screen-1', true);
  assert.equal(h.outputFor('screen-1').gain.disconnected, true, 'closing the consumer releases its gain output');
  assert.equal(await h.consume('screen-2', 'alice', 'audio', { type: 'screen-audio' }), true);
  assert.equal(h.outputFor('screen-2').gain.gain.value, 1);
  h.endTrack('screen-2');
  assert.equal(h.outputFor('screen-2').gain.disconnected, true,
    'an ended screen-audio track must release its gain output');
  assert.equal(h.audibleElementFor('app-1').volume, 1);
  const voiceActivation = h.activations.find(element =>
    (element.srcObject as { tracks?: { id: string }[] } | null)?.tracks?.[0]?.id === 'mic-1');
  assert.ok(voiceActivation?.muted && voiceActivation.volume === 0,
    'microphone activation element must remain inaudible beside its gain path');
});

test('application sharing uses independent media-element controls per sharer', async () => {
  const h = playbackHarness();
  await h.setup();
  h.rtc.setApplicationAudioReceiveVolume('alice', 0.3);
  await h.consume('app-alice', 'alice', 'audio', { type: 'application-audio' });
  await h.consume('app-bob', 'bob', 'audio', { type: 'application-audio' });
  assert.equal(h.audibleElementFor('app-alice').volume, 0.3);
  h.blockStorage();
  h.rtc.setApplicationAudioReceiveVolume('alice', 0);
  const alice = h.activations.find(element =>
    (element.srcObject as { tracks?: { id: string }[] } | null)?.tracks?.[0]?.id === 'app-alice');
  assert.ok(alice);
  assert.equal(alice.volume, 0);
  assert.equal(alice.muted, true);
  assert.equal(h.audibleElementFor('app-bob').volume, 1);
  h.rtc.setApplicationAudioReceiveVolume('alice', 1);
  assert.equal(alice.volume, 1);
  assert.equal(alice.muted, false);
});

test('screen audio that arrives before the picture still gets its own gain output', async () => {
  const h = playbackHarness();
  await h.setup();
  h.rtc.setScreenReceiveVolume(0.6);
  await h.consume('screen-early', 'bob', 'audio', { type: 'screen-audio' });
  await h.consume('video-late', 'bob', 'video', { type: 'screen' });
  const stream = h.streams.find(item => item.tracks.some(track => track.id === 'video-late'));
  assert.deepEqual(Array.from(stream?.tracks ?? [], track => track.id), ['video-late']);
  assert.equal(h.outputFor('screen-early').gain.gain.value, 0.6);
  h.close('screen-early', true);
  assert.equal(h.outputFor('screen-early').gain.disconnected, true);
});

test('shared meters report pre-volume signal, use gain only as an audible gate and stay separate from voice', async () => {
  const h = playbackHarness();
  await h.setup();
  h.signals.set('mic-alice', 160);
  h.signals.set('app-alice', 144);
  h.signals.set('app-bob', 144);
  await h.consume('mic-alice', 'alice', 'audio', { type: 'mic' });
  await h.consume('app-alice', 'alice', 'audio', { type: 'application-audio' });
  await h.consume('app-bob', 'bob', 'audio', { type: 'application-audio' });
  h.rtc.setApplicationAudioReceiveVolume('alice', 0.5);
  h.tickMeters();
  assert.equal(h.voiceLevels().alice, 0.75);
  assert.equal(h.levels().alice, 0.375, 'nonzero gain must not compress the input level before the UI caps it');
  assert.equal(h.levels().bob, 0.375);
  h.rtc.setApplicationAudioReceiveVolume('alice', 0);
  h.tickMeters();
  assert.equal(h.levels().alice, 0);
  assert.equal(h.levels().bob, 0.375);
  h.rtc.setApplicationAudioReceiveVolume('alice', 2);
  h.tickMeters();
  assert.equal(h.levels().alice, 0.375, 'playback boost must not amplify the input level before the UI caps it');
  h.context.state = 'suspended';
  h.tickMeters();
  assert.equal(h.levels().alice, 0, 'a suspended gain output cannot be audible');
  assert.equal(h.levels().bob, 0, 'a suspended analyser must not display stale media-element samples');
});

test('shared meters stop when playback pauses, the track ends or the consumer is removed', async () => {
  const h = playbackHarness();
  await h.setup();
  h.signals.set('app-alice', 144);
  await h.consume('app-alice', 'alice', 'audio', { type: 'application-audio' });
  const element = h.audibleElementFor('app-alice');
  element.pause();
  h.tickMeters();
  assert.equal(h.levels().alice, 0, 'blocked autoplay must not show audible output');
  await element.play();
  h.tickMeters();
  assert.equal(h.levels().alice, 0.375);
  const meter = h.meters.find(meter => meter.trackId === 'app-alice');
  const stream = h.streams.find(stream => stream.tracks[0]?.id === 'app-alice');
  (stream!.tracks[0] as any).readyState = 'ended';
  h.tickMeters();
  assert.equal(h.levels().alice, 0);
  h.close('app-alice', true);
  h.tickMeters();
  assert.equal(h.levels().alice, undefined);
  assert.equal(meter.disconnected, true, 'removing a consumer releases its analyser');
});
