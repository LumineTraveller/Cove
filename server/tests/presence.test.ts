import assert from 'node:assert/strict';
import test from 'node:test';
import { createLobbyPresenceSnapshot } from '../src/presence';

test('lobby snapshot contains the current online, channel and voice state', () => {
  const snapshot = createLobbyPresenceSnapshot(
    new Map([['socket-a', 'Alice'], ['socket-b', 'Bob']]),
    new Map([['socket-a', 'data:image/png;base64,avatar']]),
    new Map([['room-1', new Set(['socket-a', 'socket-b'])]]),
    new Map([['room-1', new Set(['socket-b'])]]),
  );

  assert.deepEqual(snapshot.onlineUsers, [
    { socketId: 'socket-a', username: 'Alice', avatarUrl: 'data:image/png;base64,avatar' },
    { socketId: 'socket-b', username: 'Bob', avatarUrl: null },
  ]);
  assert.deepEqual(snapshot.roomMembers, { 'room-1': ['Alice', 'Bob'] });
  assert.deepEqual(snapshot.voiceCounts, { 'room-1': 1 });
});

test('a fresh snapshot removes users who have disconnected', () => {
  const names = new Map([['socket-a', 'Alice'], ['socket-b', 'Bob']]);
  const room = new Set(['socket-a', 'socket-b']);
  const voice = new Set(['socket-b']);

  names.delete('socket-b');
  room.delete('socket-b');
  voice.delete('socket-b');
  const snapshot = createLobbyPresenceSnapshot(
    names,
    new Map(),
    new Map([['room-1', room]]),
    new Map([['room-1', voice]]),
  );

  assert.deepEqual(snapshot.onlineUsers.map(user => user.username), ['Alice']);
  assert.deepEqual(snapshot.roomMembers, { 'room-1': ['Alice'] });
  assert.deepEqual(snapshot.voiceCounts, { 'room-1': 0 });
});
