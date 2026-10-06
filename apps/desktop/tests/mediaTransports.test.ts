import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { useScreenViewing } from '../src/features/media/screen/useScreenViewing';
import { useMediaTransports } from '../src/features/media/transport/useMediaTransports';

const ref = (current: any) => ({ current });
function fixture() {
  const events: string[] = [];
  const handlers = new Map<string, Set<Function>>();
  const consumer = {
    id: 'consumer-1', track: { kind: 'video', readyState: 'live' }, closed: false,
    close() {
      this.closed = true;
      for (const handler of handlers.get('close') ?? []) handler();
    },
    on(name: string, handler: Function) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
    },
    off(name: string, handler: Function) { handlers.get(name)?.delete(handler); },
    getStats: async () => new Map(),
    rtpReceiver: { playoutDelayHint: undefined },
  };
  let resumeReply: ((value?: unknown) => void) | undefined;
  const deps: any = {
    screen: null,
    deviceRef: ref({ rtpCapabilities: {} }),
    recvTransport: ref({ closed: false, consume: async () => consumer }),
    sendTransport: ref(null), mediaGeneration: ref(1),
    socket: {
      connected: true,
      emit(event: string, payload: any, reply: (value?: unknown) => void) {
        events.push(event);
        if (event === 'ms:consume') reply({ id: consumer.id });
        if (event === 'ms:resume-consumer') resumeReply = reply;
      },
    },
    consumerByProducer: ref(new Map()), pendingProducers: ref(new Set()),
    consumers: ref(new Map()), remoteAudioOutputs: ref(new Map()),
    audioEls: ref(new Map()), screenStreams: ref(new Map()),
    setRemoteScreen(value: any) {
      deps.screen = typeof value === 'function' ? value(deps.screen) : value;
      events.push('screen-ready');
    },
    setScreenReceiveHasAudio() {},
    detachAnalyser() {},
    removeRemoteApplicationAudio() {},
  };
  let api!: ReturnType<typeof useMediaTransports>;
  function Harness() { api = useMediaTransports(deps); return null; }
  renderToString(React.createElement(Harness));
  return { api, deps, consumer, events, reply: (value?: unknown) => resumeReply!(value) };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function installStream(t: any) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true, value: class { constructor(readonly tracks: any[]) {} },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'MediaStream', previous);
    else delete (globalThis as any).MediaStream;
  });
}

test('desktop prepares screen before resume and still awaits the acknowledgement', async t => {
  installStream(t);
  const f = fixture();
  let finished = false;
  const pending = f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' })
    .then(value => { finished = true; return value; });
  await flush();
  assert.deepEqual(f.events, ['ms:consume', 'screen-ready', 'ms:resume-consumer']);
  assert.equal(finished, false);
  assert.ok(f.deps.screen.stream);
  f.reply({});
  assert.equal(await pending, true);
});

test('resume rejection removes the early attached screen and permits retry', async t => {
  installStream(t);
  const f = fixture();
  const pending = f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' });
  await flush();
  f.reply({ error: 'resume failed' });
  assert.equal(await pending, false);
  assert.equal(f.consumer.closed, true);
  assert.equal(f.deps.screen, null);
  assert.equal(f.deps.consumers.current.size, 0);
  assert.equal(f.deps.consumerByProducer.current.size, 0);
  assert.equal(f.deps.pendingProducers.current.size, 0);
  assert.ok(f.events.includes('ms:close-consumer'));
});

test('stale resume cannot remove a newer screen for the same peer', async t => {
  installStream(t);
  const f = fixture();
  const pending = f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' });
  await flush();
  const newerStream = {};
  f.deps.mediaGeneration.current++;
  f.deps.screenStreams.current.set('peer-1', newerStream);
  f.deps.screen = { socketId: 'peer-1', stream: newerStream };
  f.deps.consumerByProducer.current.set('producer-1', 'new-consumer');
  f.reply({});
  assert.equal(await pending, false);
  assert.equal(f.deps.screen.stream, newerStream);
  assert.equal(f.deps.consumerByProducer.current.get('producer-1'), 'new-consumer');
});

