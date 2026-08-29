import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useMobileMedia } from '../src/useMobileMedia';

const mockConsumers = new Map<string, any>();
const mockTransport = {
  on: jest.fn(), close: jest.fn(),
  produce: jest.fn(async () => ({ close: jest.fn(), pause: jest.fn(), resume: jest.fn() })),
  consume: jest.fn(async (params: any) => {
    const consumer = { id: params.id, track: { enabled: true, _setVolume: jest.fn() }, close: jest.fn(), on: jest.fn() };
    mockConsumers.set(params.producerId, consumer);
    return consumer;
  }),
};
jest.mock('mediasoup-client', () => ({ Device: { factory: async () => ({
  load: async () => {}, rtpCapabilities: {},
  createSendTransport: () => mockTransport, createRecvTransport: () => mockTransport,
}) } }));
jest.mock('react-native-incall-manager', () => ({ start: jest.fn(), stop: jest.fn(), setForceSpeakerphoneOn: jest.fn(), setSpeakerphoneOn: jest.fn(), stopProximitySensor: jest.fn(), turnScreenOn: jest.fn(), setKeepScreenOn: jest.fn() }));
jest.mock('react-native-webrtc', () => ({
  MediaStream: class { release = jest.fn(); },
  mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [{}], release: jest.fn() }) },
}));

import { PermissionsAndroid } from 'react-native';
const application = (producerId: string, peerId = 'peer1') => ({ producerId, peerId, kind: 'audio', appData: { type: 'application-audio', label: 'Music' } });
const microphone = (producerId: string, peerId = 'peer1') => ({ producerId, peerId, kind: 'audio', appData: { type: 'mic' } });
let media: ReturnType<typeof useMobileMedia>;
let renderer: TestRenderer.ReactTestRenderer;
let socket: any;
let handlers: Map<string, (...args: any[]) => any>;
let existing: any[];
let delayedConsume: (() => void) | undefined;
let holdConsume: boolean;

beforeEach(async () => {
  jest.clearAllMocks(); mockConsumers.clear(); existing = []; delayedConsume = undefined; holdConsume = false;
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  handlers = new Map();
  socket = {
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
  function Harness() { media = useMobileMedia(socket, 'room'); return null; }
  await act(async () => { renderer = TestRenderer.create(<Harness />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); jest.restoreAllMocks(); });

test('does not receive application audio before joining voice', async () => {
  await act(async () => { await handlers.get('ms:new-producer')!(application('app1')); });
  expect(mockConsumers.size).toBe(0);
  expect(media.applicationAudioShares).toEqual([]);
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
