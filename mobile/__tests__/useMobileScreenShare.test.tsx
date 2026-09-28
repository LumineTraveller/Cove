import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useMobileScreenShare } from '../src/useMobileScreenShare';

const mockGetDisplayMedia = jest.fn();
const mockCreatePlayback = jest.fn();
const mockReleasePlayback = jest.fn(async (_sessionId: string) => {});
let mockAudioError: (event: any) => void;
jest.mock('react-native-webrtc', () => ({ mediaDevices: { getDisplayMedia: (...args: any[]) => mockGetDisplayMedia(...args) } }));
jest.mock('../src/screenSharing', () => ({
  canShareMobileScreen: true, canShareScreenAudio: true,
  createPlaybackAudio: () => mockCreatePlayback(), releasePlaybackAudio: (sessionId: string) => mockReleasePlayback(sessionId),
  onScreenAudioError: (callback: any) => { mockAudioError = callback; return { remove: jest.fn() }; },
}));
let share: ReturnType<typeof useMobileScreenShare>;
let renderer: TestRenderer.ReactTestRenderer;
let socket: any, screen: any, systemAudio: any, outgoing: any, device: any, inVoice: any;
let events: Map<string, any>, transportEvents: Map<string, any>;
let producers: any[];

beforeEach(async () => {
  jest.clearAllMocks();
  events = new Map(); transportEvents = new Map(); producers = [];
  screen = { getVideoTracks: () => [{ readyState: 'live', onended: undefined }], release: jest.fn() };
  // Keep the track stable so the OS ended callback can be exercised.
  const screenTrack = screen.getVideoTracks()[0]; screen.getVideoTracks = () => [screenTrack];
  systemAudio = { getAudioTracks: () => [{ kind: 'audio' }], release: jest.fn() };
  mockGetDisplayMedia.mockResolvedValue(screen);
  mockCreatePlayback.mockResolvedValue({ stream: systemAudio, sessionId: 'playback1' });
  outgoing = { id: 'screen-transport', close: jest.fn(), on: jest.fn((name, handler) => transportEvents.set(name, handler)),
    produce: jest.fn(async (options) => {
      const producer = { id: options.appData.type, close: jest.fn(), pause: jest.fn(), resume: jest.fn(), on: jest.fn(), options };
      producers.push(producer); return producer;
    }),
  };
  device = { current: { rtpCapabilities: { codecs: [{ mimeType: 'video/AV1' }, { mimeType: 'video/H264' }] }, createSendTransport: jest.fn(() => outgoing) } };
  inVoice = { current: true };
  socket = { connected: true, id: 'self',
    on: jest.fn((name, callback) => events.set(name, callback)), off: jest.fn(),
    emit: jest.fn((name, data, callback) => {
      if (!callback) return;
      if (name === 'ms:screen-sharing-capabilities') callback({ dedicatedTransport: true });
      else if (name === 'ms:create-transport') callback({ id: 'screen-transport', purpose: 'screen' });
      else callback({});
    }),
  };
  function Harness() { share = useMobileScreenShare(socket, device, inVoice); return null; }
  await act(async () => { renderer = TestRenderer.create(<Harness />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); jest.useRealTimers(); });

test('video-only sharing has no audio capture and never reuses the microphone transport', async () => {
  await act(async () => { expect(await share.startScreenShare(false)).toBe(true); });
  expect(mockCreatePlayback).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith('ms:create-transport', { direction: 'send', purpose: 'screen' }, expect.any(Function));
  expect(producers).toHaveLength(1);
  expect(producers[0].options.appData.type).toBe('screen');
  expect(producers[0].options.codec.mimeType).toBe('video/AV1');
  expect(producers[0].options).not.toHaveProperty('encodings');
  expect(mockGetDisplayMedia).toHaveBeenCalledWith({});
  expect(share.sharingScreenAudio).toBe(false);
  await act(async () => share.stopScreenShare());
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(outgoing.close).toHaveBeenCalledTimes(1);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', expect.anything());
});

test('playback audio and video share one RTP sync group, independently of mic mute/NS', async () => {
  await act(async () => { await share.startScreenShare(true); });
  expect(producers).toHaveLength(2);
  expect(device.current.createSendTransport.mock.calls[0][0].additionalSettings).toEqual({ coveScreenAudio: 'playback1' });
  expect(producers[0].options.streamId).toBe(producers[1].options.streamId);
  expect(producers[1].options.track).toEqual({ kind: 'audio' });
  expect(producers[1].options.codecOptions.opusDtx).toBe(false);
  expect(share.sharingScreenAudio).toBe(true);
  await act(async () => events.get('screen:demand')({ producerId: 'screen', sourceType: 'screen', active: true, viewerCount: 2 }));
  expect(producers[0].resume).toHaveBeenCalledTimes(1);
  expect(producers[1].resume).not.toHaveBeenCalled();
  expect(share.screenViewerCount).toBe(2);
  await act(async () => share.stopScreenShare());
  expect(mockReleasePlayback).toHaveBeenCalledWith('playback1');
  expect(systemAudio.release).toHaveBeenCalledWith(false);
});

test('OS authorization cancellation leaves voice and existing transports alone', async () => {
  mockGetDisplayMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
  await act(async () => { expect(await share.startScreenShare(true)).toBe(false); });
  expect(share.screenSharingError).toBeNull();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(inVoice.current).toBe(true);
});

test('late permission is released after cancel, with no overlapping system authorization', async () => {
  let grant!: (stream: any) => void;
  mockGetDisplayMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  let pending!: Promise<boolean>;
  await act(async () => { pending = share.startScreenShare(false); });
  await act(async () => { share.stopScreenShare(); expect(await share.startScreenShare(false)).toBe(false); });
  await act(async () => { grant(screen); expect(await pending).toBe(false); });
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(share.screenSharingBusy).toBe(false);
});

test('capture/producer failure cleans up sharing without removing user from voice', async () => {
  outgoing.produce.mockRejectedValueOnce(new Error('encoding failed'));
  await act(async () => { expect(await share.startScreenShare(true)).toBe(false); });
  expect(share.screenSharingError).toContain('encoding failed');
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(systemAudio.release).toHaveBeenCalledWith(false);
  expect(mockReleasePlayback).toHaveBeenCalledWith('playback1');
  expect(outgoing.close).toHaveBeenCalled();
  expect(inVoice.current).toBe(true);
  expect(socket.emit).not.toHaveBeenCalledWith('voice:leave', expect.anything());
});

test('system stop and native playback failure stop sharing, not the call', async () => {
  await act(async () => { await share.startScreenShare(true); });
  await act(async () => screen.getVideoTracks()[0].onended());
  expect(share.sharingScreen).toBe(false);
  expect(inVoice.current).toBe(true);
  await act(async () => { await share.startScreenShare(true); });
  await act(async () => mockAudioError({ sessionId: 'playback1', message: 'AudioRecord failed' }));
  expect(share.screenSharingError).toContain('AudioRecord failed');
  expect(share.sharingScreen).toBe(false);
  expect(inVoice.current).toBe(true);
});

test('old server capability timeout never sends a destructive second send request', async () => {
  jest.useFakeTimers();
  socket.emit.mockImplementation(() => {});
  let pending!: Promise<boolean>;
  await act(async () => { pending = share.startScreenShare(false); });
  await act(async () => { jest.advanceTimersByTime(4000); expect(await pending).toBe(false); });
  expect(share.screenSharingError).toContain('请更新服务端');
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
});

test('AV1 is required and unsupported devices fail before opening screen capture', async () => {
  device.current.rtpCapabilities.codecs = [{ mimeType: 'video/H264' }];
  await act(async () => { expect(await share.startScreenShare(false)).toBe(false); });
  expect(share.screenSharingError).toContain('不支持 AV1');
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(producers).toHaveLength(0);
  expect(inVoice.current).toBe(true);
});

test('late server transport is closed when leaving voice during allocation', async () => {
  let allocate!: (data: any) => void;
  socket.emit.mockImplementation((name: string, _data: any, callback: any) => {
    if (name === 'ms:screen-sharing-capabilities') callback({ dedicatedTransport: true });
    if (name === 'ms:create-transport') allocate = callback;
  });
  let pending!: Promise<boolean>;
  await act(async () => { pending = share.startScreenShare(false); });
  await act(async () => { inVoice.current = false; share.stopScreenShare(); });
  await act(async () => { allocate({ id: 'late', purpose: 'screen' }); await pending; });
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', { transportId: 'late' });
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
});

test('restart waits for native connection disposal before preparing another audio factory', async () => {
  await act(async () => { await share.startScreenShare(true); });
  let disposed!: () => void;
  mockReleasePlayback.mockImplementationOnce(() => new Promise(resolve => { disposed = resolve; }));
  await act(async () => share.stopScreenShare());
  mockGetDisplayMedia.mockClear(); mockCreatePlayback.mockClear();
  let pending!: Promise<boolean>;
  await act(async () => { pending = share.startScreenShare(true); });
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(mockCreatePlayback).not.toHaveBeenCalled();
  expect(share.screenSharingBusy).toBe(true);
  await act(async () => { disposed(); expect(await pending).toBe(true); });
  expect(mockCreatePlayback).toHaveBeenCalledTimes(1);
});

test('a timed-out transport allocation is closed even when its server ack arrives later', async () => {
  jest.useFakeTimers();
  let allocate!: (data: any) => void;
  socket.emit.mockImplementation((name: string, _data: any, callback: any) => {
    if (name === 'ms:screen-sharing-capabilities') callback({ dedicatedTransport: true });
    if (name === 'ms:create-transport') allocate = callback;
  });
  let pending!: Promise<boolean>;
  await act(async () => { pending = share.startScreenShare(false); });
  await act(async () => { jest.advanceTimersByTime(15000); expect(await pending).toBe(false); });
  await act(async () => allocate({ id: 'expired', purpose: 'screen' }));
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', { transportId: 'expired' });
  expect(inVoice.current).toBe(true);
});
