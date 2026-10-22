
import TestRenderer, { act } from 'react-test-renderer';
import { useMobileMedia } from '../src/features/media/useMobileMedia';

const mockConsumers = new Map<string, any>();
let mockNoiseMode = 'system';
const mockNoiseStatus = () => ({ mode: mockNoiseMode, effectiveMode: mockNoiseMode, rnnoiseReady: mockNoiseMode === 'rnnoise', interceptorActive: true, processing: mockNoiseMode === 'rnnoise', systemNoiseSuppressorEnabled: mockNoiseMode === 'system' });
const mockStreams: any[] = [];
const mockGetUserMedia = jest.fn(async () => {
  const track = { enabled: true };
  const stream = { getAudioTracks: () => [track], release: jest.fn() };
  mockStreams.push(stream);
  return stream;
});
const mockTransport = {
  id: 'voice-send', closed: false,
  connectionState: undefined as string | undefined,
  restartIce: jest.fn(async (_options: unknown) => {}),
  on: jest.fn(), close: jest.fn(),
  produce: jest.fn(async () => ({ close: jest.fn(), pause: jest.fn(), resume: jest.fn(), replaceTrack: jest.fn(), paused: false, closed: false })),
  consume: jest.fn(async (params: any) => {
    const consumer = { id: params.id, track: { enabled: true, _setVolume: jest.fn() }, close: jest.fn(), on: jest.fn() };
    mockConsumers.set(params.producerId, consumer);
    return consumer;
  }),
};
let mockSeparateTransports = false;
const mockReceiveTransport = {
  ...mockTransport,
  id: 'voice-receive', closed: false,
  connectionState: undefined as string | undefined,
  restartIce: jest.fn(async (_options: unknown) => {}),
  on: jest.fn(), close: jest.fn(),
};
let mockNextTransports: { send: typeof mockTransport; receive: typeof mockReceiveTransport } | undefined;
jest.mock('mediasoup-client', () => ({ Device: { factory: async () => ({
  load: async () => {}, rtpCapabilities: {},
  createSendTransport: () => mockNextTransports?.send ?? mockTransport,
  createRecvTransport: () => mockNextTransports?.receive ?? (mockSeparateTransports ? mockReceiveTransport : mockTransport),
}) } }));
jest.mock('react-native-incall-manager', () => ({ start: jest.fn(), stop: jest.fn(), setForceSpeakerphoneOn: jest.fn(), setSpeakerphoneOn: jest.fn(), stopProximitySensor: jest.fn(), turnScreenOn: jest.fn(), setKeepScreenOn: jest.fn() }));
jest.mock('react-native-webrtc', () => ({
  MediaStream: class { release = jest.fn(); },
  mediaDevices: { getUserMedia: (...args: any[]) => (mockGetUserMedia as any)(...args) },
}));
jest.mock('../src/features/media/audio/audioDevices', () => ({
  DEFAULT_OUTPUT_ID: 'out-speaker',
  listAudioDevices: jest.fn(async () => ({
    inputs: [{ id: 'default', label: '系统默认麦克风', isDefault: true }],
    outputs: [{ id: 'out-speaker', label: '扬声器' }, { id: 'out-earpiece', label: '听筒' }],
    inputId: 'default',
    outputId: 'out-speaker',
  })),
  setAudioInputDevice: jest.fn(async (id: string) => id),
  setAudioOutputDevice: jest.fn(async (id: string) => id),
}));
jest.mock('../src/features/media/microphone/microphoneNoise', () => ({
  DEFAULT_NOISE_MODE: 'system',
  isMicrophoneNoiseMode: (value: unknown) => value === 'system' || value === 'rnnoise',
  createMicrophoneConstraints: (mode: string) => ({ echoCancellation: true, noiseSuppression: mode === 'system', autoGainControl: false, channelCount: 1, sampleRate: 48000 }),
  applyNoiseMode: jest.fn(async (mode: string) => { mockNoiseMode = mode; return mockNoiseStatus(); }),
  getNoiseStatus: jest.fn(async () => mockNoiseStatus()),
}));

import { PermissionsAndroid } from 'react-native';
import { mediaDevices } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
const application = (producerId: string, peerId = 'peer1') => ({ producerId, peerId, kind: 'audio', appData: { type: 'application-audio', label: 'Music' } });
const microphone = (producerId: string, peerId = 'peer1') => ({ producerId, peerId, kind: 'audio', appData: { type: 'mic' } });
let media: ReturnType<typeof useMobileMedia>;
let renderer: TestRenderer.ReactTestRenderer;
let socket: any;
let handlers: Map<string, (...args: any[]) => any>;
let existing: any[];
let delayedConsume: (() => void) | undefined;
let holdConsume: boolean;
let currentRoom: string;
let Harness: () => null;

