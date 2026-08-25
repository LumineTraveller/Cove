import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionDeadline, INITIAL_CONNECTION_TIMEOUT_MS } from '../src/connectionDeadline';

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
