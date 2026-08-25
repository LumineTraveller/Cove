import assert from 'node:assert/strict';
import test from 'node:test';
import { soundpackVoiceAudience } from '../src/soundpackAudience';

test('soundpack audio is sent only to members currently in voice', () => {
  const audience = soundpackVoiceAudience(
    new Set(['sender', 'voice-peer', 'channel-only']),
    new Set(['sender', 'voice-peer']),
    'sender',
  );
  assert.deepEqual(audience, ['sender', 'voice-peer']);
});

test('channel-only members cannot start synchronized playback', () => {
  assert.equal(soundpackVoiceAudience(
    new Set(['sender', 'voice-peer']),
    new Set(['voice-peer']),
    'sender',
  ), null);
});

test('stale voice entries outside the room are never included', () => {
  assert.deepEqual(soundpackVoiceAudience(
    new Set(['sender', 'valid-peer']),
    new Set(['sender', 'valid-peer', 'stale-peer']),
    'sender',
  ), ['sender', 'valid-peer']);
});