beforeEach(async () => {
  jest.clearAllMocks(); mockConsumers.clear(); mockStreams.length = 0; mockNoiseMode = 'system'; existing = []; delayedConsume = undefined; holdConsume = false;
  mockTransport.connectionState = undefined;
  mockReceiveTransport.connectionState = undefined;
  mockSeparateTransports = false;
  mockNextTransports = undefined;
  mockTransport.closed = false;
  mockReceiveTransport.closed = false;
  mockTransport.restartIce.mockReset().mockResolvedValue(undefined);
  mockReceiveTransport.restartIce.mockReset().mockResolvedValue(undefined);
  currentRoom = 'room';
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  handlers = new Map();
  socket = {
    id: 'session1', recovered: false,
    connected: true,
    on: jest.fn((event, listener) => handlers.set(event, listener)),
    off: jest.fn((event) => handlers.delete(event)),
    emit: jest.fn((event, data, callback) => {
      if (!callback) return;
      if (event === 'ms:get-producers') callback(existing);
      else if (event === 'ms:consume') {
        const respond = () => callback({ id: `consumer-${data.producerId}`, producerId: data.producerId });
        if (holdConsume) delayedConsume = respond; else respond();
      } else callback({});
    }),
  };
  Harness = () => { media = useMobileMedia(socket, currentRoom); return null; };
  await act(async () => { renderer = TestRenderer.create(<Harness />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); jest.restoreAllMocks(); jest.useRealTimers(); });

test('does not receive application audio before joining voice', async () => {
  await act(async () => { await handlers.get('ms:new-producer')!(application('app1')); });
  expect(mockConsumers.size).toBe(0);
  expect(media.applicationAudioShares).toEqual([]);
});

test('watches screen video and audio as a receiver without requesting a microphone', async () => {
  await act(async () => {await handlers.get('ms:new-producer')!({producerId: 'screen-video', peerId: 'desktop', kind: 'video', appData: {type: 'screen'}});});
  await act(async () => {await handlers.get('ms:new-producer')!({producerId: 'screen-audio', peerId: 'desktop', kind: 'audio', appData: {type: 'screen-audio'}});});
  await act(async () => {await media.watchScreen('desktop');});
  expect(media.isWatchingScreen).toBe(true);
  expect(media.remoteScreen?.socketId).toBe('desktop');
  expect(mockConsumers.has('screen-video')).toBe(true);
  expect(mockConsumers.has('screen-audio')).toBe(true);
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(mockGetUserMedia).not.toHaveBeenCalled();
  expect(mockTransport.produce).not.toHaveBeenCalled();
  expect(media.inVoice).toBe(false);
});

test('duplicate watch operations share one device setup and cancellation does not publish audio', async () => {
  await act(async () => {await handlers.get('ms:new-producer')!({producerId: 'screen-video', peerId: 'desktop', kind: 'video', appData: {type: 'screen'}});});
  holdConsume = true;
  let pending!: Promise<void>;
  await act(async () => {pending = media.watchScreen('desktop');});
  await act(async () => {await media.watchScreen('desktop'); media.stopWatchingScreen(); delayedConsume?.(); await pending;});
  expect(media.isWatchingScreen).toBe(false);
  expect(media.remoteScreen).toBeNull();
  expect(mockTransport.produce).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
});

test('publishes the microphone without a fixed bitrate cap while preserving Opus options', async () => {
  await act(async () => media.joinVoice());
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  const [options] = (mockTransport.produce as jest.Mock).mock.calls[0];
  expect(options.appData.type).toBe('mic');
  expect(options.codecOptions).toEqual({ opusStereo: false, opusDtx: true, opusFec: true });
  for (const encoding of options.encodings ?? []) {
    expect(encoding).not.toHaveProperty('maxBitrate');
  }
});

test('receives existing and new shares separately with default 100% volume', async () => {
  existing = [application('app1')];
  await act(async () => media.joinVoice());
  await act(async () => { await handlers.get('ms:new-producer')!(application('app2', 'peer2')); });
  expect(media.applicationAudioShares.map(s => [s.producerId, s.volume])).toEqual([['app1', 1], ['app2', 1]]);
  await act(async () => media.setApplicationAudioVolume('app1', 0.99));
  expect(mockConsumers.get('app1').track._setVolume).toHaveBeenLastCalledWith(0.99);
  expect(mockConsumers.get('app2').track._setVolume).toHaveBeenLastCalledWith(1);
  await act(async () => media.setApplicationAudioVolume('app1', -1));
  expect(mockConsumers.get('app1').track._setVolume).toHaveBeenLastCalledWith(0);
  await act(async () => media.setApplicationAudioVolume('app1', Number.NaN));
  expect(media.applicationAudioShares[0].volume).toBe(0);
});

test('duplicate producer notifications never create double audio', async () => {
  await act(async () => media.joinVoice());
  await act(async () => { await Promise.all([handlers.get('ms:new-producer')!(application('app1')), handlers.get('ms:new-producer')!(application('app1'))]); });
  expect(mockTransport.consume).toHaveBeenCalledTimes(1);
  expect(media.applicationAudioShares).toHaveLength(1);
});

test('sets an independent 0-200% volume on a members microphone', async () => {
  existing = [microphone('mic1')];
  await act(async () => media.joinVoice());
  expect(mockConsumers.get('mic1').track._setVolume).toHaveBeenLastCalledWith(1);

  await act(async () => media.setMemberVolume('peer1', 1.67));
  expect(mockConsumers.get('mic1').track._setVolume).toHaveBeenLastCalledWith(1.67);
  expect(media.memberVolumes.peer1).toBe(1.67);

  await act(async () => media.setMemberVolume('peer1', 3));
  expect(mockConsumers.get('mic1').track._setVolume).toHaveBeenLastCalledWith(2);
  expect(media.memberVolumes.peer1).toBe(2);
});

test('applies a selected member volume when their microphone arrives later', async () => {
  await act(async () => media.joinVoice());
  await act(async () => media.setMemberVolume('peer1', 0.35));
  await act(async () => { await handlers.get('ms:new-producer')!(microphone('mic1')); });
  expect(mockConsumers.get('mic1').track._setVolume).toHaveBeenLastCalledWith(0.35);
});

test('application audio close does not stop the same peers screen; stopping screen leaves application audio', async () => {
  existing = [application('app1'), { producerId: 'screen1', peerId: 'peer1', kind: 'video', appData: { type: 'screen' } }];
  await act(async () => media.joinVoice());
  await act(async () => media.watchScreen('peer1'));
  await act(async () => { handlers.get('ms:producer-closed')!({ producerId: 'app1', peerId: 'peer1', sourceType: 'application-audio' }); });
  expect(media.applicationAudioShares).toHaveLength(0);
  expect(media.isWatchingScreen).toBe(true);
  expect(media.availableScreens).toHaveLength(1);
  await act(async () => { await handlers.get('ms:new-producer')!(application('app2')); });
  await act(async () => media.stopWatchingScreen());
  expect(media.applicationAudioShares).toHaveLength(1);
  expect(mockConsumers.get('app2').close).not.toHaveBeenCalled();
});

test('consumer closed and peer departure clean up banners and audio', async () => {
  existing = [application('app1'), application('app2', 'peer2')];
  await act(async () => media.joinVoice());
  await act(async () => { handlers.get('ms:consumer-closed')!({ consumerId: 'consumer-app1' }); });
  expect(media.applicationAudioShares.map(s => s.producerId)).toEqual(['app2']);
  await act(async () => { handlers.get('voice:user-left')!({ socketId: 'peer2' }); });
  expect(media.applicationAudioShares).toEqual([]);
});

test('leaving voice cancels late audio subscription responses', async () => {
  await act(async () => media.joinVoice());
  holdConsume = true;
  let pending: Promise<void>;
  await act(async () => { pending = handlers.get('ms:new-producer')!(application('late')); });
  await act(async () => media.leaveVoice());
  await act(async () => { delayedConsume!(); await pending; });
  expect(media.applicationAudioShares).toEqual([]);
  expect(mockConsumers.has('late')).toBe(false);
  expect(socket.emit).toHaveBeenCalledWith('ms:close-consumer', { consumerId: 'consumer-late' });
});

test('short signal outage preserves voice and mute without buffering leave', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  await act(async () => media.toggleMute());
  socket.emit.mockClear();
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => jest.advanceTimersByTime(7_499));
  expect(media.inVoice).toBe(true);
  expect(mockTransport.close).not.toHaveBeenCalled();
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(media.inVoice).toBe(true);
  expect(media.isMuted).toBe(true);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', 'room');
});

