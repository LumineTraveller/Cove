import TestRenderer, { act } from 'react-test-renderer';
import {
  screenCodecCandidates,
  useMobileScreenShare,
} from '../src/features/media/screen/useMobileScreenShare';

const mockGetDisplayMedia = jest.fn();
const mockCreatePlayback = jest.fn();
const mockReleaseScreenVideo = jest.fn(async (_sessionId: string) => {});
const mockGetEncoderCapabilities = jest.fn();
const mockPrepareScreenVideo = jest.fn();
const mockWaitForTransportClosed = jest.fn(async (_sessionId: string) => {});
let mockAudioError: (event: any) => void;
let mockEncoderError: (event: any) => void;
let mockEncoderReady: (event: any) => void;
jest.mock('react-native-webrtc', () => ({
  mediaDevices: {
    getDisplayMedia: (...args: any[]) => mockGetDisplayMedia(...args),
  },
}));
jest.mock('../src/features/media/screen/screenSharing', () => ({
  canShareMobileScreen: true,
  canShareScreenAudio: true,
  createPlaybackAudio: (sessionId: string) => mockCreatePlayback(sessionId),
  releaseScreenVideo: (sessionId: string) => mockReleaseScreenVideo(sessionId),
  getScreenEncoderCapabilities: () => mockGetEncoderCapabilities(),
  prepareScreenVideo: () => mockPrepareScreenVideo(),
  waitForScreenTransportClosed: (sessionId: string) =>
    mockWaitForTransportClosed(sessionId),
  onScreenEncoderError: (callback: any) => {
    mockEncoderError = callback;
    return { remove: jest.fn() };
  },
  onScreenEncoderReady: (callback: any) => {
    mockEncoderReady = callback;
    return { remove: jest.fn() };
  },
  onScreenAudioError: (callback: any) => {
    mockAudioError = callback;
    return { remove: jest.fn() };
  },
}));
let share: ReturnType<typeof useMobileScreenShare>;
let renderer: TestRenderer.ReactTestRenderer;
let socket: any,
  screen: any,
  systemAudio: any,
  outgoing: any,
  device: any,
  inVoice: any;
let events: Map<string, any>, transportEvents: Map<string, any>;
let producers: any[];
let outgoings: any[];
function makeTransport(id: string, suffix = '') {
  const handlers = new Map();
  const value: any = {
    id,
    closed: false,
    handlers,
    close: jest.fn(() => {
      value.closed = true;
    }),
    on: jest.fn((name, handler) => {
      handlers.set(name, handler);
      transportEvents.set(name, handler);
    }),
    produce: jest.fn(async options => {
      const producer: any = {
        id: `${options.appData.type}${suffix}`,
        closed: false,
        close: jest.fn(() => {
          producer.closed = true;
        }),
        pause: jest.fn(),
        resume: jest.fn(),
        on: jest.fn(),
        options,
      };
      producers.push(producer);
      return producer;
    }),
  };
  return value;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetEncoderCapabilities.mockResolvedValue({
    h264Hardware: true,
    h264HardwareProfiles: ['42e01f'],
    codecs: ['h264', 'vp8', 'av1', 'vp9'],
  });
  mockPrepareScreenVideo.mockResolvedValue({ sessionId: 'playback1' });
  mockWaitForTransportClosed.mockResolvedValue(undefined);
  events = new Map();
  transportEvents = new Map();
  producers = [];
  outgoings = [];
  screen = {
    getVideoTracks: () => [{ readyState: 'live', onended: undefined }],
    release: jest.fn(),
  };
  // Keep the track stable so the OS ended callback can be exercised.
  const screenTrack = screen.getVideoTracks()[0];
  screen.getVideoTracks = () => [screenTrack];
  systemAudio = {
    getAudioTracks: () => [{ kind: 'audio' }],
    release: jest.fn(),
  };
  mockGetDisplayMedia.mockResolvedValue(screen);
  mockCreatePlayback.mockResolvedValue({
    stream: systemAudio,
    sessionId: 'playback1',
  });
  outgoing = makeTransport('screen-transport');
  device = {
    current: {
      rtpCapabilities: {
        codecs: [
          { mimeType: 'video/AV1' },
          {
            mimeType: 'video/H264',
            parameters: { 'profile-level-id': '42e01f' },
          },
          { mimeType: 'video/VP8' },
        ],
      },
      createSendTransport: jest.fn(params => {
        const value = outgoings.length
          ? makeTransport(params.id, `-${outgoings.length + 1}`)
          : outgoing;
        outgoings.push(value);
        return value;
      }),
    },
  };
  inVoice = { current: true };
  let allocations = 0;
  socket = {
    connected: true,
    id: 'self',
    on: jest.fn((name, callback) => events.set(name, callback)),
    off: jest.fn(),
    emit: jest.fn((name, data, callback) => {
      if (!callback) return;
      if (name === 'ms:screen-sharing-capabilities')
        callback({ dedicatedTransport: true });
      else if (name === 'ms:create-transport')
        callback({
          id:
            ++allocations === 1
              ? 'screen-transport'
              : `screen-transport-${allocations}`,
          purpose: 'screen',
        });
      else callback({});
    }),
  };
  function Harness() {
    share = useMobileScreenShare(socket, device, inVoice);
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  jest.useRealTimers();
});

