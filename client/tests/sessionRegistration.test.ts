import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRegistration, type RegistrationResponse } from '../src/sessionRegistration';

function fixture() {
  let connected = true;
  const acknowledgements: Array<(error: Error | null, response?: RegistrationResponse) => void> = [];
  const successes: RegistrationResponse[] = [];
  const rejections: RegistrationResponse[] = [];
  const errors: Error[] = [];
  const registration = createSessionRegistration({
    isConnected: () => connected,
    send: acknowledge => acknowledgements.push(acknowledge),
    onPending: () => {},
    onSuccess: response => successes.push(response),
    onRejected: response => rejections.push(response),
    onTransientError: error => errors.push(error),
  });
  return { registration, acknowledgements, successes, rejections, errors,
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
