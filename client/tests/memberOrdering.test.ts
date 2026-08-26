import assert from 'node:assert/strict';
import test from 'node:test';
import { sortRoomMembers } from '../src/memberOrdering';
import { RoomMember } from '../src/types';

const member = (socketId: string, isOwner = false): RoomMember => ({
  socketId,
  userId: socketId,
  username: socketId,
  isOwner,
  isMuted: false,
});

test('local member stays first, then voice members, preserving stable order', () => {
  const members = [member('room-only'), member('voice-a'), member('self'), member('voice-b')];
  const sorted = sortRoomMembers(members, new Set(['voice-a', 'voice-b']), 'self');
  assert.deepEqual(sorted.map(item => item.socketId), ['self', 'voice-a', 'voice-b', 'room-only']);
});

test('without a local socket id, voice ordering remains compatible', () => {
  const members = [member('room-only'), member('voice-a')];
  const sorted = sortRoomMembers(members, new Set(['voice-a']));
  assert.deepEqual(sorted.map(item => item.socketId), ['voice-a', 'room-only']);
});