test('video-only sharing has no audio capture and never reuses the microphone transport', async () => {
  await act(async () => {
    expect(await share.startScreenShare(false)).toBe(true);
  });
  expect(mockCreatePlayback).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith(
    'ms:create-transport',
    { direction: 'send', purpose: 'screen' },
    expect.any(Function),
  );
  expect(producers).toHaveLength(1);
  expect(producers[0].options.appData.type).toBe('screen');
  expect(producers[0].options.codec.mimeType).toBe('video/H264');
  expect(producers[0].options).not.toHaveProperty('encodings');
  expect(mockGetDisplayMedia).toHaveBeenCalledWith({
    android: { resolutionScale: 1 },
  });
  expect(share.sharingScreenAudio).toBe(false);
  await act(async () => share.stopScreenShare());
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(outgoing.close).toHaveBeenCalledTimes(1);
  expect(socket.emit).not.toHaveBeenCalledWith(
    'voice:leave',
    expect.anything(),
  );
});

test.each([1, 0.75, 0.5] as const)(
  'passes the selected native capture scale %s without adding FPS or changing the protocol',
  async scale => {
    await act(async () => {
      expect(await share.startScreenShare(false, scale)).toBe(true);
    });
    expect(mockGetDisplayMedia).toHaveBeenCalledWith({
      android: { resolutionScale: scale },
    });
    expect(producers[0].options.appData).toEqual({
      type: 'screen',
      client: 'android',
      syncGroup: expect.any(String),
    });
    expect(producers[0].options).not.toHaveProperty('encodings');
    expect(mockCreatePlayback).not.toHaveBeenCalled();
  },
);

test('an active capture keeps its scale until stopped and a new capture uses the next choice', async () => {
  await act(async () => {
    expect(await share.startScreenShare(false, 0.5)).toBe(true);
  });
  await act(async () => {
    expect(await share.startScreenShare(false, 0.75)).toBe(false);
  });
  expect(mockGetDisplayMedia).toHaveBeenCalledTimes(1);
  expect(mockGetDisplayMedia).toHaveBeenLastCalledWith({
    android: { resolutionScale: 0.5 },
  });
  await act(async () => share.stopScreenShare());
  await act(async () => {
    expect(await share.startScreenShare(false, 0.75)).toBe(true);
  });
  expect(mockGetDisplayMedia).toHaveBeenLastCalledWith({
    android: { resolutionScale: 0.75 },
  });
});

test('playback audio and video share one RTP sync group, independently of mic mute/NS', async () => {
  await act(async () => {
    await share.startScreenShare(true);
  });
  expect(producers).toHaveLength(2);
  expect(
    device.current.createSendTransport.mock.calls[0][0].additionalSettings,
  ).toEqual({
    coveScreenVideo: 'playback1',
    coveScreenVideoAttempt: 1,
    coveScreenAudio: 'playback1',
  });
  expect(producers[0].options.streamId).toBe(producers[1].options.streamId);
  expect(producers[1].options.track).toEqual({ kind: 'audio' });
  expect(producers[1].options.codecOptions.opusDtx).toBe(false);
  expect(share.sharingScreenAudio).toBe(true);
  await act(async () =>
    events.get('screen:demand')({
      producerId: 'screen',
      sourceType: 'screen',
      active: true,
      viewerCount: 2,
    }),
  );
  expect(producers[0].resume).toHaveBeenCalledTimes(1);
  expect(producers[1].resume).not.toHaveBeenCalled();
  expect(share.screenViewerCount).toBe(2);
  await act(async () => share.stopScreenShare());
  expect(mockReleaseScreenVideo).toHaveBeenCalledWith('playback1');
  expect(systemAudio.release).toHaveBeenCalledWith(false);
});

