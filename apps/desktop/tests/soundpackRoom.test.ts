import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoundpackRoomLifetime, readSoundpackRoomList, soundpackRequestInit, soundpackRoomFilePath } from '../src/features/soundpacks/soundpackRoom';

test('room list capability rejects legacy arrays, missing rooms and mixed room records', () => {
  const sound = { id: 'fictional-sound', roomId: 'room-a' };
  for (const payload of [[sound], null, {}, { roomId: 'room-b', soundpacks: [sound] },
    { roomId: 'room-a', soundpacks: [{ id: 'old-unassigned' }] },
    { roomId: 'room-a', soundpacks: [sound, { roomId: 'room-b' }] }]) {
    assert.equal(readSoundpackRoomList(payload, 'room-a'), null);
  }
  assert.deepEqual(readSoundpackRoomList({ roomId: 'room-a', soundpacks: [] }, 'room-a'), []);
  assert.deepEqual(readSoundpackRoomList({ roomId: 'room-a', soundpacks: [sound] }, 'room-a'), [sound]);
});

test('sound file requests carry exact room and variant with account identity only in a header', () => {
  const path = soundpackRoomFilePath('sound/id', 'room /?#b', 'original');
  const url = new URL(path, 'https://fictional.example.test');
  assert.equal(url.pathname, '/api/soundpacks/sound%2Fid/file');
  assert.equal(url.searchParams.get('roomId'), 'room /?#b');
  assert.equal(url.searchParams.get('variant'), 'original');
  assert.equal(soundpackRoomFilePath('sound', 'room', 'playback').includes('variant=playback'), true);
  const init = soundpackRequestInit('fictional-account-token', { headers: { 'Content-Type': 'application/json' }, redirect: 'follow' });
  assert.equal(new Headers(init.headers).get('X-Cove-Account-Token'), 'fictional-account-token');
  assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
  assert.equal(init.redirect, 'error', 'redirects must not forward the account header');
  assert.equal(path.includes('fictional-account-token'), false);
  assert.throws(() => soundpackRequestInit(''));
  assert.throws(() => soundpackRoomFilePath('sound', '', 'playback'));
});

test('departed room rejects late request work and untagged/global events without cancelling the next room', async () => {
  const previous = createSoundpackRoomLifetime('room-a'), current = createSoundpackRoomLifetime('room-b');
  let resolve!: (value: string) => void;
  let visible = 'room-b';
  const lateResponse = new Promise<string>(done => { resolve = done; }).then(value => { if (previous.active()) visible = value; });
  assert.equal(previous.accepts({ roomId: 'room-a' }), true);
  for (const event of [undefined, null, {}, { roomId: null }, { roomId: 'room-b' }]) assert.equal(previous.accepts(event), false);
  previous.cancel();
  resolve('late-room-a');
  await lateResponse;
  assert.equal(visible, 'room-b');
  assert.equal(previous.signal.aborted, true);
  assert.equal(previous.accepts({ roomId: 'room-a' }), false);
  assert.equal(current.active(), true);
  assert.equal(current.accepts({ roomId: 'room-b' }), true);
});
