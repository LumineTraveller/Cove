import {
  normalizeMobileDiagnostics,
  videoBitrate,
  videoDiagnosticSample,
  videoEncodingPerformance,
} from '../src/features/media/diagnostics/mobileDiagnostics';
const stage = { inVoice: false, watching: true, sharing: false };
const report = (bytes: number, at: number) =>
  normalizeMobileDiagnostics(
    {
      stage,
      stats: {
        send: null,
        screenSend: null,
        receive: new Map([
          [
            'v',
            {
              id: 'private-track',
              type: 'inbound-rtp',
              kind: 'video',
              codecId: 'c',
              bytesReceived: bytes,
              framesPerSecond: 29.8,
            },
          ],
          ['c', { id: 'c', type: 'codec', mimeType: 'video/VP8' }],
        ]),
      },
      server: null,
    },
    at,
  );
it('exports only finite media metrics and codec metadata from a real Map-shaped report', () => {
  const output = normalizeMobileDiagnostics(
    {
      stage,
      stats: {
        send: null,
        screenSend: null,
        receive: new Map([
          [
            'v',
            {
              type: 'inbound-rtp',
              kind: 'video',
              framesPerSecond: 30,
              frameWidth: 640,
              bytesReceived: 200,
              jitter: NaN,
              accessToken: 'private-token',
              address: '10.2.3.4',
              label: 'private-name',
            },
          ],
          [
            'p',
            {
              type: 'candidate-pair',
              currentRoundTripTime: 0.012,
              localCandidateId: 'private-id',
            },
          ],
          [
            'c',
            { type: 'local-candidate', address: '192.168.4.9', port: 1234 },
          ],
        ]),
      },
      server: {
        timestamp: 10,
        transports: {
          receive: { stats: [{ bitrate: 50, address: 'private-ip' }] },
        },
        authToken: 'secret',
      },
    },
    1,
  );
  expect(output.samples).toHaveLength(2);
  expect(output.samples[0].values).toEqual({
    framesPerSecond: 30,
    frameWidth: 640,
    bytesReceived: 200,
  });
  expect(output.samples[1].values.currentRoundTripTime).toBe(0.012);
  const text = JSON.stringify(output);
  expect(text).not.toMatch(/private|secret|192\.168|10\.2\.3/);
  expect(output.server).toEqual({
    timestamp: 10,
    transports: { receive: { stats: [{ bitrate: 50 }] } },
  });
});

const sendingReport = (
  frames: number,
  time: number,
  at: number,
  sequence = 1,
) =>
  normalizeMobileDiagnostics(
    {
      stage: { inVoice: true, watching: true, sharing: true },
      stats: {
        send: [],
        receive: [
          {
            type: 'inbound-rtp',
            kind: 'video',
            framesPerSecond: 12,
            bytesReceived: 999999,
          },
        ],
        screenSend: [
          { id: 'screen-codec', type: 'codec', mimeType: 'video/H264' },
          {
            type: 'outbound-rtp',
            kind: 'video',
            codecId: 'screen-codec',
            framesEncoded: frames,
            totalEncodeTime: time,
            bytesSent: frames * 100,
            encoderImplementation: 'OMX.qcom.video.encoder.avc',
            powerEfficientEncoder: false,
            qualityLimitationReason: 'cpu',
          },
        ],
      },
      server: null,
      screenEncoder: {
        sequence,
        selectionReason: 'hardware-h264',
        hardwareProbe: true,
        selectedCodec: 'H264',
        attempts: [{ codec: 'H264', outcome: 'selected' }],
      },
    },
    at,
  );

it('selects screenSend while sharing even when the phone is also receiving another video', () => {
  const output = sendingReport(30, 0.15, 1000);
  expect(videoDiagnosticSample(output)?.transport).toBe('screenSend');
  expect(videoDiagnosticSample(output)?.codec).toBe('video/H264');
  expect(videoBitrate(output, sendingReport(60, 0.3, 2000))).toBe(24000);
  output.samples = output.samples.filter(
    sample => sample.transport !== 'screenSend',
  );
  expect(videoDiagnosticSample(output)).toBeUndefined();
});