test('OS authorization cancellation leaves voice and existing transports alone', async () => {
  mockGetDisplayMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
  await act(async () => {
    expect(await share.startScreenShare(true)).toBe(false);
  });
  expect(share.screenSharingError).toBeNull();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(inVoice.current).toBe(true);
});

test('late permission is released after cancel, with no overlapping system authorization', async () => {
  let grant!: (stream: any) => void;
  mockGetDisplayMedia.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        grant = resolve;
      }),
  );
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(false);
  });
  await act(async () => {
    share.stopScreenShare();
    expect(await share.startScreenShare(false)).toBe(false);
  });
  await act(async () => {
    grant(screen);
    expect(await pending).toBe(false);
  });
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(share.screenSharingBusy).toBe(false);
});

test('capture/producer failure cleans up sharing without removing user from voice', async () => {
  outgoing.produce.mockRejectedValueOnce(new Error('publish failed'));
  await act(async () => {
    expect(await share.startScreenShare(true)).toBe(false);
  });
  expect(share.screenSharingError).toContain('publish failed');
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(systemAudio.release).toHaveBeenCalledWith(false);
  expect(mockReleaseScreenVideo).toHaveBeenCalledWith('playback1');
  expect(outgoing.close).toHaveBeenCalled();
  expect(inVoice.current).toBe(true);
  expect(socket.emit).not.toHaveBeenCalledWith(
    'voice:leave',
    expect.anything(),
  );
});

test('system stop and native playback failure stop sharing, not the call', async () => {
  await act(async () => {
    await share.startScreenShare(true);
  });
  await act(async () => screen.getVideoTracks()[0].onended());
  expect(share.sharingScreen).toBe(false);
  expect(inVoice.current).toBe(true);
  await act(async () => {
    await share.startScreenShare(true);
  });
  await act(async () =>
    mockAudioError({ sessionId: 'playback1', message: 'AudioRecord failed' }),
  );
  expect(share.screenSharingError).toContain('AudioRecord failed');
  expect(share.sharingScreen).toBe(false);
  expect(inVoice.current).toBe(true);
});

test('old server capability timeout never sends a destructive second send request', async () => {
  jest.useFakeTimers();
  socket.emit.mockImplementation(() => {});
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(false);
  });
  await act(async () => {
    jest.advanceTimersByTime(4000);
    expect(await pending).toBe(false);
  });
  expect(share.screenSharingError).toContain('请更新服务端');
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
});

test('an incompatible H264 profile with no software codec fails before opening capture', async () => {
  device.current.rtpCapabilities.codecs = [
    { mimeType: 'video/H264', parameters: { 'profile-level-id': '640c1f' } },
  ];
  await act(async () => {
    expect(await share.startScreenShare(false)).toBe(false);
  });
  expect(share.screenSharingError).toContain('没有可用的屏幕视频编码');
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(producers).toHaveLength(0);
  expect(inVoice.current).toBe(true);
});

test('late server transport is closed when leaving voice during allocation', async () => {
  let allocate!: (data: any) => void;
  socket.emit.mockImplementation((name: string, _data: any, callback: any) => {
    if (name === 'ms:screen-sharing-capabilities')
      callback({ dedicatedTransport: true });
    if (name === 'ms:create-transport') allocate = callback;
  });
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(false);
  });
  await act(async () => {
    inVoice.current = false;
    share.stopScreenShare();
  });
  await act(async () => {
    allocate({ id: 'late', purpose: 'screen' });
    await pending;
  });
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', {
    transportId: 'late',
  });
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
});

test('restart waits for native connection disposal before preparing another audio factory', async () => {
  await act(async () => {
    await share.startScreenShare(true);
  });
  let disposed!: () => void;
  mockReleaseScreenVideo.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        disposed = resolve;
      }),
  );
  await act(async () => share.stopScreenShare());
  mockGetDisplayMedia.mockClear();
  mockCreatePlayback.mockClear();
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(true);
  });
  expect(mockGetDisplayMedia).not.toHaveBeenCalled();
  expect(mockCreatePlayback).not.toHaveBeenCalled();
  expect(share.screenSharingBusy).toBe(true);
  await act(async () => {
    disposed();
    expect(await pending).toBe(true);
  });
  expect(mockCreatePlayback).toHaveBeenCalledTimes(1);
});

