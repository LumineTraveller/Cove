import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessedMicrophone, connectMicrophoneGain, setMicrophoneGain, syncMicrophoneMute } from '../src/microphoneProcessing';

function fixture(failure = '') {
  const stopped: string[] = [];
  const events: unknown[][] = [];
  const rawTrack = { readyState: 'live', stop() { stopped.push('raw'); } };
  const outputTrack = { readyState: failure === 'ended' ? 'ended' : 'live', contentHint: '', stop() { stopped.push('output'); } };
  const raw = { getAudioTracks: () => [rawTrack], getTracks: () => [rawTrack] } as unknown as MediaStream;
  const stream = { getAudioTracks: () => failure === 'missing-track' ? [] : [outputTrack], getTracks: () => [outputTrack] };
  const param = () => ({ value: 1,
    cancelAndHoldAtTime(t: number) { events.push(['hold', t]); },
    setValueAtTime(v: number, t: number) { events.push(['set', v, t]); },
    linearRampToValueAtTime(v: number, t: number) { events.push(['ramp', v, t]); },
  });
  const node = () => ({ connect(target: unknown) { if (failure === 'connect') throw Error(failure); return target; } });
  let closed = 0;
  const context = {
    state: failure === 'suspended' ? 'suspended' : 'running', currentTime: 5,
    createMediaStreamSource(input: MediaStream) { assert.equal(input, raw); if (failure === 'source') throw Error(failure); return node(); },
    createMediaStreamDestination: () => ({ ...node(), stream, channelCount: 2 }),
    createGain: () => ({ ...node(), gain: param(), context }),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    resume: () => failure === 'timeout' ? new Promise<void>(() => {}) : failure === 'resume' ? Promise.reject(Error(failure)) : Promise.resolve(),
    close: async () => { closed++; },
  } as unknown as AudioContext;
  return { raw, stream, context, rawTrack, outputTrack, stopped, events, closed: () => closed };
}

for (const failure of ['constructor', 'source', 'connect', 'resume', 'suspended', 'ended', 'missing-track', 'timeout']) {
  test(`microphone falls back safely after ${failure} failure`, async () => {
    const f = fixture(failure);
    const result = await createProcessedMicrophone(f.raw, 1, () => {
      if (failure === 'constructor') throw Error(failure);
      return f.context;
    });
    assert.equal(result.stream, f.raw);
    assert.equal(result.context, null);
    assert.equal(result.gain, null);
    assert.equal(f.stopped.includes('raw'), false);
    assert.equal(f.closed(), failure === 'constructor' ? 0 : 1);
    assert.equal(f.stopped.includes('output'), !['constructor', 'source'].includes(failure));
  });
}

test('a usable graph returns its live speech track without disposing capture', async () => {
  const f = fixture();
  const result = await createProcessedMicrophone(f.raw, 0.5, () => f.context);
  assert.equal(result.stream, f.stream);
  assert.equal(result.context, f.context);
  assert.equal(result.gain?.gain.value, 0.5);
  assert.equal(f.outputTrack.contentHint, 'speech');
  assert.deepEqual(f.stopped, []);
  assert.equal(f.closed(), 0);
});

test('initial volume and subsequent ramps clamp invalid and out-of-range values', () => {
  for (const [volume, expected] of [[-1, 0], [0, 0], [0.5, 0.5], [2, 2], [9, 2], [NaN, 1], [Infinity, 1]]) {
    const f = fixture();
    const source = { connect: (target: unknown) => target } as AudioNode;
    const gain = connectMicrophoneGain(f.context, source, {} as AudioNode, volume);
    assert.equal(gain.gain.value, expected);
    setMicrophoneGain(gain, volume);
    assert.deepEqual(f.events, [['hold', 5], ['set', expected, 5], ['ramp', expected, 5.02]]);
  }
});

test('volume changes, device replacement and fallback cannot override mute', () => {
  for (const selfMuted of [false, true]) {
    for (const forceMuted of [false, true]) {
      for (const volume of [0, 0.5, 1, 2]) {
        const calls: string[] = [];
        const producer = { pause() { calls.push('pause'); }, resume() { calls.push('resume'); } };
        syncMicrophoneMute(producer, selfMuted, forceMuted, volume);
        assert.deepEqual(calls, [selfMuted || forceMuted || volume === 0 ? 'pause' : 'resume']);
      }
    }
  }
});

test('producer track follows volume mute state so a replacement track can resume', () => {
  const track = { enabled: false } as MediaStreamTrack;
  const calls: string[] = [];
  const producer = {
    track,
    pause() { calls.push('pause'); },
    resume() { calls.push('resume'); },
  };

  syncMicrophoneMute(producer, false, false, 1);
  assert.equal(track.enabled, true);
  syncMicrophoneMute(producer, false, false, 0);
  assert.equal(track.enabled, false);
  syncMicrophoneMute(producer, false, false, 1);
  assert.equal(track.enabled, true);
  assert.deepEqual(calls, ['resume', 'pause', 'resume']);
});
