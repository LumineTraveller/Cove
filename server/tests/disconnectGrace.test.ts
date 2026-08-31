import test from 'node:test';
import assert from 'node:assert/strict';
import { DisconnectGrace as ServerGrace, DISCONNECT_GRACE_MS } from '../src/disconnectGrace';
import { DisconnectGrace as DesktopGrace } from '../../client/src/utils/disconnectGrace';
import { DisconnectGrace as MobileGrace } from '../../mobile/src/disconnectGrace';

for (const [platform, Grace] of [['server', ServerGrace], ['desktop', DesktopGrace], ['mobile', MobileGrace]] as const) {
  test(`${platform}: expire exactly at 7.5s, repeated failures do not extend deadline`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const grace = new Grace();
    let expired = 0;
    grace.fail('signal', () => expired++);
    t.mock.timers.tick(4_000);
    grace.fail('signal', () => expired++);
    t.mock.timers.tick(3_499);
    assert.equal(expired, 0);
    t.mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(DISCONNECT_GRACE_MS, 7_500);
    grace.clear();
  });

  test(`${platform}: recovery cancels only its own channel; explicit teardown cancels all`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const grace = new Grace();
    const expired: string[] = [];
    grace.fail('send', () => expired.push('send'));
    grace.fail('recv', () => expired.push('recv'));
    grace.recover('send');
    t.mock.timers.tick(7_500);
    assert.deepEqual(expired, ['recv']);
    grace.fail('send', () => expired.push('send'));
    grace.clear();
    t.mock.timers.tick(7_500);
    assert.deepEqual(expired, ['recv']);
  });
}

test('server: takeover cancellation prevents a stale grace cleanup timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const grace = new ServerGrace();
  let expired = 0;
  grace.fail('old-socket', () => expired++);
  grace.cancel('old-socket');
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(expired, 0);
});
