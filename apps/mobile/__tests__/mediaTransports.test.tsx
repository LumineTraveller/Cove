import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Device } from 'mediasoup-client';
import { useScreenViewing } from '../src/features/media/screen/useScreenViewing';
import { useMediaTransports } from '../src/features/media/transport/useMediaTransports';
import { emitAsync } from '../src/features/media/mobileMediaSupport';

jest.mock('mediasoup-client', () => ({ Device: { factory: jest.fn() } }));
jest.mock('react-native-webrtc', () => ({
  MediaStream: class { release = jest.fn(); constructor() {} },
}));
jest.mock('../src/features/media/mobileMediaSupport', () => ({ emitAsync: jest.fn() }));
const request = jest.mocked(emitAsync);
const ref = (current: any) => ({ current });

async function fixture() {
  const events: string[] = [];
  const consumer = {
    id: 'consumer-1', closed: false,
    track: { enabled: false, _setVolume: jest.fn(() => events.push('volume-ready')) },
    on: jest.fn(), close: jest.fn(),
  };
  const deps: any = {
    deviceRef: ref({ rtpCapabilities: {} }), sendTransport: ref(null),
    recvTransport: ref({ closed: false, consume: jest.fn(async () => consumer) }),
    mediaGeneration: ref(1), socket: { connected: true, emit: jest.fn() },
    checkTransport: jest.fn(), setConnectionState: jest.fn(),
    consumers: ref(new Map()), consumerByProducer: ref(new Map()),
    applicationAudioVolumes: ref(new Map()), setApplicationAudioShares: jest.fn(),
    setRemoteScreen: jest.fn(() => events.push('screen-ready')),
    inVoiceRef: ref(true), closedProducers: ref(new Set()), pendingProducers: ref(new Set()),
    screenReceiveVolumeRef: ref(0.4), memberVolumesRef: ref(new Map([['peer-1', 0.3]])),
    setError: jest.fn(),
  };
  let api!: ReturnType<typeof useMediaTransports>;
  let renderer!: TestRenderer.ReactTestRenderer;
  function Harness() { api = useMediaTransports(deps); return null; }
  await act(async () => { renderer = TestRenderer.create(<Harness />); });
  return { deps, api, consumer, events, dispose: async () => act(async () => renderer.unmount()) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => jest.resetAllMocks());

test('send and receive transport RPCs are both outstanding before either ACK', async () => {
  const f = await fixture();
  f.deps.deviceRef.current = null;
  const send = { id: 'send', on: jest.fn() };
  const receive = { id: 'recv', on: jest.fn() };
  jest.mocked(Device.factory).mockResolvedValue({
    load: jest.fn(async () => {}),
    createSendTransport: jest.fn(() => send), createRecvTransport: jest.fn(() => receive),
  } as any);
  const replies: Record<string, (value: any) => void> = {};
  request.mockImplementation((async (_socket: any, event: string, payload: any) => {
    if (event === 'ms:capabilities') return {};
    return new Promise(resolve => { replies[payload.direction] = resolve; });
  }) as any);
  const setup = f.api.setupDevice();
  await flush();
  expect(Object.keys(replies)).toEqual(['send', 'recv']);
  expect(f.deps.sendTransport.current).toBeNull();
  replies.recv({ id: 'recv' });
  await flush();
  expect(f.deps.recvTransport.current).not.toBe(receive);
  replies.send({ id: 'send' });
  await setup;
  expect(f.deps.sendTransport.current).toBe(send);
  expect(f.deps.recvTransport.current).toBe(receive);
  await f.dispose();
});

test('mobile applies volume before resume instead of allowing first packets at default volume', async () => {
  const f = await fixture();
  request.mockImplementation((async (_socket: any, event: string) => {
    f.events.push(event);
    return event === 'ms:consume' ? { id: 'consumer-1' } : {};
  }) as any);
  expect(await f.api.consumeProducer('producer-1', 'peer-1', 'audio', { type: 'mic' })).toBe(true);
  expect(f.events).toEqual(['ms:consume', 'volume-ready', 'ms:resume-consumer']);
  expect(f.consumer.track._setVolume).toHaveBeenCalledWith(0.3);
  await f.dispose();
});

test('mobile prepares video before resume and rolls it back if resume fails', async () => {
  const f = await fixture();
  request.mockImplementation((async (_socket: any, event: string) => {
    f.events.push(event);
    if (event === 'ms:consume') return { id: 'consumer-1' };
    throw new Error('resume failed');
  }) as any);
  expect(await f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' })).toBe(false);
  expect(f.events.slice(0, 3)).toEqual(['ms:consume', 'screen-ready', 'ms:resume-consumer']);
  expect(f.deps.consumers.current.size).toBe(0);
  expect(f.deps.consumerByProducer.current.size).toBe(0);
  expect(f.consumer.close).toHaveBeenCalled();
  expect(f.deps.socket.emit).toHaveBeenCalledWith('ms:close-consumer', { consumerId: 'consumer-1' });
  await f.dispose();
});

test('mobile closes orphan server consumer if local negotiation fails', async () => {
  const f = await fixture();
  request.mockResolvedValue({ id: 'consumer-1' } as any);
  f.deps.recvTransport.current.consume.mockRejectedValue(new Error('negotiation failed'));
  expect(await f.api.consumeProducer('producer-1', 'peer-1', 'video')).toBe(false);
  expect(f.deps.socket.emit).toHaveBeenCalledWith('ms:close-consumer', { consumerId: 'consumer-1' });
  await f.dispose();
});

test('failed setup observes a late opposite-direction ACK without resurrecting torn-down refs', async () => {
  const f = await fixture();
  f.deps.deviceRef.current = null;
  f.deps.recvTransport.current = null;
  const createSendTransport = jest.fn();
  const createRecvTransport = jest.fn();
  jest.mocked(Device.factory).mockResolvedValue({
    load: jest.fn(async () => {}), createSendTransport, createRecvTransport,
  } as any);
  let rejectSend!: (error: Error) => void;
  let resolveReceive!: (value: any) => void;
  request.mockImplementation((async (_socket: any, event: string, payload: any) => {
    if (event === 'ms:capabilities') return {};
    return new Promise((resolve, reject) => {
      if (payload.direction === 'send') rejectSend = reject;
      else resolveReceive = resolve;
    });
  }) as any);
  const setup = f.api.setupDevice();
  const observed = expect(setup).rejects.toThrow('send failed');
  await flush();
  rejectSend(new Error('send failed'));
  await observed;
  // The voice join caller tears down the failed generation.
  f.deps.mediaGeneration.current++;
  f.deps.deviceRef.current = null;
  resolveReceive({ id: 'late-recv' });
  await flush();
  expect(createSendTransport).not.toHaveBeenCalled();
  expect(createRecvTransport).not.toHaveBeenCalled();
  expect(f.deps.sendTransport.current).toBeNull();
  expect(f.deps.recvTransport.current).toBeNull();
  expect(f.deps.deviceRef.current).toBeNull();
  await f.dispose();
});


test('stop watching while consume is pending closes late server consumer without attaching screen', async () => {
  const f = await fixture();
  Object.assign(f.deps, {
    watchingScreenPeerRef: ref(null),
    availableScreensRef: ref(new Map([['peer-1', {
      socketId: 'peer-1', videoProducerId: 'producer-1', audioProducerId: 'audio-1',
    }]])),
    removeConsumer: f.api.removeConsumer, setIsWatchingScreen: jest.fn(),
    consumeProducer: f.api.consumeProducer,
  });
  let view!: ReturnType<typeof useScreenViewing>;
  let renderer!: TestRenderer.ReactTestRenderer;
  function Viewing() { view = useScreenViewing(f.deps); return null; }
  await act(async () => { renderer = TestRenderer.create(<Viewing />); });
  let reply!: (value: any) => void;
  request.mockImplementation((() => new Promise(resolve => { reply = resolve; })) as any);
  const pending = view.watchScreen('peer-1');
  view.stopWatchingScreen();
  reply({ id: 'consumer-1' });
  await pending;
  expect(f.deps.recvTransport.current.consume).not.toHaveBeenCalled();
  expect(f.deps.setRemoteScreen).toHaveBeenCalledTimes(1);
  expect(f.deps.setRemoteScreen).toHaveBeenCalledWith(null);
  expect(f.deps.socket.emit).toHaveBeenCalledWith('ms:close-consumer', { consumerId: 'consumer-1' });
  expect(f.deps.watchingScreenPeerRef.current).toBeNull();
  await act(async () => renderer.unmount());
  await f.dispose();
});


test('a duplicate pending consume is not reported as a ready subscription after watch cancellation', async () => {
  const f = await fixture();
  let current = true;
  let reply!: (value: any) => void;
  request.mockImplementation((() => new Promise(resolve => { reply = resolve; })) as any);
  const first = f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' }, () => current);
  current = false;
  expect(await f.api.consumeProducer('producer-1', 'peer-1', 'video', { type: 'screen' }, () => true)).toBe(false);
  reply({ id: 'consumer-1' });
  expect(await first).toBe(false);
  expect(f.deps.pendingProducers.current.size).toBe(0);
  expect(f.deps.consumers.current.size).toBe(0);
  await f.dispose();
});