test('a timed-out transport allocation is closed even when its server ack arrives later', async () => {
  jest.useFakeTimers();
  let allocate!: (data: any) => void;
  socket.emit.mockImplementation((name: string, _data: any, callback: any) => {
    if (name === 'ms:screen-sharing-capabilities')
      callback({ dedicatedTransport: true });
    if (name === 'ms:create-transport') allocate = callback;
  });
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(false);
  });
  await act(async () => {
    jest.advanceTimersByTime(15000);
    expect(await pending).toBe(false);
  });
  await act(async () => allocate({ id: 'expired', purpose: 'screen' }));
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', {
    transportId: 'expired',
  });
  expect(inVoice.current).toBe(true);
});

test.each(['unavailable', 'probe-error'])(
  'uses a negotiated software codec when H264 hardware is %s',
  async mode => {
    if (mode === 'probe-error')
      mockGetEncoderCapabilities.mockRejectedValueOnce(
        new Error('probe failed'),
      );
    else
      mockGetEncoderCapabilities.mockResolvedValueOnce({
        h264Hardware: false,
        h264HardwareProfiles: [],
        codecs: ['vp8', 'av1'],
      });
    await act(async () => {
      expect(await share.startScreenShare(false)).toBe(true);
    });
    expect(producers[0].options.codec.mimeType).toBe('video/VP8');
    expect(share.collectScreenEncodingDiagnostics()?.ready).toBeUndefined();
    expect(
      device.current.createSendTransport.mock.calls[0][0].additionalSettings,
    ).toEqual({ coveScreenVideo: 'playback1', coveScreenVideoAttempt: 1 });
  },
);

test('H264 negotiation failure closes its transport and explicitly retries VP8 without recapturing', async () => {
  outgoing.produce.mockRejectedValueOnce(new Error('Unsupported codec H264'));
  await act(async () => {
    expect(await share.startScreenShare(true, 1)).toBe(true);
  });
  expect(outgoing.close).toHaveBeenCalledTimes(1);
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', {
    transportId: 'screen-transport',
  });
  expect(mockWaitForTransportClosed).toHaveBeenCalledWith('playback1');
  expect(mockWaitForTransportClosed.mock.invocationCallOrder[0]).toBeLessThan(
    device.current.createSendTransport.mock.invocationCallOrder[1],
  );
  expect(outgoings[1].produce.mock.calls[0][0].codec.mimeType).toBe(
    'video/VP8',
  );
  expect(mockGetDisplayMedia).toHaveBeenCalledTimes(1);
  expect(mockCreatePlayback).toHaveBeenCalledTimes(1);
  expect(mockReleaseScreenVideo).not.toHaveBeenCalled();
  expect(outgoings[1].produce.mock.calls[0][0]).not.toHaveProperty('encodings');
  expect(share.screenSharingError).toContain('已切换为 VP8');
  expect(share.collectScreenEncodingDiagnostics()?.attempts).toEqual([
    { codec: 'H264', outcome: 'failed', reason: 'negotiation' },
    { codec: 'VP8', outcome: 'selected' },
  ]);
  expect(inVoice.current).toBe(true);
});

test('native failure during pending produce releases a late producer and uses a new attempt', async () => {
  let late!: (producer: any) => void;
  outgoing.produce.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        late = resolve;
      }),
  );
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(false);
  });
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      stage: 'create',
      reason: 'unavailable',
    });
    expect(await pending).toBe(true);
  });
  const stale = { id: 'late-h264', close: jest.fn(), closed: false };
  await act(async () => {
    late(stale);
  });
  expect(stale.close).toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith('ms:close-producer', {
    producerId: 'late-h264',
  });
  expect(outgoings[1].produce.mock.calls[0][0].codec.mimeType).toBe(
    'video/VP8',
  );
  expect(share.sharingScreen).toBe(true);
});

