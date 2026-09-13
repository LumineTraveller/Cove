import assert from 'node:assert/strict';
import test from 'node:test';
import { requestEchoCancelledMicrophone, microphoneEchoWarning } from '../src/microphoneEcho';
import { acquireMicrophoneCandidate } from '../src/microphoneCandidate';

function input(echo: boolean | string | undefined) {
  let stops = 0;
  const track = { readyState: 'live', getSettings: () => ({ echoCancellation: echo, noiseSuppression: false }), stop: () => { stops++; } };
  return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, stops: () => stops };
}
const unsupported = () => Object.assign(new Error('unsupported'), { name: 'OverconstrainedError', constraint: 'echoCancellation' });

for (const mode of ['system', 'rnnoise'] as const) {
  test(`${mode} requests full-system AEC before any downstream processing`, async () => {
    const mic = input('all');
    const raw = await requestEchoCancelledMicrophone('usb', mode, async ({ audio }) => {
      const constraints = audio as MediaTrackConstraints;
      assert.deepEqual(constraints.echoCancellation, { exact: 'all' });
      assert.deepEqual(constraints.deviceId, { exact: 'usb' });
      assert.deepEqual(constraints.noiseSuppression, mode === 'rnnoise' ? { exact: false } : true);
      assert.equal(constraints.autoGainControl, true);
      return mic.stream;
    });
    assert.equal(raw, mic.stream);
    assert.equal(microphoneEchoWarning(raw), null);
    assert.equal(mic.stops(), 0);
  });

  test(`${mode} falls back only to explicitly enabled native AEC and reports limited coverage`, async () => {
    const mic = input(true);
    const requests: MediaTrackConstraints[] = [];
    const raw = await requestEchoCancelledMicrophone('usb', mode, async ({ audio }) => {
      requests.push(audio as MediaTrackConstraints);
      if (requests.length === 1) throw unsupported();
      return mic.stream;
    });
    assert.equal(raw, mic.stream);
    assert.deepEqual(requests[1], { ...requests[0], echoCancellation: { exact: true } });
    assert.match(microphoneEchoWarning(raw)!, /未启用全系统回声消除/);
  });
}

test('old engines ignoring all or rejecting its IDL type cannot silently claim full AEC', async () => {
  for (const rejection of ['ignored', 'TypeError']) {
    const ignored = input(true), fallback = input(true);
    let calls = 0;
    const raw = await requestEchoCancelledMicrophone('default', 'rnnoise', async () => {
      if (++calls === 1) {
        if (rejection === 'TypeError') throw new TypeError('old DOM constraint type');
        return ignored.stream;
      }
      return fallback.stream;
    });
    assert.equal(calls, 2);
    assert.equal(raw, fallback.stream);
    assert.equal(ignored.stops(), rejection === 'ignored' ? 1 : 0);
  }
});

test('capture with AEC disabled is stopped, never passed to RNNoise as a safe mic', async () => {
  const raw = input(false);
  await assert.rejects(requestEchoCancelledMicrophone('default', 'rnnoise', async () => raw.stream), /未提供启用回声消除/);
  assert.equal(raw.stops(), 1);
});

test('permissions, missing/busy devices and unrelated constraints do not trigger AEC retries', async () => {
  for (const [name, constraint] of [['NotAllowedError', ''], ['NotFoundError', ''], ['NotReadableError', ''], ['OverconstrainedError', 'deviceId'], ['OverconstrainedError', 'noiseSuppression']]) {
    let calls = 0;
    const error = Object.assign(new Error(name), { name, constraint });
    await assert.rejects(requestEchoCancelledMicrophone('usb', 'rnnoise', async () => { calls++; throw error; }), (value) => value === error);
    assert.equal(calls, 1);
  }
});

test('failed compatibility capture propagates instead of returning an unprotected track', async () => {
  let calls = 0;
  await assert.rejects(requestEchoCancelledMicrophone('default', 'rnnoise', async () => {
    if (++calls === 1) throw unsupported();
    throw new Error('fallback failed');
  }), /fallback failed/);
  assert.equal(calls, 2);
});

test('a capture that resolves after timeout is stopped', async () => {
  const raw = input('all');
  let complete!: (stream: MediaStream) => void;
  const pending = requestEchoCancelledMicrophone('default', 'rnnoise', () => new Promise((resolve) => { complete = resolve; }), 15);
  await assert.rejects(pending, /采集超时/);
  complete(raw.stream);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(raw.stops(), 1);
});

test('limited AEC warning survives RNNoise success and RNNoise fallback', async () => {
  const raw = input(true);
  const process = async () => ({ stream: raw.stream, context: null, gain: null });
  const success = await acquireMicrophoneCandidate('rnnoise', async () => raw.stream, process);
  assert.match(success.warning!, /未启用全系统回声消除/);
  const fallback = await acquireMicrophoneCandidate('rnnoise', async () => raw.stream, async (_, mode) => {
    if (mode === 'rnnoise') throw Error('model failed');
    return process();
  });
  assert.equal(fallback.mode, 'system');
  assert.match(fallback.warning!, /已回退到系统降噪/);
  assert.match(fallback.warning!, /未启用全系统回声消除/);
});
