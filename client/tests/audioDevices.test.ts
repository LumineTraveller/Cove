import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAudioElementOutput,
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