test('first-frame H264 init failure after sharing starts rebuilds both screen producers, retaining audio capture', async () => {
  await act(async () => {
    expect(await share.startScreenShare(true)).toBe(true);
  });
  const first = producers.slice();
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      stage: 'init',
      reason: 'status',
      code: 'ERROR',
    });
  });
  first.forEach(producer => expect(producer.close).toHaveBeenCalledTimes(1));
  expect(producers).toHaveLength(4);
  expect(producers[2].options.codec.mimeType).toBe('video/VP8');
  expect(producers[2].options.streamId).toBe(producers[3].options.streamId);
  expect(mockCreatePlayback).toHaveBeenCalledTimes(1);
  expect(systemAudio.release).not.toHaveBeenCalled();
  expect(screen.release).not.toHaveBeenCalled();
  expect(share.sharingScreenAudio).toBe(true);
  expect(inVoice.current).toBe(true);
  expect(socket.emit).not.toHaveBeenCalledWith(
    'voice:leave',
    expect.anything(),
  );
});

test('paused sharing needs no encoder-ready event; late previous-attempt events cannot affect the fallback', async () => {
  await act(async () => {
    expect(await share.startScreenShare(false)).toBe(true);
  });
  expect(producers[0].pause).toHaveBeenCalled();
  expect(share.collectScreenEncodingDiagnostics()?.ready).toBeUndefined();
  await act(async () => {
    mockEncoderReady({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      implementation: 'OMX.qcom.video.encoder.avc',
      hardwareAccelerated: true,
      width: 1080,
      height: 2400,
      targetFps: 30,
    });
  });
  expect(
    share.collectScreenEncodingDiagnostics()?.ready?.hardwareAccelerated,
  ).toBe(true);
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      stage: 'encode',
      reason: 'status',
      code: 'ERROR',
    });
  });
  expect(share.collectScreenEncodingDiagnostics()?.ready).toBeUndefined();
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'VP8',
      stage: 'create',
      reason: 'unavailable',
    });
    mockEncoderReady({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'VP8',
      implementation: 'libvpx',
      hardwareAccelerated: false,
      width: 1080,
      height: 2400,
      targetFps: 30,
    });
  });
  expect(outgoings).toHaveLength(2);
  expect(share.collectScreenEncodingDiagnostics()?.ready).toBeUndefined();
});

test('cancellation while waiting for native disposal prevents another codec allocation', async () => {
  let disposed!: () => void;
  mockWaitForTransportClosed.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        disposed = resolve;
      }),
  );
  await act(async () => {
    await share.startScreenShare(false);
  });
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      stage: 'init',
      reason: 'status',
    });
  });
  await act(async () => {
    share.stopScreenShare();
  });
  await act(async () => {
    disposed();
  });
  expect(outgoings).toHaveLength(1);
  expect(mockReleaseScreenVideo).toHaveBeenCalledTimes(1);
  expect(share.sharingScreen).toBe(false);
  expect(share.screenSharingBusy).toBe(false);
});

test('playback producer failure is not misclassified as a video-codec fallback', async () => {
  outgoing.produce
    .mockImplementationOnce(async (options: any) => {
      const producer = {
        id: 'screen',
        close: jest.fn(),
        pause: jest.fn(),
        on: jest.fn(),
        options,
      };
      producers.push(producer);
      return producer;
    })
    .mockRejectedValueOnce(new Error('Unsupported audio codec'));
  await act(async () => {
    expect(await share.startScreenShare(true)).toBe(false);
  });
  expect(outgoings).toHaveLength(1);
  expect(mockWaitForTransportClosed).not.toHaveBeenCalled();
  expect(mockReleaseScreenVideo).toHaveBeenCalledWith('playback1');
  expect(inVoice.current).toBe(true);
});

test('preserves the negotiated H264 profile and skips hardware profiles that cannot match it', () => {
  const high = {
    mimeType: 'video/H264',
    parameters: { 'profile-level-id': '640c1f', 'packetization-mode': 1 },
  };
  const baseline = {
    mimeType: 'video/H264',
    parameters: { 'profile-level-id': '42e015', 'packetization-mode': 1 },
  };
  const av1 = { mimeType: 'video/AV1' },
    vp8 = { mimeType: 'video/VP8' },
    vp9 = { mimeType: 'video/VP9' };
  const capability = {
    h264Hardware: true,
    h264HardwareProfiles: ['42e01f'],
    codecs: ['h264', 'vp8', 'av1', 'vp9'],
  };
  expect(
    screenCodecCandidates([high, av1, baseline, vp9, vp8] as any, capability)
      .codecs,
  ).toEqual([baseline, vp8, av1, vp9]);
  expect(screenCodecCandidates([high, vp8] as any, capability)).toEqual({
    codecs: [vp8],
    reason: 'hardware-profile-incompatible',
  });
});

