import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedVideoPoint, remoteMouseButton, RemotePointerSender, type RemoteControlInput } from '../src/remoteControl';

test('pointer throttle sends the first event immediately and the newest tail without further movement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: RemoteControlInput[] = [];
  const sender = new RemotePointerSender(input => sent.push(input), () => now);
  sender.send({ type: 'pointer', x: 0, y: 0 });
  now = 2; t.mock.timers.tick(2);
  sender.send({ type: 'pointer', x: 0.1, y: 0.1 });
  sender.send({ type: 'pointer', x: 0.2, y: 0.2 });
  assert.equal(sent.length, 1);
  now = 16; t.mock.timers.tick(14);
  assert.deepEqual(sent, [{ type: 'pointer', x: 0, y: 0 }, { type: 'pointer', x: 0.2, y: 0.2 }]);
  t.mock.timers.tick(100);
  assert.equal(sent.length, 2);
});

test('button/key/wheel barriers flush earlier movement and cancel prevents a late old-session tail', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: RemoteControlInput[] = [];
  const sender = new RemotePointerSender(input => sent.push(input), () => now);
  sender.send({ type: 'pointer', x: 0, y: 0 });
  now = 2;
  sender.send({ type: 'pointer', x: 0.1, y: 0.1 });
  sender.send({ type: 'button', button: 'left', down: true, x: 0.2, y: 0.2 });
  now = 4;
  sender.send({ type: 'pointer', x: 0.3, y: 0.3 });
  sender.send({ type: 'button', button: 'left', down: false, x: 0.4, y: 0.4 });
  assert.deepEqual(sent.map(input => input.type), ['pointer', 'pointer', 'button', 'pointer', 'button']);
  now = 5;
  sender.send({ type: 'pointer', x: 0.9, y: 0.9 });
  sender.cancel();
  t.mock.timers.tick(100);
  assert.equal(sent.length, 5);
  sender.send({ type: 'pointer', x: 1, y: 1 });
  assert.equal(sent.length, 6, 'a new session does not inherit the previous throttle');
});

test('remote pointer excludes top and bottom letterbox bars', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(normalizedVideoPoint(500, 50, rect, 1920, 1080), null);
  const center = normalizedVideoPoint(500, 500, rect, 1920, 1080);
  assert.ok(center);
  assert.equal(center.x, 0.5);
  assert.equal(center.y, 0.5);
});

test('remote pointer maps exact video edges', () => {
  const rect = { left: 10, top: 20, width: 1600, height: 900 };
  assert.deepEqual(normalizedVideoPoint(10, 20, rect, 1920, 1080), { x: 0, y: 0 });
  assert.deepEqual(normalizedVideoPoint(1610, 920, rect, 1920, 1080), { x: 1, y: 1 });
  assert.equal(normalizedVideoPoint(500, 500, rect, 0, 1080), null);
});

test('browser mouse buttons map only supported controls', () => {
  assert.equal(remoteMouseButton(0), 'left');
  assert.equal(remoteMouseButton(1), 'middle');
  assert.equal(remoteMouseButton(2), 'right');
  assert.equal(remoteMouseButton(4), null);
});
