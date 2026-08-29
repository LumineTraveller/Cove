import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAudioElementOutput,
  createRemoteAudioOutput,
  isMemberVoiceAudio,
  createMicrophoneConstraints,
  DEFAULT_AUDIO_DEVICE_ID,
  resolvedSinkId,
  toAudioDeviceOptions,
} from '../src/audioDevices';

test('default microphone constraints follow the Windows system device', () => {
  const constraints = createMicrophoneConstraints(DEFAULT_AUDIO_DEVICE_ID);
  assert.equal(constraints.deviceId, undefined);
  assert.equal(constraints.echoCancellation, true);
  assert.equal(constraints.noiseSuppression, true);
  assert.equal(constraints.channelCount, 1);
});

test('a selected microphone uses an exact device id', () => {
  const constraints = createMicrophoneConstraints('microphone-123');
  assert.deepEqual(constraints.deviceId, { exact: 'microphone-123' });
});

test('device options filter the Chromium default alias and provide private labels', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'mic-a', label: 'USB Microphone' },
    { kind: 'audioinput', deviceId: 'mic-b', label: '' },
    { kind: 'audiooutput', deviceId: 'speaker-a', label: 'Headphones' },
  ] as MediaDeviceInfo[];

  assert.deepEqual(toAudioDeviceOptions(devices, 'audioinput'), [
    { deviceId: 'mic-a', label: 'USB Microphone' },
    { deviceId: 'mic-b', label: '麦克风 2' },
  ]);
});

test('default output maps to the empty sink id required by Chromium', () => {
  assert.equal(resolvedSinkId(DEFAULT_AUDIO_DEVICE_ID), '');
  assert.equal(resolvedSinkId('speaker-123'), 'speaker-123');
});

test('audio elements switch to the requested output device', async () => {
  let appliedSink = 'unset';
  const element = {
    setSinkId: async (sinkId: string) => { appliedSink = sinkId; },
  } as unknown as HTMLMediaElement;

  assert.equal(await applyAudioElementOutput(element, 'speaker-123'), true);
  assert.equal(appliedSink, 'speaker-123');
  assert.equal(await applyAudioElementOutput(element, DEFAULT_AUDIO_DEVICE_ID), true);
  assert.equal(appliedSink, '');
});

test('unsupported audio elements fail open and keep system playback working', async () => {
  const element = {} as HTMLMediaElement;
  assert.equal(await applyAudioElementOutput(element, 'speaker-123'), false);
});

test('member volume only affects microphone consumers, including legacy unlabelled audio', () => {
  assert.equal(isMemberVoiceAudio('audio', 'mic'), true);
  assert.equal(isMemberVoiceAudio('audio'), true);
  assert.equal(isMemberVoiceAudio('audio', 'screen-audio'), false);
  assert.equal(isMemberVoiceAudio('audio', 'application-audio'), false);
  assert.equal(isMemberVoiceAudio('video', 'screen'), false);
});

test('live microphone audio enters the gain node directly, with remembered mute or amplification', () => {
  for (const [volume, expected] of [[0, 0], [0.5, 0.5], [1, 1], [2, 2], [3, 2], [-1, 0], [NaN, 1]]) {
    const stream = {} as MediaStream;
    const destination = {};
    const connections: unknown[] = [];
    const gain = { gain: { value: -1 }, connect: (target: unknown) => { connections.push(target); }, disconnect() {} };
    const source = { connect: (target: unknown) => { connections.push(target); return gain; }, disconnect() {} };
    const context = {
      destination,
      createMediaStreamSource: (input: MediaStream) => { assert.equal(input, stream); return source; },
      createGain: () => gain,
      createMediaElementSource: () => { throw new Error('A live stream must not use the element playback path'); },
    } as unknown as AudioContext;
    const activation = { pause() {} } as HTMLAudioElement;
    const output = createRemoteAudioOutput(context, stream, volume, activation);
    assert.equal(output.gain.gain.value, expected);
    assert.deepEqual(connections, [gain, destination]);
    assert.equal(activation.srcObject, stream);
    assert.equal(activation.muted, true);
    assert.equal(activation.volume, 0);
    output.close();
    assert.equal(activation.srcObject, null);
  }
});

test('voice output activates the muted stream and releases it without stopping the incoming track', async () => {
  let resumed = 0, played = 0, paused = 0, disconnected = 0;
  const gain = { gain: { value: 1 }, connect() {}, disconnect() { disconnected++; } };
  const source = { connect: () => gain, disconnect() { disconnected++; } };
  const context = { createMediaStreamSource: () => source, createGain: () => gain, destination: {}, resume: async () => { resumed++; } } as unknown as AudioContext;
  const activation = { play: async () => { played++; }, pause: () => { paused++; } } as unknown as HTMLAudioElement;
  const stream = { getTracks: () => { throw new Error('Do not stop shared incoming tracks'); } } as unknown as MediaStream;
  const output = createRemoteAudioOutput(context, stream, 0.35, activation);
  await output.resume();
  assert.equal(resumed, 1);
  assert.equal(played, 1);
  output.setVolume(0);
  assert.equal(gain.gain.value, 0);
  output.setVolume(0.25);
  assert.equal(gain.gain.value, 0.25);
  assert.equal(activation.muted, true);
  assert.equal(activation.volume, 0);
  output.close();
  output.close();
  output.setVolume(1);
  assert.equal(gain.gain.value, 0.25, 'late controls must not reactivate a closed output');
  await output.resume();
  assert.equal(paused, 1);
  assert.equal(disconnected, 2);
  assert.equal(played, 1);
  assert.equal(activation.srcObject, null);
});