test('failed local consume closes the already-created server consumer', async () => {
  const f = fixture();
  f.deps.recvTransport.current.consume = async () => { throw new Error('negotiation failed'); };
  assert.equal(await f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' }), false);
  assert.ok(f.events.includes('ms:close-consumer'));
  assert.equal(f.deps.pendingProducers.current.size, 0);
});

test('stale screen-audio resume preserves newer live audio state and detaches old analyser', async t => {
  installStream(t);
  const f = fixture();
  const detached: string[] = [];
  f.deps.detachAnalyser = (id: string) => detached.push(id);
  f.deps.ensureAudioCtx = () => { throw new Error('headless audio unavailable'); };
  f.deps.setScreenReceiveHasAudio = (value: boolean) => { f.deps.hasAudio = value; };
  const pending = f.api.consumeProducer('producer-1', 'peer-1', 'audio', { type: 'screen-audio' });
  await flush();
  f.deps.mediaGeneration.current++;
  f.deps.consumers.current.set('new-consumer', {
    consumer: { id: 'new-consumer', closed: false }, sourceType: 'screen-audio',
  });
  f.reply({});
  assert.equal(await pending, false);
  assert.equal(f.deps.hasAudio, true);
  assert.deepEqual(detached, ['consumer-1']);
});

function viewing(f: ReturnType<typeof fixture>) {
  Object.assign(f.deps, {
    availableScreensRef: ref(new Map([
      ['peer-1', { socketId: 'peer-1', videoProducerId: 'producer-1', audioProducerId: 'audio-1' }],
      ['peer-2', { socketId: 'peer-2', videoProducerId: 'producer-2' }],
    ])),
    watchingScreenPeerRef: ref(null), setWatchingScreenPeer() {},
    videoCounterPrev: ref(null), receiveLossPrev: ref(null), screenProducer: ref(null),
    setStats() {}, consumeProducer: f.api.consumeProducer,
  });
  let api!: ReturnType<typeof useScreenViewing>;
  function Harness() { api = useScreenViewing(f.deps); return null; }
  renderToString(React.createElement(Harness));
  return api;
}

test('stop watching during consume ACK prevents late screen resurrection and closes server orphan', async t => {
  installStream(t);
  const f = fixture();
  const view = viewing(f);
  let reply!: Function;
  f.deps.socket.emit = (event: string, payload: any, callback: Function) => {
    f.events.push(event);
    if (event === 'ms:consume') reply = callback;
  };
  const pending = view.watchScreen('peer-1');
  view.stopWatchingScreen();
  reply({ id: 'consumer-1' });
  await pending;
  assert.equal(f.deps.watchingScreenPeerRef.current, null);
  assert.equal(f.deps.screen, null);
  assert.equal(f.deps.consumers.current.size, 0);
  assert.equal(f.events.includes('ms:resume-consumer'), false);
  assert.equal(f.events.includes('ms:close-consumer'), true);
});

test('cancelled watch continuation cannot clear a newer selected peer or subscribe old audio', async () => {
  const f = fixture();
  const requests: { peer: string; current: () => boolean; reply: (ok: boolean) => void }[] = [];
  f.api.consumeProducer = ((_id: string, peer: string, _kind: string, _data: any, current: () => boolean) =>
    new Promise<boolean>(reply => requests.push({ peer, current, reply }))) as any;
  const view = viewing(f);
  const first = view.watchScreen('peer-1');
  const second = view.watchScreen('peer-2');
  assert.equal(requests[0].current(), false);
  assert.equal(requests[1].current(), true);
  requests[0].reply(false);
  await first;
  assert.equal(f.deps.watchingScreenPeerRef.current, 'peer-2');
  assert.equal(requests.length, 2);
  requests[1].reply(true);
  await second;
});

for (const mode of ['default', 'adaptive', 'legacy', 'profile-legacy', 'storage-denied']) {
  test(`audio playout ${mode} selects the expected receiver policy`, async t => {
    installStream(t);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const storage = {
      getItem(key: string) {
        if (mode === 'storage-denied') throw new Error('denied');
        if (mode === 'legacy' && key === 'cove:legacy-audio-playout') return '1';
        if (mode === 'adaptive' && key === 'cove:adaptive-audio-playout') return '1';
        return null;
      },
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: storage,
        ...(mode === 'profile-legacy' ? { coveAudioLatencyProfile: 'legacy' } : {}),
      },
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else delete (globalThis as any).localStorage;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as any).window;
    });
    const f = fixture();
    f.consumer.track.kind = 'audio';
    f.deps.ensureAudioCtx = () => { throw new Error('headless audio unavailable'); };
    const pending = f.api.consumeProducer('producer-1', 'peer-1', 'audio', { type: 'screen-audio' });
    await flush();
    assert.equal(
      f.consumer.rtpReceiver.playoutDelayHint,
      mode === 'adaptive' ? undefined : mode === 'legacy' || mode === 'profile-legacy' ? 0.08 : 0.04,
    );
    f.reply({});
    assert.equal(await pending, true);
    f.consumer.close();
  });
}

test('late announced screen audio uses the same cancellation guard as the picture', async () => {
  const f = fixture();
  const view = viewing(f);
  f.deps.watchingScreenPeerRef.current = 'peer-1';
  let reply!: Function;
  f.deps.socket.emit = (event: string, payload: any, callback: Function) => {
    f.events.push(event);
    if (event === 'ms:consume') reply = callback;
  };
  const pending = f.api.consumeProducer('audio-1', 'peer-1', 'audio',
    { type: 'screen-audio' }, view.captureWatchGuard('peer-1'));
  view.stopWatchingScreen();
  reply({ id: 'consumer-1' });
  assert.equal(await pending, false);
  assert.equal(f.events.includes('ms:resume-consumer'), false);
  assert.equal(f.deps.remoteAudioOutputs.current.size, 0);
  assert.equal(f.events.includes('ms:close-consumer'), true);
});