test('signal timeout at 7500ms resets voice and allows another join', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  socket.emit.mockClear();
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => jest.advanceTimersByTime(7_500));
  expect(media.inVoice).toBe(false);
  expect(media.joining).toBe(false);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', 'room');
  await act(async () => { socket.connected = true; socket.id = 'session2'; handlers.get('connect')!(); });
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(true);
});

test('failed recovery with a new socket resets old transports immediately', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => { socket.connected = true; socket.id = 'session2'; handlers.get('connect')!(); });
  expect(media.inVoice).toBe(false);
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(true);
});

test('persistent media failure resets join guard, transient failure does not', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  const onState = mockTransport.on.mock.calls.find(([event]) => event === 'connectionstatechange')![1];
  await act(async () => onState('disconnected'));
  await act(async () => jest.advanceTimersByTime(3_000));
  await act(async () => onState('connected'));
  await act(async () => jest.advanceTimersByTime(8_000));
  expect(media.inVoice).toBe(true);
  await act(async () => onState('failed'));
  await act(async () => jest.advanceTimersByTime(7_500));
  expect(media.inVoice).toBe(false);
  expect(socket.emit).toHaveBeenCalledWith('voice:leave', 'room');
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(true);
});

test('explicit disconnect never waits for grace', async () => {
  await act(async () => media.joinVoice());
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('io client disconnect'); });
  expect(media.inVoice).toBe(false);
});

test('partial transport initialization failure can retry without server reconnect', async () => {
  mockTransport.produce.mockRejectedValueOnce(new Error('transport failed'));
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(false);
  expect(media.joining).toBe(false);
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(true);
});

test('leaving during microphone acquisition cannot resurrect the old join', async () => {
  let allow!: (result: any) => void;
  jest.spyOn(mediaDevices, 'getUserMedia').mockImplementationOnce(() => new Promise(resolve => { allow = resolve; }));
  const lateStream = { getAudioTracks: () => [{}], release: jest.fn() };
  let pending!: Promise<void>;
  await act(async () => { pending = media.joinVoice(); });
  await act(async () => media.leaveVoice());
  await act(async () => { allow(lateStream); await pending; });
  expect(media.inVoice).toBe(false);
  expect(media.joining).toBe(false);
  expect(mockTransport.produce).not.toHaveBeenCalled();
  expect(lateStream.release).toHaveBeenCalledWith(true);
  await act(async () => media.joinVoice());
  expect(media.inVoice).toBe(true);
});

test.each(['noise-status', 'output-route'] as const)('leaving during %s cancels the old join and releases its audio session', async stage => {
  let release!: () => void;
  if (stage === 'noise-status') {
    const noise = jest.requireMock('../src/features/media/microphone/microphoneNoise');
    noise.getNoiseStatus.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(mockNoiseStatus()); }));
  } else {
    const devices = jest.requireMock('../src/features/media/audio/audioDevices');
    devices.setAudioOutputDevice.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('out-speaker'); }));
  }
  let pending!: Promise<void>;
  await act(async () => { pending = media.joinVoice(); });
  expect(release).toBeDefined();
  await act(async () => media.leaveVoice());
  if (stage === 'output-route') expect(InCallManager.stop).toHaveBeenCalledTimes(1);
  socket.emit.mockClear();
  await act(async () => { release(); await pending; });
  expect(media.inVoice).toBe(false);
  expect(media.joining).toBe(false);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:join', 'room');
  expect(InCallManager.start).toHaveBeenCalledTimes(stage === 'output-route' ? 1 : 0);
});

test('a late route result cannot rejoin or stop the audio session of a newer join', async () => {
  const devices = jest.requireMock('../src/features/media/audio/audioDevices');
  let release!: () => void;
  devices.setAudioOutputDevice.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('out-speaker'); }));
  let oldJoin!: Promise<void>;
  await act(async () => { oldJoin = media.joinVoice(); });
  await act(async () => media.leaveVoice());
  await act(async () => media.joinVoice());
  const stops = jest.mocked(InCallManager.stop).mock.calls.length;
  socket.emit.mockClear();
  await act(async () => { release(); await oldJoin; });
  expect(media.inVoice).toBe(true);
  expect(InCallManager.stop).toHaveBeenCalledTimes(stops);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:join', 'room');
});

test('receiver-only media survives a recovered connection without publishing a microphone', async () => {
  await act(async () => handlers.get('ms:new-producer')!({producerId: 'screen-video', peerId: 'desktop', kind: 'video', appData: {type: 'screen'}}));
  await act(async () => media.watchScreen('desktop'));
  const screen = media.remoteScreen;
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  expect(media.remoteScreen).toBe(screen);
  expect(media.isWatchingScreen).toBe(true);
  expect(media.inVoice).toBe(false);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockTransport.produce).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', 'room');
});

test('a fresh server session cancels a pending receiver setup before its late capability ACK', async () => {
  await act(async () => handlers.get('ms:new-producer')!({producerId: 'screen-video', peerId: 'desktop', kind: 'video', appData: {type: 'screen'}}));
  const emit = socket.emit.getMockImplementation();
  let release!: () => void;
  socket.emit.mockImplementation((event: string, data: unknown, callback: (value: unknown) => void) => {
    if (event === 'ms:capabilities') release = () => callback({});
    else emit(event, data, callback);
  });
  let pending!: Promise<void>;
  await act(async () => { pending = media.watchScreen('desktop'); });
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => { socket.connected = true; socket.id = 'fresh-session'; socket.recovered = false; handlers.get('connect')!(); });
  await act(async () => { release(); await pending; });
  expect(media.isWatchingScreen).toBe(false);
  expect(media.remoteScreen).toBeNull();
  expect(socket.emit).not.toHaveBeenCalledWith('ms:create-transport', expect.anything(), expect.anything());
  expect(mockTransport.produce).not.toHaveBeenCalled();
});

test('unmounting while native routing is pending releases its audio session and cancels late join effects', async () => {
  const devices = jest.requireMock('../src/features/media/audio/audioDevices');
  let release!: () => void;
  devices.setAudioOutputDevice.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('out-speaker'); }));
  let pending!: Promise<void>;
  await act(async () => { pending = media.joinVoice(); });
  await act(async () => renderer.unmount());
  expect(InCallManager.stop).toHaveBeenCalledTimes(1);
  socket.emit.mockClear();
  await act(async () => { release(); await pending; });
  expect(socket.emit).not.toHaveBeenCalledWith('voice:join', 'room');
});


