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
  let storageBlocked = false;
  class FakeAudio {
    muted = false;
    volume = 1;
    srcObject: unknown = null;
    paused = false;
    constructor() { activations.push(this); }
    async play() {}
    pause() { this.paused = true; }
  }
  const context = {
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
        connect(target: any) { entry.gain = target; return target; },
        disconnect() { this.disconnected = true; },
      };
      graph.push(entry);
      return entry.source;
    },
    createAnalyser() { return { fftSize: 512, frequencyBinCount: 256 }; },
  };
  const transport = {
    id: 'transport', on() {},
    async consume(params: any) {
      consumed.push(params);
      return { id: params.producerId, track: { id: params.producerId }, on() {}, close() {} };
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
        useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}],
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
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
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
    blockStorage: () => { storageBlocked = true; },
  };
}

test('screen audio joins the video stream and sync group without a duplicate audio player', async () => {
  const h = playbackHarness();
  assert.equal(await h.setup(), true);
  h.rtc.setScreenReceiveVolume(0.25);
  assert.equal(await h.consume('video-1', 'alice', 'video', { type: 'screen' }), true);
  assert.equal(await h.consume('screen-1', 'alice', 'audio', { type: 'screen-audio' }), true);
  assert.equal(await h.consume('mic-1', 'alice', 'audio', { type: 'mic' }), true);
  assert.equal(await h.consume('app-1', 'alice', 'audio', { type: 'application-audio' }), true);
  const screen = h.streams.find(stream => stream.tracks.some(track => track.id === 'video-1'));
  assert.deepEqual(Array.from(screen?.tracks ?? [], track => track.id), ['video-1', 'screen-1']);
  assert.equal(h.activations.some(element =>
    (element.srcObject as { tracks?: { id: string }[] } | null)?.tracks?.some(track => track.id === 'screen-1')), false,
    'screen audio must not play through a second media element');
  assert.equal(h.consumed.find(item => item.producerId === 'video-1')?.streamId, 'screen-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'screen-1')?.streamId, 'screen-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'mic-1')?.streamId, 'mic-alice');
  assert.equal(h.consumed.find(item => item.producerId === 'app-1')?.streamId, 'application-audio-alice');
  h.rtc.setMemberVolume('alice', 'user-alice', 0.7);
  assert.equal(h.outputFor('mic-1').gain.gain.value, 0.7);
  h.blockStorage();
  h.rtc.setScreenReceiveVolume(0);
  h.close('screen-1', true);
  assert.deepEqual(Array.from(screen?.tracks ?? [], track => track.id), ['video-1']);
  assert.equal(await h.consume('screen-2', 'alice', 'audio', { type: 'screen-audio' }), true);
  assert.deepEqual(Array.from(screen?.tracks ?? [], track => track.id), ['video-1', 'screen-2']);
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

test('screen stream also joins audio that arrives before video', async () => {
  const h = playbackHarness();
  await h.setup();
  await h.consume('screen-early', 'bob', 'audio', { type: 'screen-audio' });
  await h.consume('video-late', 'bob', 'video', { type: 'screen' });
  const stream = h.streams.find(item => item.tracks.some(track => track.id === 'video-late'));
  assert.deepEqual(Array.from(stream?.tracks ?? [], track => track.id), ['video-late', 'screen-early']);
  h.close('screen-early', true);
  assert.deepEqual(Array.from(stream?.tracks ?? [], track => track.id), ['video-late']);
});
