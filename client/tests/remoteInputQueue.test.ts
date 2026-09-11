import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { RemoteInputQueue, MAX_PENDING_INPUTS, MAX_INPUT_AGE_MS } from '../electron/remote-input-queue';

function queueHarness(t: TestContext, ready = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const writes: any[] = [];
  const failures: string[] = [];
  const writer = Object.assign(new EventEmitter(), {
    writableLength: 0,
    accepts: true,
    write(line: string) { writes.push(JSON.parse(line)); return this.accepts; },
  });
  const queue = new RemoteInputQueue(writer, reason => failures.push(reason), () => now);
  if (ready) queue.markReady();
  t.after(() => queue.close());
  return { queue, writer, writes, failures, advance(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}

test('queue waits for helper readiness, coalesces only adjacent moves and preserves edge order', t => {
  const h = queueHarness(t, false);
  h.queue.enqueue({ type: 'pointer', x: 0.1, y: 0.1 });
  h.queue.enqueue({ type: 'pointer', x: 0.2, y: 0.2 });
  h.queue.enqueue({ type: 'button', button: 'left', down: true, x: 0.2, y: 0.2 });
  h.queue.enqueue({ type: 'pointer', x: 0.3, y: 0.3 });
  h.queue.enqueue({ type: 'pointer', x: 0.4, y: 0.4 });
  h.queue.enqueue({ type: 'button', button: 'left', down: false, x: 0.4, y: 0.4 });
  assert.equal(h.writes.length, 0);
  h.queue.markReady();
  assert.equal(h.writes.length, 1);
  for (let seq = 1; seq <= 4; seq++) h.queue.acknowledge(seq);
  assert.deepEqual(h.writes.map(({ seq, ...input }) => input), [
    { type: 'pointer', x: 0.2, y: 0.2 },
    { type: 'button', button: 'left', down: true, x: 0.2, y: 0.2 },
    { type: 'pointer', x: 0.4, y: 0.4 },
    { type: 'button', button: 'left', down: false, x: 0.4, y: 0.4 },
  ]);
});

test('write(false) is sent exactly once and both consumption and drain unblock the next command', t => {
  const h = queueHarness(t);
  h.writer.accepts = false;
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: true });
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: false });
  h.queue.acknowledge(1);
  assert.equal(h.writes.length, 1);
  h.writer.accepts = true;
  h.writer.emit('drain');
  assert.deepEqual(h.writes.map(input => input.down), [true, false]);
  h.queue.acknowledge(2);
  assert.equal(h.failures.length, 0);
});

test('close discards unsent input; late acknowledgements and drains cannot resume it', t => {
  const h = queueHarness(t);
  h.queue.enqueue({ type: 'key', code: 'ShiftLeft', down: true });
  h.queue.enqueue({ type: 'pointer', x: 0.8, y: 0.8 });
  h.queue.enqueue({ type: 'key', code: 'ShiftLeft', down: false });
  h.queue.close();
  h.queue.acknowledge(1);
  h.writer.emit('drain');
  h.advance(2000);
  assert.equal(h.writes.length, 1);
  assert.equal(h.failures.length, 0);
  assert.equal(h.queue.enqueue({ type: 'pointer', x: 1, y: 1 }), false);
});

test('overflow and an unresponsive helper stop instead of dropping a key release', t => {
  const h = queueHarness(t);
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: true });
  for (let i = 0; i < MAX_PENDING_INPUTS; i++) h.queue.enqueue({ type: 'key', code: 'KeyB', down: i % 2 === 0 });
  assert.equal(h.queue.enqueue({ type: 'key', code: 'KeyA', down: false }), false);
  assert.equal(h.failures.length, 1);
  h.advance(2000);
  assert.equal(h.failures.length, 1);
  assert.equal(h.writes.length, 1);
});

test('helper acknowledgement timeout is bounded', t => {
  const h = queueHarness(t);
  h.queue.enqueue({ type: 'key', code: 'ControlLeft', down: true });
  h.advance(MAX_INPUT_AGE_MS);
  assert.equal(h.failures.length, 1);
  h.queue.acknowledge(1);
  assert.equal(h.writes.length, 1);
});

test('a consumed write still times out if the pipe never drains', t => {
  const h = queueHarness(t);
  h.writer.accepts = false;
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: true });
  h.queue.acknowledge(1);
  h.advance(MAX_INPUT_AGE_MS);
  assert.equal(h.failures.length, 1);
});

test('old moves may expire but an old edge cancels the session', t => {
  const h = queueHarness(t, false);
  h.queue.enqueue({ type: 'pointer', x: 0.1, y: 0.1 });
  h.advance(MAX_INPUT_AGE_MS + 1);
  h.queue.markReady();
  assert.equal(h.writes.length, 0);
  assert.equal(h.failures.length, 0);
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: true });
  h.queue.acknowledge(1);
  h.writer.accepts = false;
  h.queue.enqueue({ type: 'pointer', x: 0.2, y: 0.2 });
  h.queue.acknowledge(2);
  h.queue.enqueue({ type: 'key', code: 'KeyA', down: false });
  h.advance(MAX_INPUT_AGE_MS + 1);
  h.writer.emit('drain');
  assert.equal(h.failures.length, 1);
  assert.equal(h.writes.length, 2);
});