test.each(['join', 'watch'] as const)('fresh reconnect can immediately %s without reusing a cancelled capability request', async action => {
  let oldAck!: (response: unknown) => void;
  const emit = socket.emit.getMockImplementation();
  socket.emit.mockImplementation((event: string, data: unknown, callback: any) => {
    if (event === 'ms:capabilities' && !oldAck) oldAck = callback;
    else return emit(event, data, callback);
  });
  let oldWatch!: Promise<void>;
  await act(async () => { oldWatch = media.watchScreen('desktop'); });
  await act(async () => {
    socket.id = 'new-session'; socket.recovered = false;
    handlers.get('connect')!();
  });
  let next!: Promise<void>;
  await act(async () => {
    if (action === 'join') next = media.joinVoice();
    else {
      await handlers.get('ms:new-producer')!({ producerId: 'screen-new', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } });
      next = media.watchScreen('desktop');
    }
  });
  // A new operation must settle before the old server ACK arrives.
  expect(action === 'join' ? media.inVoice : media.isWatchingScreen).toBe(true);
  const closes = mockTransport.close.mock.calls.length;
  await act(async () => { oldAck({}); await oldWatch; await next; });
  expect(action === 'join' ? media.inVoice : media.isWatchingScreen).toBe(true);
  expect(mockTransport.close).toHaveBeenCalledTimes(closes);
  expect(media.screenWatchingBusy).toBe(false);
  expect(media.error).toBeNull();
});

test.each(['room', 'socket'] as const)('changing %s cancels a pending native route without disturbing a new join', async target => {
  const devices = jest.requireMock('../src/features/media/audio/audioDevices');
  let release!: () => void;
  devices.setAudioOutputDevice.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('out-speaker'); }));
  let oldJoin!: Promise<void>;
  await act(async () => { oldJoin = media.joinVoice(); });
  await act(async () => {
    if (target === 'room') currentRoom = 'room-next';
    else socket = { ...socket, id: 'socket-next', recovered: false };
    renderer.update(<Harness />);
  });
  expect(media.inVoice).toBe(false);
  expect(InCallManager.stop).toHaveBeenCalledTimes(1);
  await act(async () => media.joinVoice());
  const stops = jest.mocked(InCallManager.stop).mock.calls.length;
  socket.emit.mockClear();
  await act(async () => { release(); await oldJoin; });
  expect(media.inVoice).toBe(true);
  expect(InCallManager.stop).toHaveBeenCalledTimes(stops);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:join', expect.anything());
});

test('defaults to system noise suppression and allows RNNoise before joining', async () => {
  expect(media.noiseMode).toBe('system');
  await act(async () => { await media.selectNoiseMode('rnnoise'); });
  expect(media.noiseMode).toBe('rnnoise');
  expect(media.noiseError).toBeNull();
  await act(async () => { await media.selectNoiseMode('system'); });
  expect(media.noiseMode).toBe('system');
  expect(media.noiseError).toBeNull();
});

test('switches noise mode while in voice via replaceTrack', async () => {
  await act(async () => media.joinVoice());
  await act(async () => { await media.selectNoiseMode('rnnoise'); });
  expect(media.noiseMode).toBe('rnnoise');
  const producer = (await (mockTransport.produce as jest.Mock).mock.results[0].value);
  expect(producer.replaceTrack).toHaveBeenCalledWith({ track: mockStreams[1].getAudioTracks()[0] });
  expect(mockStreams[0].release).toHaveBeenCalledWith(true);
  expect(mockStreams[1].release).not.toHaveBeenCalled();
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  expect(media.inVoice).toBe(true);
  const { applyNoiseMode } = jest.requireMock('../src/features/media/microphone/microphoneNoise');
  expect(applyNoiseMode).toHaveBeenCalledWith('rnnoise');
});

test('noise switch preserves self mute and producer pause', async () => {
  await act(async () => media.joinVoice());
  await act(async () => media.toggleMute());
  await act(async () => media.selectNoiseMode('rnnoise'));
  expect(mockStreams[1].getAudioTracks()[0].enabled).toBe(false);
  expect(media.isMuted).toBe(true);
  expect(media.inVoice).toBe(true);
});

test('failed source creation retains the original microphone and mode', async () => {
  await act(async () => media.joinVoice());
  mockGetUserMedia.mockRejectedValueOnce(new Error('source failed'));
  await act(async () => media.selectNoiseMode('rnnoise'));
  expect(media.noiseMode).toBe('system');
  expect(media.noiseError).toContain('source failed');
  expect(mockStreams[0].release).not.toHaveBeenCalled();
  expect(media.inVoice).toBe(true);
});

test('failed native switch restores the previous live track and mode', async () => {
  await act(async () => media.joinVoice());
  const { applyNoiseMode } = jest.requireMock('../src/features/media/microphone/microphoneNoise');
  applyNoiseMode.mockRejectedValueOnce(new Error('model failed'));
  await act(async () => media.selectNoiseMode('rnnoise'));
  const producer = await (mockTransport.produce as jest.Mock).mock.results[0].value;
  expect(producer.replaceTrack).toHaveBeenLastCalledWith({ track: mockStreams[0].getAudioTracks()[0] });
  expect(mockStreams[0].release).not.toHaveBeenCalled();
  expect(mockStreams[1].release).toHaveBeenCalledWith(true);
  expect(media.noiseMode).toBe('system');
  expect(media.inVoice).toBe(true);
});

test('replaceTrack rejection releases only the unused replacement stream', async () => {
  await act(async () => media.joinVoice());
  const producer = await (mockTransport.produce as jest.Mock).mock.results[0].value;
  producer.replaceTrack.mockRejectedValueOnce(new Error('sender failed'));
  await act(async () => media.selectNoiseMode('rnnoise'));
  expect(mockStreams[0].release).not.toHaveBeenCalled();
  expect(mockStreams[1].release).toHaveBeenCalledWith(true);
  expect(media.noiseMode).toBe('system');
  expect(media.inVoice).toBe(true);
});

test('rollback failure never releases the track still attached to the sender', async () => {
  await act(async () => media.joinVoice());
  const producer = await (mockTransport.produce as jest.Mock).mock.results[0].value;
  producer.replaceTrack.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rollback failed'));
  const { applyNoiseMode } = jest.requireMock('../src/features/media/microphone/microphoneNoise');
  applyNoiseMode.mockRejectedValueOnce(new Error('model failed'));
  await act(async () => media.selectNoiseMode('rnnoise'));
  expect(mockStreams[1].release).not.toHaveBeenCalled();
  expect(media.noiseError).toContain('原麦克风恢复失败');
  expect(media.inVoice).toBe(true);
  await act(async () => media.leaveVoice());
  expect(mockStreams[1].release).toHaveBeenCalledWith(true);
});