it('exports only allowlisted actual encoder metadata and excludes native session identifiers and raw errors', () => {
  const output = sendingReport(30, 0.15, 1000);
  expect(videoDiagnosticSample(output)).toMatchObject({
    encoderImplementation: 'OMX.qcom.video.encoder.avc',
    powerEfficientEncoder: false,
    qualityLimitationReason: 'cpu',
  });
  const safe = normalizeMobileDiagnostics(
    {
      stage,
      stats: {
        send: [],
        receive: [],
        screenSend: [
          {
            type: 'outbound-rtp',
            kind: 'video',
            encoderImplementation: 'private-encoder\nsecret',
            qualityLimitationReason: 'private-label',
            powerEfficientEncoder: 'true',
            address: '192.168.1.1',
          },
        ],
      },
      server: null,
      screenEncoder: {
        sequence: 2,
        selectedCodec: 'VP8',
        selectionReason: 'fallback',
        hardwareProbe: true,
        sessionId: 'private-session',
        attempts: [
          {
            codec: 'H264',
            outcome: 'failed',
            reason: 'native-init',
            code: 'ERROR',
            message: 'private error secret',
          },
          { codec: 'VP8', outcome: 'selected', code: 'PrivateAccessToken' },
          {
            codec: 'AV1',
            outcome: 'failed',
            reason: 'native-create',
            code: 'IllegalStateException',
          },
        ],
        ready: {
          sessionId: 'private-session',
          attemptId: 1,
          codec: 'H264',
          implementation: 'OMX.qcom.video.encoder.avc',
          hardwareAccelerated: true,
          width: 1080,
          height: 2400,
          targetFps: 30,
          encoderMaxFramerate: 30,
        },
      },
    },
    1,
  );
  expect(safe.screenEncoder?.attempts[0]).toEqual({
    codec: 'H264',
    outcome: 'failed',
    reason: 'native-init',
    code: 'ERROR',
  });
  expect(safe.screenEncoder?.ready?.encoderMaxFramerate).toBe(30);
  expect(safe.screenEncoder?.attempts[1]).not.toHaveProperty('code');
  expect(safe.screenEncoder?.attempts[2].code).toBe('IllegalStateException');
  expect(safe.samples[0]).not.toHaveProperty('encoderImplementation');
  expect(safe.samples[0]).not.toHaveProperty('powerEfficientEncoder');
  expect(JSON.stringify(safe)).not.toMatch(
    /private|secret|192\.168|sessionId|attemptId/,
  );
});

it('computes encoding FPS and ms per frame from deltas without treating paused or reset counters as failures', () => {
  expect(
    videoEncodingPerformance(
      sendingReport(10, 0.05, 1000),
      sendingReport(70, 0.35, 3000),
    ),
  ).toEqual({ framesPerSecond: 30, encodeMsPerFrame: 5 });
  expect(
    videoEncodingPerformance(
      sendingReport(10, 0.05, 1000),
      sendingReport(10, 0.05, 2000),
    ),
  ).toEqual({ framesPerSecond: 0, encodeMsPerFrame: null });
  expect(
    videoEncodingPerformance(
      sendingReport(70, 0.35, 1000),
      sendingReport(10, 0.05, 2000),
    ).framesPerSecond,
  ).toBeNull();
  expect(
    videoEncodingPerformance(
      sendingReport(10, 0.35, 1000),
      sendingReport(70, 0.05, 2000),
    ).encodeMsPerFrame,
  ).toBeNull();
  expect(
    videoEncodingPerformance(
      sendingReport(10, 0.05, 1000),
      sendingReport(70, 0.35, 1100),
    ).framesPerSecond,
  ).toBeNull();
  expect(
    videoEncodingPerformance(
      sendingReport(10, 0.05, 1000, 1),
      sendingReport(70, 0.35, 2000, 2),
    ).framesPerSecond,
  ).toBeNull();
  expect(
    videoBitrate(
      sendingReport(10, 0.05, 1000, 1),
      sendingReport(70, 0.35, 2000, 2),
    ),
  ).toBeNull();
});

it('uses the RTP sample timestamps so a delayed server diagnostic response does not skew encoder rate', () => {
  const first = sendingReport(10, 0.05, 1000),
    second = sendingReport(40, 0.2, 4000);
  videoDiagnosticSample(first)!.values.timestamp = 1000;
  videoDiagnosticSample(second)!.values.timestamp = 2000;
  expect(videoEncodingPerformance(first, second).framesPerSecond).toBe(30);
  expect(videoBitrate(first, second)).toBe(24000);
  videoDiagnosticSample(second)!.values.timestamp = 900;
  expect(videoEncodingPerformance(first, second).framesPerSecond).toBeNull();
  expect(videoBitrate(first, second)).toBeNull();
});
it('computes bitrate from elapsed cumulative counters and refuses counter reset or duplicate time', () => {
  expect(videoBitrate(report(1000, 1000), report(2000, 2000))).toBe(8000);
  expect(videoBitrate(report(2000, 1000), report(1000, 2000))).toBeNull();
  expect(videoBitrate(report(1000, 1000), report(2000, 1000))).toBeNull();
  expect(videoBitrate(null, report(1000, 1000))).toBeNull();
});
it('keeps unsupported statistics absent and preserves valid zero FPS', () => {
  expect(
    normalizeMobileDiagnostics(
      {
        stage,
        stats: { send: false, receive: 'bad', screenSend: undefined },
        server: null,
      },
      0,
    ).samples,
  ).toEqual([]);
  expect(report(0, 1).samples[0].codec).toBe('video/VP8');
  const zero = normalizeMobileDiagnostics(
    {
      stage,
      stats: {
        send: [],
        screenSend: [],
        receive: [
          {
            type: 'inbound-rtp',
            kind: 'video',
            framesPerSecond: 0,
            id: 'omit',
          },
        ],
      },
      server: {},
    },
    0,
  );
  expect(zero.samples[0].values.framesPerSecond).toBe(0);
  expect(JSON.stringify(zero)).not.toContain('omit');
});
