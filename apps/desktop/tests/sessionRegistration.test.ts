import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRegistration, type RegistrationResponse } from '../src/features/connection/sessionRegistration';

function fixture(maxAttempts = 6) {
  let connected = true;
  const acknowledgements: Array<(error: Error | null, response?: RegistrationResponse) => void> = [];
  const successes: RegistrationResponse[] = [];
  const rejections: RegistrationResponse[] = [];
  const errors: Error[] = [];
  const exhaustions: Error[] = [];
  const registration = createSessionRegistration({
    maxAttempts,
    isConnected: () => connected,
    send: acknowledge => acknowledgements.push(acknowledge),
    onPending: () => {},
    onSuccess: response => successes.push(response),
    onRejected: response => rejections.push(response),
    onTransientError: error => errors.push(error),
    onExhausted: error => exhaustions.push(error),
  });
  return { registration, acknowledgements, successes, rejections, errors, exhaustions,
    setConnected: (value: boolean) => { connected = value; } };
}

test('ack timeout retries on the same connection instead of reporting login rejection', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  f.acknowledgements[0](new Error('operation has timed out'));
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.rejections, []);
  t.mock.timers.tick(499);
  assert.equal(f.acknowledgements.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.acknowledgements.length, 2);
  f.acknowledgements[1](null, { ok: true });
  assert.equal(f.successes.length, 1);
  assert.deepEqual(f.rejections, []);
  f.registration.cancel();
});

test('an explicit authentication rejection is still surfaced and is not retried', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  const rejected = { ok: false, error: '登录已失效，请重新登录' };
  f.acknowledgements[0](null, rejected);
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.rejections, [rejected]);
  assert.equal(f.acknowledgements.length, 1);
});

test('old transport acknowledgements cannot reject or overwrite a recovered session', () => {
  const f = fixture();
  f.registration.start();
  f.registration.cancel();
  f.registration.start();
  f.acknowledgements[1](null, { ok: true });
  f.acknowledgements[0](new Error('socket has been disconnected'));
  f.acknowledgements[0](null, { ok: false, error: '登录已失效' });
  assert.equal(f.successes.length, 1);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.rejections, []);
});

test('disconnect during an in-flight registration leaves reconnection to Socket.IO', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  f.setConnected(false);
  f.acknowledgements[0](new Error('socket has been disconnected'));
  f.registration.cancel();
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.rejections, []);
  assert.equal(f.acknowledgements.length, 1);
  f.setConnected(true);
  f.registration.start();
  f.acknowledgements[1](null, { ok: true });
  assert.equal(f.successes.length, 1);
});

test('duplicate connect notifications and acknowledgements do not duplicate registration', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  f.registration.start();
  assert.equal(f.acknowledgements.length, 1);
  f.acknowledgements[0](new Error('operation has timed out'));
  f.acknowledgements[0](new Error('operation has timed out'));
  f.registration.start();
  t.mock.timers.tick(500);
  assert.equal(f.acknowledgements.length, 2);
  assert.equal(f.errors.length, 1);
  f.registration.cancel();
});

test('logout or effect cleanup cancels pending retries', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  f.acknowledgements[0](new Error('operation has timed out'));
  f.registration.cancel();
  t.mock.timers.tick(10_000);
  assert.equal(f.acknowledgements.length, 1);
});

test('missing confirmation is retried, never accepted as a successful login', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.registration.start();
  f.acknowledgements[0](null);
  assert.deepEqual(f.successes, []);
  assert.deepEqual(f.rejections, []);
  t.mock.timers.tick(500);
  assert.equal(f.acknowledgements.length, 2);
  f.registration.cancel();
});

test('registration stops once after its bounded ACK budget and only explicit cancel starts a fresh round', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(3);
  f.registration.start();
  for (let attempt = 0; attempt < 3; attempt++) {
    f.acknowledgements[attempt](new Error('lost acknowledgement'));
    t.mock.timers.tick(10_000);
  }
  assert.equal(f.acknowledgements.length, 3);
  assert.equal(f.exhaustions.length, 1);
  assert.deepEqual(f.rejections, []);
  f.registration.start();
  t.mock.timers.tick(60_000);
  assert.equal(f.acknowledgements.length, 3);
  f.registration.cancel();
  f.registration.start();
  f.acknowledgements[3](null, { ok: true });
  f.acknowledgements[2](null, { ok: false, error: 'stale rejection' });
  assert.equal(f.successes.length, 1);
  assert.deepEqual(f.rejections, []);
});

test('a successful connection registers once until disconnect cancels its generation', () => {
  const f = fixture();
  f.registration.start();
  f.acknowledgements[0](null, { ok: true });
  f.registration.start();
  assert.equal(f.acknowledgements.length, 1);
  f.registration.cancel();
  f.registration.start();
  assert.equal(f.acknowledgements.length, 2);
  f.registration.cancel();
});

test('cancellation inside a transient-error callback cannot leave a stale retry timer blocking the next round', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0;
  let acknowledge!: (error: Error | null) => void;
  const registration = createSessionRegistration({
    isConnected: () => true,
    send: reply => { sends++; acknowledge = reply; },
    onPending: () => {}, onSuccess: () => {}, onRejected: () => {},
    onTransientError: () => registration.cancel(),
  });
  registration.start();
  acknowledge(new Error('lost ACK'));
  registration.start();
  assert.equal(sends, 2);
  registration.cancel();
});
