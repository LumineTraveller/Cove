import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoicePresenceEvent, voicePresenceMessage } from '../src/voicePresence';

test('voice presence event is stable and uniquely addressable', () => {
  assert.deepEqual(createVoicePresenceEvent('join', 'socket-a', 'Alice', 1234, 0.25), {
    eventId: 'voice-ya-9',
    action: 'join',
    socketId: 'socket-a',
    username: 'Alice',
    timestamp: 1234,
  });
});

test('voice presence messages distinguish joining and leaving voice', () => {
  assert.equal(voicePresenceMessage('Alice', 'join'), '[Alice] 加入了语音');
  assert.equal(voicePresenceMessage('Alice', 'leave'), '[Alice] 离开了语音');
});