test('leaving during source replacement releases the late stream without changing mode', async () => {
  await act(async () => media.joinVoice());
  let resolve!: (stream: any) => void;
  mockGetUserMedia.mockImplementationOnce(() => new Promise(result => { resolve = result; }));
  let switching!: Promise<void>;
  await act(async () => { switching = media.selectNoiseMode('rnnoise'); });
  await act(async () => media.leaveVoice());
  const late = { getAudioTracks: () => [{ enabled: true }], release: jest.fn() };
  await act(async () => { resolve(late); await switching; });
  expect(late.release).toHaveBeenCalledWith(true);
  expect(media.inVoice).toBe(false);
  expect(media.noiseMode).toBe('system');
});

test('RNNoise processing faults fall back without leaving voice', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  await act(async () => media.selectNoiseMode('rnnoise'));
  const { getNoiseStatus } = jest.requireMock('../src/features/media/microphone/microphoneNoise');
  getNoiseStatus.mockResolvedValueOnce({ ...mockNoiseStatus(), error: 'unexpected format' });
  await act(async () => jest.advanceTimersByTime(1000));
  expect(media.noiseMode).toBe('system');
  expect(media.inVoice).toBe(true);
  expect(media.noiseError).toContain('unexpected format');
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', 'room');
});

test('repeated noise changes and leaving/rejoining do not create duplicate senders', async () => {
  await act(async () => media.joinVoice());
  await act(async () => media.selectNoiseMode('rnnoise'));
  await act(async () => media.selectNoiseMode('system'));
  await act(async () => media.selectNoiseMode('rnnoise'));
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  await act(async () => media.leaveVoice());
  await act(async () => media.joinVoice());
  expect(mockTransport.produce).toHaveBeenCalledTimes(2);
  expect(media.noiseMode).toBe('rnnoise');
  expect(media.inVoice).toBe(true);
});


test('lists audio devices and switches output/input', async () => {
  await act(async () => { await media.refreshAudioDevices(); });
  expect(media.audioOutputs.map((device) => device.id)).toEqual(['out-speaker', 'out-earpiece']);
  await act(async () => { await media.selectAudioOutput('out-earpiece'); });
  expect(media.selectedAudioOutputId).toBe('out-earpiece');
  await act(async () => { await media.selectAudioInput('default'); });
  expect(media.selectedAudioInputId).toBe('default');
  expect(media.audioDeviceError).toBeNull();
});

test('feature callbacks remain stable across unrelated state renders without leaving voice', async () => {
  await act(async () => media.joinVoice());
  const previous={join:media.joinVoice,leave:media.leaveVoice,watch:media.watchScreen,input:media.selectAudioInput,noise:media.selectNoiseMode};
  const listeners=socket.on.mock.calls.length;
  await act(async () => media.setMemberVolume('peer1',0.4));
  await act(async () => handlers.get('voice:members-updated')!([{socketId:'peer1',username:'Peer',isMuted:false}]));
  expect(media.joinVoice).toBe(previous.join);
  expect(media.leaveVoice).toBe(previous.leave);
  expect(media.watchScreen).toBe(previous.watch);
  expect(media.selectAudioInput).toBe(previous.input);
  expect(media.selectNoiseMode).toBe(previous.noise);
  expect(socket.on.mock.calls.length).toBe(listeners);
  expect(media.inVoice).toBe(true);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave','room');
  expect(mockTransport.close).not.toHaveBeenCalled();
});

test('healthy media and mute survive a delayed CONNECT through multiple signal outages without republishing', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  await act(async () => media.toggleMute());
  mockTransport.connectionState = 'connected';
  const existingTimers = jest.getTimerCount();
  for (let cycle = 0; cycle < 3; cycle++) {
    await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
    await act(async () => jest.advanceTimersByTime(8_000));
    expect(media.inVoice).toBe(true);
    expect(media.isMuted).toBe(true);
    await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
    await act(async () => jest.advanceTimersByTime(8_000));
  }
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBeLessThanOrEqual(existingTimers);
});

test('healthy receiver-only media survives a delayed CONNECT without starting capture', async () => {
  jest.useFakeTimers();
  await act(async () => handlers.get('ms:new-producer')!({producerId: 'screen-video', peerId: 'desktop', kind: 'video', appData: {type: 'screen'}}));
  await act(async () => media.watchScreen('desktop'));
  const screen = media.remoteScreen;
  mockTransport.connectionState = 'connected';
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => jest.advanceTimersByTime(8_000));
  expect(media.remoteScreen).toBe(screen);
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  expect(media.isWatchingScreen).toBe(true);
  expect(media.connectionState).toBe('connected');
  expect(mockTransport.produce).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
});

test.each(['close-first', 'new-first'] as const)('watch intent follows a codec fallback in the same publication: %s', async order => {
  const announce = (id: string, attempt: number) => handlers.get('ms:new-producer')!({
    producerId: id, peerId: 'desktop', kind: 'video',
    appData: { type: 'screen', shareSessionId: 'share-1', publicationAttempt: attempt },
  });
  await act(async () => announce('screen-old', 1));
  await act(async () => media.watchScreen('desktop'));
  const closed = () => handlers.get('ms:producer-closed')!({
    peerId: 'desktop', producerId: 'screen-old', sourceType: 'screen',
    shareSessionId: 'share-1', replacing: true,
  });
  if (order === 'close-first') await act(async () => closed());
  await act(async () => announce('screen-new', 2));
  if (order === 'new-first') await act(async () => closed());
  expect(media.isWatchingScreen).toBe(true);
  expect(media.remoteScreen?.consumerId).toBe('consumer-screen-new');
  expect(mockGetUserMedia).not.toHaveBeenCalled();
  expect(mockTransport.produce).not.toHaveBeenCalled();
});

test('cancel watching wins over a pending codec replacement, and another share never auto starts', async () => {
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen-old', peerId: 'desktop', kind: 'video', appData: { type: 'screen', shareSessionId: 'share-1', publicationAttempt: 1 } }));
  await act(async () => media.watchScreen('desktop'));
  await act(async () => handlers.get('ms:producer-closed')!({ producerId: 'screen-old', peerId: 'desktop', sourceType: 'screen', shareSessionId: 'share-1', replacing: true }));
  await act(async () => media.stopWatchingScreen());
  socket.emit.mockClear();
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen-new', peerId: 'desktop', kind: 'video', appData: { type: 'screen', shareSessionId: 'share-1', publicationAttempt: 2 } }));
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'another-share', peerId: 'desktop', kind: 'video', appData: { type: 'screen', shareSessionId: 'share-2', publicationAttempt: 1 } }));
  expect(media.isWatchingScreen).toBe(false);
  expect(media.remoteScreen).toBeNull();
  expect(socket.emit.mock.calls.filter(([event]: any[]) => event === 'ms:consume')).toHaveLength(0);
});

