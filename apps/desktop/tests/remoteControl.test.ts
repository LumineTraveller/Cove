import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedVideoPoint, remoteMouseButton, RemotePointerSender, type RemoteControlInput } from '../src/features/remote-control/remoteControl';

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
  now = 8; t.mock.timers.tick(6);
  assert.deepEqual(sent, [{ type: 'pointer', x: 0, y: 0 }, { type: 'pointer', x: 0.2, y: 0.2 }]);
  t.mock.timers.tick(100);
  assert.equal(sent.length, 2);
});

test('120Hz samples retain their native cadence and a stopped fast movement sends its latest tail within 8ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: { input: RemoteControlInput; at: number }[] = [];
  const sender = new RemotePointerSender(input => sent.push({ input, at: now }), () => now);
  // Rounded 120Hz timestamps, as delivered by a frame-aligned pointermove.
  for (const time of [0, 8, 17, 25, 33, 42, 50, 58, 67, 75, 83, 92]) {
    const elapsed = time - now;
    now = time;
    t.mock.timers.tick(elapsed);
    sender.send({ type: 'pointer', x: time / 100, y: 0.5 });
  }
  assert.equal(sent.length, 12, 'do not discard every other high-refresh sample');
  assert.deepEqual(sent.map(sample => sample.at), [0, 8, 17, 25, 33, 42, 50, 58, 67, 75, 83, 92]);
  now = 94; t.mock.timers.tick(2);
  sender.send({ type: 'pointer', x: 0.96, y: 0.5 });
  sender.send({ type: 'pointer', x: 1, y: 0.5 });
  now = 100; t.mock.timers.tick(6);
  assert.deepEqual(sent.at(-1), { input: { type: 'pointer', x: 1, y: 0.5 }, at: 100 });
  now = 1100; t.mock.timers.tick(1000);
  assert.equal(sent.length, 13, 'stationary input must not produce interpolation or repeated packets');
});

test('500Hz input is bounded to 125Hz while click, drag, wheel and key edges stay in order', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: RemoteControlInput[] = [];
  const sender = new RemotePointerSender(input => sent.push(input), () => now);
  for (let time = 0; time < 1000; time += 2) {
    now = time;
    if (time) t.mock.timers.tick(2);
    sender.send({ type: 'pointer', x: time / 1000, y: 0.5 });
  }
  assert.equal(sent.length, 125);
  sender.send({ type: 'button', button: 'left', down: true, x: 1, y: 0.5 });
  sender.send({ type: 'pointer', x: 0.8, y: 0.5 });
  sender.send({ type: 'wheel', deltaX: 0, deltaY: 120, x: 0.8, y: 0.5 });
  sender.send({ type: 'key', code: 'ShiftLeft', down: true });
  sender.send({ type: 'pointer', x: 0.6, y: 0.5 });
  sender.send({ type: 'button', button: 'left', down: false, x: 0.6, y: 0.5 });
  sender.send({ type: 'key', code: 'ShiftLeft', down: false });
  assert.deepEqual(sent.slice(125).map(input => input.type), [
    'pointer', 'button', 'pointer', 'wheel', 'key', 'pointer', 'button', 'key',
  ]);
  assert.deepEqual(sent.filter(input => input.type === 'button' || input.type === 'key').map(input => input.down),
    [true, true, false, false]);
  sender.cancel();
  now = 2000; t.mock.timers.tick(1002);
  assert.equal(sent.length, 133, 'no input can escape cancellation');
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

test('normalized coordinates stay precise across resized, scaled and portrait video surfaces', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const rect = { left: 17, top: 23, width: 2560 / scale, height: 1440 / scale };
    const p = normalizedVideoPoint(rect.left + rect.width * 0.333333, rect.top + rect.height * 0.777777,
      rect, 2560, 1440)!;
    assert.ok(Math.abs(p.x - 0.333333) < 1e-12);
    assert.ok(Math.abs(p.y - 0.777777) < 1e-12);
  }
  const portrait = { left: 0, top: 0, width: 1600, height: 900 };
  assert.equal(normalizedVideoPoint(100, 450, portrait, 1080, 1920), null, 'exclude side letterbox bars');
  assert.deepEqual(normalizedVideoPoint(800, 450, portrait, 1080, 1920), { x: 0.5, y: 0.5 });
});

test('browser mouse buttons map only supported controls', () => {
  assert.equal(remoteMouseButton(0), 'left');
  assert.equal(remoteMouseButton(1), 'middle');
  assert.equal(remoteMouseButton(2), 'right');
  assert.equal(remoteMouseButton(4), null);
});

test('fullscreen aspect-ratio rounding preserves the top row and both corners at different pixel scales', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const rect = { left: 0, top: 0, width: 1707 / scale, height: 1067 / scale };
    for (const x of [0, rect.width / 2, rect.width]) {
      const top = normalizedVideoPoint(x, 0, rect, 2560, 1600, scale)!;
      assert.ok(top, `top edge at ${scale} scale`);
      assert.equal(top.y, 0);
      assert.equal(top.x, x / rect.width);
      assert.equal(normalizedVideoPoint(x, -0.01, rect, 2560, 1600, scale), null,
        'never map points outside the actual video element');
    }
    const bottom = normalizedVideoPoint(rect.width, rect.height, rect, 2560, 1600, scale)!;
    assert.deepEqual(bottom, { x: 1, y: 1 });
    const side = { left: -1707, top: 0, width: 1707 / scale, height: 1066 / scale };
    assert.deepEqual(normalizedVideoPoint(side.left, side.top, side, 2560, 1600, scale), { x: 0, y: 0 },
      'negative monitor origins and tiny side gutters are accepted');
  }
});

test('edge rounding tolerance does not admit genuine black bars or expand with high DPI', () => {
  const rect = { left: 0, top: 0, width: 1600, height: 1000 };
  assert.equal(normalizedVideoPoint(800, 0, rect, 1920, 1080, 1.5), null);
  assert.equal(normalizedVideoPoint(800, 49.9, rect, 1920, 1080, 1.5), null);
  assert.deepEqual(normalizedVideoPoint(800, 50, rect, 1920, 1080, 1.5), { x: 0.5, y: 0 });
  const narrowBar = { left: 0, top: 0, width: 1600, height: 902 };
  assert.equal(normalizedVideoPoint(800, 0, narrowBar, 1920, 1080, 2), null,
    'one CSS pixel at 200% is a two-physical-pixel bar, not rounding');
});
