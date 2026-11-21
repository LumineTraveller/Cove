import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerScreenShareActivity } from '../electron/screen-share-activity';
import { acquireNativeScreenRendererActivity } from '../electron/native-screen-renderer-activity';

function fixture(previous = true) {
  let policy = previous, trusted = true;
  const writes: boolean[] = [];
  const target = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    getBackgroundThrottling: () => policy,
    setBackgroundThrottling: (value: boolean) => { policy = value; writes.push(value); } });
  const ipc = new EventEmitter();
  const dispose = registerScreenShareActivity(ipc as any, () => trusted);
  return { target, ipc, dispose, writes, policy: () => policy, untrust: () => { trusted = false; },
    send: (id: unknown, enabled: unknown) => ipc.emit('cove:screen-share:activity', { sender: target }, id, enabled) };
}

test('browser sharing disables throttling until its own release and leaves idle policy unchanged', () => {
  const f = fixture();
  assert.equal(f.policy(), true);
  f.send(1, true); f.send(1, true);
  assert.equal(f.policy(), false);
  f.send(1, false); f.send(1, false);
  assert.equal(f.policy(), true);
  assert.deepEqual(f.writes, [false, true]);
  f.dispose();
});

test('late release cannot undo the successor and native failure cannot undo browser ownership', () => {
  const f = fixture();
  f.send(1, true); f.send(2, true); f.send(1, false);
  assert.equal(f.policy(), false);
  const native = acquireNativeScreenRendererActivity(f.target)!;
  native();
  assert.equal(f.policy(), false, 'native retirement leaves the screen publication active');
  f.send(2, false);
  assert.equal(f.policy(), true);
  assert.deepEqual(f.writes, [false, true]);
  f.dispose();
});

test('navigation, renderer failure, destruction and app disposal release screen activity', () => {
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed', 'dispose']) {
    const f = fixture(); f.send(1, true);
    f.target.emit('did-start-navigation', {}, '', false, false);
    assert.equal(f.policy(), false, 'subframe navigation does not end screen sharing');
    if (event === 'dispose') f.dispose();
    else if (event === 'did-start-navigation') f.target.emit(event, {}, '', false, true);
    else f.target.emit(event);
    assert.equal(f.policy(), true);
    assert.equal(f.target.listenerCount('destroyed'), 0);
    assert.equal(f.target.listenerCount('render-process-gone'), 0);
    assert.equal(f.target.listenerCount('did-start-navigation'), 0);
    f.dispose();
  }
});

test('invalid or untrusted messages do not change renderer scheduling', () => {
  const f = fixture();
  for (const [id, enabled] of [[0, true], [-1, true], [1.5, true], ['1', true], [1, 'true'], [Infinity, true]])
    f.send(id, enabled);
  f.untrust(); f.send(1, true);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test('a pre-existing unthrottled renderer remains unchanged after sharing', () => {
  const f = fixture(false); f.send(1, true); f.send(1, false); f.dispose();
  assert.equal(f.policy(), false); assert.deepEqual(f.writes, []);
});