test.each([{ session: 'older-share', attempt: 1 }, { session: 'share-1', attempt: 1 }])('late screen audio from $session attempt $attempt cannot attach to a replacement', async stale => {
  const announce = (id: string, type: string, session: string, attempt: number) => handlers.get('ms:new-producer')!({
    producerId: id, peerId: 'desktop', kind: type === 'screen' ? 'video' : 'audio',
    appData: { type, shareSessionId: session, publicationAttempt: attempt },
  });
  await act(async () => announce('screen-new', 'screen', 'share-1', 2));
  await act(async () => announce('audio-new', 'screen-audio', 'share-1', 2));
  await act(async () => media.watchScreen('desktop'));
  const newAudio = mockConsumers.get('audio-new');
  await act(async () => announce('audio-old', 'screen-audio', stale.session, stale.attempt));
  await act(async () => handlers.get('ms:producer-closed')!({ producerId: 'audio-old', peerId: 'desktop', sourceType: 'screen-audio' }));
  expect(mockConsumers.has('audio-old')).toBe(false);
  expect(newAudio.close).not.toHaveBeenCalled();
  expect(media.remoteScreen?.consumerId).toBe('consumer-screen-new');
  expect(media.isWatchingScreen).toBe(true);
});

test.each(['send', 'receive'] as const)('retaining media for signal loss never cancels the independent %s failure deadline', async side => {
  jest.useFakeTimers();
  mockSeparateTransports = true;
  mockTransport.connectionState = 'connected';
  mockReceiveTransport.connectionState = 'connected';
  await act(async () => media.joinVoice());
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  await act(async () => jest.advanceTimersByTime(500));
  const failed = side === 'send' ? mockTransport : mockReceiveTransport;
  const changed = failed.on.mock.calls.find(([event]) => event === 'connectionstatechange')![1];
  await act(async () => { failed.connectionState = 'failed'; changed('failed'); });
  await act(async () => jest.advanceTimersByTime(7000));
  expect(media.inVoice).toBe(true);
  await act(async () => jest.advanceTimersByTime(499));
  expect(media.inVoice).toBe(true);
  await act(async () => jest.advanceTimersByTime(1));
  expect(media.inVoice).toBe(false);
  expect(media.connectionState).toBe('failed');
  expect(mockTransport.close).toHaveBeenCalledTimes(1);
  expect(mockReceiveTransport.close).toHaveBeenCalledTimes(1);
  expect(InCallManager.stop).toHaveBeenCalledTimes(1);
});

test('leaving during a healthy-media signal outage wins over a later recovery', async () => {
  jest.useFakeTimers();
  await act(async () => media.joinVoice());
  mockTransport.connectionState = 'connected';
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('transport close'); });
  await act(async () => media.leaveVoice());
  await act(async () => jest.advanceTimersByTime(8_000));
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  expect(media.inVoice).toBe(false);
  expect(socket.emit).toHaveBeenCalledWith('voice:leave', 'room');
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
});

function configureIceRecovery(supported = true) {
  mockSeparateTransports = true;
  const emit = socket.emit.getMockImplementation();
  const requests: Array<{ payload: any; reply: (response: any) => void }> = [];
  let respond = (payload: any, reply: (response: any) => void) => reply({
    ok: true, version: 1, transportId: payload.transportId, sessionId: payload.sessionId,
    sequence: payload.sequence, iceParameters: { usernameFragment: 'new-fragment', password: 'synthetic-password' },
  });
  socket.emit.mockImplementation((event: string, payload: any, reply: any) => {
    if (event === 'ms:create-transport') reply({
      id: payload.direction === 'send' ? (mockNextTransports?.send ?? mockTransport).id : (mockNextTransports?.receive ?? mockReceiveTransport).id,
      ...(supported ? { iceRestart: { version: 1, sessionId: `owner-${payload.direction}` } } : {}),
    });
    else if (event === 'ms:restart-ice') { requests.push({ payload, reply }); respond(payload, reply); }
    else emit(event, payload, reply);
  });
  const change = async (side: 'send' | 'receive', state: string) => {
    const transport = side === 'send' ? (mockNextTransports?.send ?? mockTransport) : (mockNextTransports?.receive ?? mockReceiveTransport);
    const changed = transport.on.mock.calls.find(([event]) => event === 'connectionstatechange')![1];
    await act(async () => { transport.connectionState = state; changed(state); });
  };
  const recovered = (side: 'send' | 'receive') => {
    const transport = side === 'send' ? (mockNextTransports?.send ?? mockTransport) : (mockNextTransports?.receive ?? mockReceiveTransport);
    transport.restartIce.mockImplementation(async () => {
      transport.connectionState = 'connected';
      transport.on.mock.calls.find(([event]) => event === 'connectionstatechange')![1]('connected');
    });
  };
  return { requests, change, recovered,
    respond: (next: typeof respond) => { respond = next; } };
}

test.each(['send', 'receive'] as const)('supported %s ICE recovery retains mute and existing media without republishing', async side => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => media.joinVoice());
  await act(async () => media.toggleMute());
  await ice.change('send', 'connected'); await ice.change('receive', 'connected');
  ice.recovered(side);
  await ice.change(side, 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  expect((side === 'send' ? mockTransport : mockReceiveTransport).restartIce).toHaveBeenCalledTimes(1);
  expect(media.inVoice).toBe(true);
  expect(media.isMuted).toBe(true);
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
  expect(mockTransport.close).not.toHaveBeenCalled();
});

test('healthy media and a signal-only outage never issue an ICE request', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('receive', 'connected');
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  await act(async () => jest.advanceTimersByTime(8000));
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  expect(ice.requests).toHaveLength(0);
  expect(media.inVoice).toBe(true);
});

test.each(['old-server', 'missing-method'] as const)('%s retains the legacy 7.5 second failure deadline', async mode => {
  jest.useFakeTimers();
  const ice = configureIceRecovery(mode !== 'old-server');
  const restart = mockTransport.restartIce;
  if (mode === 'missing-method') (mockTransport as any).restartIce = undefined;
  try {
    await act(async () => media.joinVoice());
    await ice.change('send', 'connected');
    await ice.change('send', 'failed');
    await act(async () => jest.advanceTimersByTime(7499));
    expect(media.inVoice).toBe(true);
    await act(async () => jest.advanceTimersByTime(1));
    expect(media.inVoice).toBe(false);
    expect(ice.requests).toHaveLength(0);
  } finally { mockTransport.restartIce = restart; }
});

