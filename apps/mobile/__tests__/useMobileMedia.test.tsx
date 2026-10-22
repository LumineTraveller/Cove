
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
  connectionState: undefined as string | undefined,
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
  connectionState: undefined as string | undefined,
  on: jest.fn(), close: jest.fn(),
};
jest.mock('mediasoup-client', () => ({ Device: { factory: async () => ({
  load: async () => {}, rtpCapabilities: {},
  createSendTransport: () => mockTransport,
  createRecvTransport: () => mockSeparateTransports ? mockReceiveTransport : mockTransport,
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
