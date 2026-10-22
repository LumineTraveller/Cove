import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionDeadline, INITIAL_CONNECTION_TIMEOUT_MS } from '../src/features/connection/connectionDeadline';
import { createSessionRegistration } from '../src/features/connection/sessionRegistration';

test('initial connection deadline fires once after 30 seconds', () => {
  let scheduledCallback: (() => void) | undefined;
  let scheduledDelay = 0;
  let timeoutCount = 0;

  createConnectionDeadline(() => { timeoutCount += 1; }, {
    schedule: (callback, delayMs) => {
      scheduledCallback = callback;
      scheduledDelay = delayMs;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  assert.equal(scheduledDelay, INITIAL_CONNECTION_TIMEOUT_MS);
  scheduledCallback?.();
  scheduledCallback?.();
  assert.equal(timeoutCount, 1);
});

test('completed connections cancel the deadline', () => {
  let scheduledCallback: (() => void) | undefined;
  let cancelled = false;
  let timedOut = false;

  const deadline = createConnectionDeadline(() => { timedOut = true; }, {
    schedule: callback => {
      scheduledCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancelScheduled: () => { cancelled = true; },
  });

  deadline.complete();
  scheduledCallback?.();
  assert.equal(cancelled, true);
  assert.equal(timedOut, false);
});

test('cancelled attempts cannot time out later', () => {
  let scheduledCallback: (() => void) | undefined;
  let timedOut = false;

  const deadline = createConnectionDeadline(() => { timedOut = true; }, {
    schedule: callback => {
      scheduledCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  deadline.cancel();
  scheduledCallback?.();
  assert.equal(timedOut, false);
});

test('the initial 30s deadline takes priority over six slow registration ACK attempts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connected = true;
  let sends = 0;
  let exhausted = 0;
  let timedOut = 0;
  const registration = createSessionRegistration({
    isConnected: () => connected,
    send: ack => {
      sends++;
      setTimeout(() => ack(new Error('ACK timed out')), 8000);
    },
    onPending: () => {}, onSuccess: () => {}, onRejected: () => {},
    onTransientError: () => {}, onExhausted: () => exhausted++,
  });
  createConnectionDeadline(() => {
    timedOut++;
    connected = false;
    registration.cancel();
  });
  registration.start();
  for (const elapsed of [8000, 500, 8000, 1000, 8000, 2000, 2499]) t.mock.timers.tick(elapsed);
  assert.equal(sends, 4);
  assert.equal(timedOut, 0);
  t.mock.timers.tick(1);
  t.mock.timers.tick(60_000);
  assert.equal(timedOut, 1);
  assert.equal(sends, 4);
  assert.equal(exhausted, 0);
});