test('leaving cancels an in-flight ICE ACK before a new join and ignores its late reply', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  await act(async () => media.leaveVoice());
  await act(async () => media.joinVoice());
  const { payload, reply } = ice.requests[0];
  await act(async () => reply({ ok: true, version: 1, ...payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  await act(async () => jest.advanceTimersByTime(22000));
  expect(mockTransport.restartIce).not.toHaveBeenCalled();
  expect(ice.requests).toHaveLength(1);
  expect(media.inVoice).toBe(true);
  expect(mockTransport.produce).toHaveBeenCalledTimes(2);
});

test('only a qualified recovered signal session resumes a pending media recovery', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('receive', 'connected');
  await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  const first = ice.requests[0];
  await act(async () => first.reply({ ok: true, version: 1, ...first.payload, iceParameters: { usernameFragment: 'stale', password: 'stale-password' } }));
  await act(async () => jest.advanceTimersByTime(8000));
  expect(mockTransport.restartIce).not.toHaveBeenCalled();
  expect(ice.requests).toHaveLength(1);
  expect(media.inVoice).toBe(true);
  ice.recovered('send');
  ice.respond((payload, reply) => reply({ ok: true, version: 1, ...payload, iceParameters: { usernameFragment: 'current', password: 'current-password' } }));
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  await act(async () => jest.advanceTimersByTime(2000));
  expect(ice.requests).toHaveLength(2);
  expect(ice.requests[1].payload.sequence).toBe(first.payload.sequence);
  expect(mockTransport.restartIce).toHaveBeenCalledTimes(1);
  expect(media.inVoice).toBe(true);
});

test('a fresh signal session cancels media recovery and cannot apply an old ICE reply', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  const first = ice.requests[0];
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  await act(async () => { socket.connected = true; socket.id = 'fresh-session'; socket.recovered = false; handlers.get('connect')!(); });
  await act(async () => first.reply({ ok: true, version: 1, ...first.payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  await act(async () => jest.advanceTimersByTime(22000));
  expect(media.inVoice).toBe(false);
  expect(mockTransport.restartIce).not.toHaveBeenCalled();
  expect(ice.requests).toHaveLength(1);
});

test('receiver-only ICE recovery keeps the selected screen and does not acquire a microphone', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  const screen = media.remoteScreen;
  await ice.change('receive', 'connected');
  ice.recovered('receive');
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  expect(media.remoteScreen).toBe(screen);
  expect(media.isWatchingScreen).toBe(true);
  expect(mockGetUserMedia).not.toHaveBeenCalled();
  expect(mockTransport.produce).not.toHaveBeenCalled();
});

test('terminal ICE failure uses normal voice teardown without an automatic join', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond((_payload, reply) => reply({ ok: false, code: 'SESSION_NOT_CURRENT' }));
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  expect(media.inVoice).toBe(false);
  expect(media.connectionState).toBe('failed');
  expect(socket.emit).toHaveBeenCalledWith('voice:leave', 'room');
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
});

test('another healthy transport and signal recovery do not mark an active ICE round connected', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('receive', 'connected');
  await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  await ice.change('receive', 'connected');
  expect(media.connectionState).toBe('connecting');
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  await act(async () => { socket.connected = true; socket.recovered = true; handlers.get('connect')!(); });
  expect(media.connectionState).toBe('connecting');
  // Native connected may fire synchronously inside restartIce, before its
  // promise settles. Only the completed round may clear the UI recovery state.
  ice.recovered('send');
  ice.respond((payload, reply) => reply({ ok: true, version: 1, ...payload, iceParameters: { usernameFragment: 'current', password: 'current-password' } }));
  await act(async () => jest.advanceTimersByTime(2500));
  await act(async () => jest.advanceTimersByTime(2000));
  expect(mockTransport.restartIce).toHaveBeenCalledTimes(1);
  expect(media.connectionState).toBe('connected');
});

test('a transport that naturally reconnects within the grace window needs no ICE request', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('send', 'disconnected');
  await act(async () => jest.advanceTimersByTime(1499));
  await ice.change('send', 'connected');
  await act(async () => jest.advanceTimersByTime(22000));
  expect(ice.requests).toHaveLength(0);
  expect(media.inVoice).toBe(true);
  expect(media.connectionState).toBe('connected');
});

test('an ICE recovery waiting for signal still expires at its 20 second deadline', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('receive', 'connected');
  await act(async () => { socket.connected = false; handlers.get('disconnect')!('ping timeout'); });
  await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(19999));
  expect(media.inVoice).toBe(true);
  expect(ice.requests).toHaveLength(0);
  await act(async () => jest.advanceTimersByTime(1));
  expect(media.inVoice).toBe(false);
  expect(media.connectionState).toBe('failed');
  expect(mockTransport.close).toHaveBeenCalledTimes(1);
  expect(mockReceiveTransport.close).toHaveBeenCalledTimes(1);
});

