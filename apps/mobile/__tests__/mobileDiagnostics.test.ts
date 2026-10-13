import {
  normalizeMobileDiagnostics,
  videoBitrate,
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