test('native failure in the publish-resolution microtask window still advances to the next codec', async () => {
  outgoing.produce.mockImplementationOnce(async (options: any) => {
    const producer = {
      id: 'screen',
      closed: false,
      close: jest.fn(),
      pause: jest.fn(),
      options,
      on: jest.fn(() => {
        Promise.resolve().then(() =>
          mockEncoderError({
            sessionId: 'playback1',
            attemptId: 1,
            codec: 'H264',
            stage: 'init',
            reason: 'status',
          }),
        );
      }),
    };
    producers.push(producer);
    return producer;
  });
  await act(async () => {
    expect(await share.startScreenShare(false)).toBe(true);
  });
  expect(outgoings).toHaveLength(2);
  expect(share.collectScreenEncodingDiagnostics()?.selectedCodec).toBe('VP8');
  expect(share.sharingScreen).toBe(true);
});

test('observable errors exhaust each common codec once and then release the screen session', async () => {
  await act(async () => {
    expect(await share.startScreenShare(true)).toBe(true);
  });
  for (const [attemptId, codec] of [
    [1, 'H264'],
    [2, 'VP8'],
    [3, 'AV1'],
  ] as const) {
    await act(async () => {
      mockEncoderError({
        sessionId: 'playback1',
        attemptId,
        codec,
        stage: 'create',
        reason: 'unavailable',
      });
    });
  }
  expect(outgoings).toHaveLength(3);
  expect(share.sharingScreen).toBe(false);
  expect(screen.release).toHaveBeenCalledWith(true);
  expect(systemAudio.release).toHaveBeenCalledWith(false);
  expect(mockReleaseScreenVideo).toHaveBeenCalledTimes(1);
  expect(
    share
      .collectScreenEncodingDiagnostics()
      ?.attempts.map(attempt => attempt.codec),
  ).toEqual(['H264', 'VP8', 'AV1']);
  expect(inVoice.current).toBe(true);
});

test('stopping while disconnected queues the exact screen producer and transport IDs for cleanup', async () => {
  await act(async () => {
    await share.startScreenShare(true);
  });
  socket.emit.mockClear();
  socket.connected = false;
  await act(async () => {
    share.stopScreenShare();
  });
  expect(socket.emit).toHaveBeenCalledWith('ms:close-producer', {
    producerId: 'screen',
  });
  expect(socket.emit).toHaveBeenCalledWith('ms:close-producer', {
    producerId: 'screen-audio',
  });
  expect(socket.emit).toHaveBeenCalledWith('ms:close-screen-transport', {
    transportId: 'screen-transport',
  });
  expect(socket.emit).not.toHaveBeenCalledWith(
    'voice:leave',
    expect.anything(),
  );
});

test('a native failure observed during recoverable disconnection resumes its fallback after reconnect', async () => {
  await act(async () => {
    await share.startScreenShare(false);
  });
  socket.connected = false;
  await act(async () => {
    mockEncoderError({
      sessionId: 'playback1',
      attemptId: 1,
      codec: 'H264',
      stage: 'init',
      reason: 'status',
    });
  });
  expect(outgoings).toHaveLength(1);
  socket.connected = true;
  await act(async () => {
    events.get('connect')();
  });
  expect(outgoings).toHaveLength(2);
  expect(share.collectScreenEncodingDiagnostics()?.selectedCodec).toBe('VP8');
  expect(share.sharingScreen).toBe(true);
});

test('cancelling pending playback waits for the late stream to detach its track before releasing the native session', async () => {
  let captured!: (value: any) => void;
  mockCreatePlayback.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        captured = resolve;
      }),
  );
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = share.startScreenShare(true);
  });
  await act(async () => {
    share.stopScreenShare();
  });
  expect(mockReleaseScreenVideo).not.toHaveBeenCalled();
  await act(async () => {
    expect(await share.startScreenShare(false)).toBe(false);
    captured({ stream: systemAudio, sessionId: 'playback1' });
    expect(await pending).toBe(false);
  });
  expect(systemAudio.release).toHaveBeenCalledWith(false);
  expect(mockReleaseScreenVideo).toHaveBeenCalledWith('playback1');
  expect(systemAudio.release.mock.invocationCallOrder[0]).toBeLessThan(
    mockReleaseScreenVideo.mock.invocationCallOrder[0],
  );
  expect(device.current.createSendTransport).not.toHaveBeenCalled();
  expect(inVoice.current).toBe(true);
});