test('changing rooms cancels an old ICE ACK without restarting transport or joining the new room', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected'); await ice.change('send', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  const first = ice.requests[0];
  await act(async () => { currentRoom = 'next-room'; renderer.update(<Harness />); });
  await act(async () => first.reply({ ok: true, version: 1, ...first.payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  await act(async () => jest.advanceTimersByTime(22000));
  expect(media.inVoice).toBe(false);
  expect(ice.requests).toHaveLength(1);
  expect(mockTransport.restartIce).not.toHaveBeenCalled();
  expect(mockTransport.produce).toHaveBeenCalledTimes(1);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:join', 'next-room', expect.anything());
});

test('viewer-only explicit stop cancels ICE and releases transports while preserving available shares', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  const shares = media.availableScreens;
  await ice.change('receive', 'connected'); await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  const old = ice.requests[0];
  await act(async () => media.stopWatchingScreen());
  expect(mockTransport.close).toHaveBeenCalledTimes(1);
  expect(mockReceiveTransport.close).toHaveBeenCalledTimes(1);
  expect(media.availableScreens).toBe(shares);
  expect(media.isWatchingScreen).toBe(false);
  expect(media.connectionState).toBe('idle');
  await act(async () => old.reply({ ok: true, version: 1, ...old.payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  await act(async () => jest.advanceTimersByTime(22000));
  expect(mockReceiveTransport.restartIce).not.toHaveBeenCalled();
  expect(ice.requests).toHaveLength(1);
  expect(media.error).toBeNull();
  expect(media.isWatchingScreen).toBe(false);
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});

test('a manual watch after cancelling viewer-only ICE owns new transports and ignores the old ACK', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected'); await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  const old = ice.requests[0];
  await act(async () => media.stopWatchingScreen());
  const nextSend = { ...mockTransport, id: 'next-send', on: jest.fn(), close: jest.fn(), restartIce: jest.fn(async (_options: unknown) => {}) };
  const nextReceive = { ...mockReceiveTransport, id: 'next-receive', connectionState: 'connected', on: jest.fn(), close: jest.fn(), restartIce: jest.fn(async (_options: unknown) => {}) };
  mockNextTransports = { send: nextSend, receive: nextReceive };
  await act(async () => media.watchScreen('desktop'));
  expect(nextReceive.on).toHaveBeenCalledWith('connectionstatechange', expect.any(Function));
  await act(async () => old.reply({ ok: true, version: 1, ...old.payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  await act(async () => jest.advanceTimersByTime(22000));
  expect(mockReceiveTransport.restartIce).not.toHaveBeenCalled();
  expect(nextReceive.restartIce).not.toHaveBeenCalled();
  expect(nextReceive.close).not.toHaveBeenCalled();
  expect(media.remoteScreen?.socketId).toBe('desktop');
  expect(media.isWatchingScreen).toBe(true);
  expect(media.error).toBeNull();
  expect(ice.requests).toHaveLength(1);
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});

test('explicit watch cancellation does not tear down voice while its ICE recovery is pending', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  await act(async () => media.joinVoice());
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected'); await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  await act(async () => media.stopWatchingScreen());
  expect(media.inVoice).toBe(true);
  expect(media.isWatchingScreen).toBe(false);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockReceiveTransport.close).not.toHaveBeenCalled();
  expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
});

test('internal viewer switching keeps its transport ownership during an ICE recovery', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  ice.respond(() => {});
  for (const peerId of ['desktop', 'other'])
    await act(async () => handlers.get('ms:new-producer')!({ producerId: `screen-${peerId}`, peerId, kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected'); await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  await act(async () => media.watchScreen('other'));
  expect(media.remoteScreen?.socketId).toBe('other');
  expect(media.isWatchingScreen).toBe(true);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockReceiveTransport.close).not.toHaveBeenCalled();
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});

test.each(['send', 'receive'] as const)('watching then joining voice reuses transports with working %s ICE recovery', async side => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected');
  const screen = media.remoteScreen;
  const created = socket.emit.mock.calls.filter(([event]: any[]) => event === 'ms:create-transport').length;
  await act(async () => media.joinVoice());
  await ice.change('send', 'connected');
  ice.recovered(side);
  await ice.change(side, 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  expect((side === 'send' ? mockTransport : mockReceiveTransport).restartIce).toHaveBeenCalledTimes(1);
  expect(socket.emit.mock.calls.filter(([event]: any[]) => event === 'ms:create-transport')).toHaveLength(created);
  expect(media.inVoice).toBe(true);
  expect(media.isWatchingScreen).toBe(true);
  expect(media.remoteScreen).toBe(screen);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockReceiveTransport.close).not.toHaveBeenCalled();
  expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
});

test('reusing viewer transports for voice retains the existing ICE sequence and recovery ownership', async () => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  await act(async () => handlers.get('ms:new-producer')!({ producerId: 'screen', peerId: 'desktop', kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected');
  ice.recovered('receive');
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  await act(async () => media.joinVoice());
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(2);
  expect(ice.requests.map(({ payload }) => payload.sequence)).toEqual([1, 2]);
  expect(mockReceiveTransport.restartIce).toHaveBeenCalledTimes(2);
  expect(media.isWatchingScreen).toBe(true);
  expect(media.inVoice).toBe(true);
});

test.each(['producer-closed', 'user-left'] as const)('remote %s retires a viewer ICE session before another manual watch starts at sequence one', async closedBy => {
  jest.useFakeTimers();
  const ice = configureIceRecovery();
  for (const peerId of ['desktop', 'other'])
    await act(async () => handlers.get('ms:new-producer')!({ producerId: `screen-${peerId}`, peerId, kind: 'video', appData: { type: 'screen' } }));
  await act(async () => media.watchScreen('desktop'));
  await ice.change('receive', 'connected');
  ice.recovered('receive');
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests).toHaveLength(1);
  ice.respond(() => {});
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  const old = ice.requests[1];
  expect(old.payload.sequence).toBe(2);
  await act(async () => {
    if (closedBy === 'producer-closed')
      handlers.get('ms:producer-closed')!({ producerId: 'screen-desktop', peerId: 'desktop', sourceType: 'screen' });
    else handlers.get('voice:user-left')!({ socketId: 'desktop' });
  });
  expect(mockReceiveTransport.close).toHaveBeenCalledTimes(1);
  expect(mockTransport.close).toHaveBeenCalledTimes(1);
  expect(media.isWatchingScreen).toBe(false);
  expect(media.availableScreens.map(source => source.socketId)).toEqual(['other']);
  const nextSend = { ...mockTransport, id: 'next-send', on: jest.fn(), close: jest.fn(), restartIce: jest.fn(async (_options: unknown) => {}) };
  const nextReceive = { ...mockReceiveTransport, id: 'next-receive', on: jest.fn(), close: jest.fn(), restartIce: jest.fn(async (_options: unknown) => {}) };
  mockNextTransports = { send: nextSend, receive: nextReceive };
  await act(async () => media.watchScreen('other'));
  await act(async () => old.reply({ ok: true, version: 1, ...old.payload, iceParameters: { usernameFragment: 'late', password: 'late-password' } }));
  expect(mockReceiveTransport.restartIce).toHaveBeenCalledTimes(1);
  expect(nextReceive.restartIce).not.toHaveBeenCalled();
  await ice.change('receive', 'connected');
  ice.recovered('receive');
  ice.respond((payload, reply) => reply({ ok: true, version: 1, ...payload, iceParameters: { usernameFragment: 'current', password: 'current-password' } }));
  await ice.change('receive', 'failed');
  await act(async () => jest.advanceTimersByTime(0));
  expect(ice.requests.map(({ payload }) => [payload.transportId, payload.sequence])).toEqual([
    ['voice-receive', 1], ['voice-receive', 2], ['next-receive', 1],
  ]);
  expect(nextReceive.restartIce).toHaveBeenCalledTimes(1);
  expect(media.remoteScreen?.socketId).toBe('other');
  expect(media.isWatchingScreen).toBe(true);
  expect(media.inVoice).toBe(false);
  expect(media.error).toBeNull();
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});
