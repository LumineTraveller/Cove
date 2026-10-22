import assert from 'node:assert/strict';
import test from 'node:test';
import { createScreenWatchRecovery, screenAudioMatchesPublication, screenPublicationMetadata } from '../../../packages/client-core/src/screenWatchRecovery';

const original = { socketId: 'peer', videoProducerId: 'first', shareSessionId: 'share-1', publicationAttempt: 1 };
const replacement = { ...original, videoProducerId: 'second', publicationAttempt: 2 };
function fixture(resume = async () => true) {
  let watching = true;
  let stops = 0;
  let waits = 0;
  const calls: string[] = [];
  const recovery = createScreenWatchRecovery({
    isWatching: () => watching,
    onReplacing: () => { waits++; },
    resume: async (source, current) => { calls.push(source.videoProducerId); return await resume() && current(); },
    stop: () => { stops++; watching = false; },
  });
  recovery.begin(original);
  return { recovery, calls, stops: () => stops, waits: () => waits, leave: () => { watching = false; recovery.cancel(); } };
}
test('same publication resumes once and ignores late old producer close/duplicate announcements', async () => {
  const f = fixture();
  f.recovery.sourceAvailable(replacement);
  f.recovery.sourceClosed({ peerId: 'peer', producerId: 'first' });
  f.recovery.sourceAvailable(replacement);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls, ['second']);
  assert.equal(f.stops(), 0);
  f.leave();
});
test('explicit replacement can wait for new producer, but explicit stop and new sessions cannot resume', async () => {
  const f = fixture();
  f.recovery.sourceClosed({ peerId: 'peer', producerId: 'first', shareSessionId: 'share-1', replacing: true });
  assert.equal(f.waits(), 1);
  f.recovery.sourceClosed({ peerId: 'peer', producerId: 'first', shareSessionId: 'share-1' });
  f.recovery.sourceAvailable(replacement);
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.calls, []);
  const newer = fixture();
  newer.recovery.sourceAvailable({ ...replacement, shareSessionId: 'another-share' });
  assert.equal(newer.stops(), 1);
});
test('replacement retry is capped at three and the original deadline never extends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => false);
  f.recovery.sourceAvailable(replacement);
  for (const ms of [0, 250, 750]) {
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(ms);
  }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 3);
  assert.equal(f.stops(), 1);
  t.mock.timers.tick(10_000);
  assert.equal(f.stops(), 1);
});
test('cancel/leave invalidates a pending resume and cancels its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const f = fixture(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
  f.recovery.sourceAvailable(replacement);
  f.leave(); release();
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal(f.stops(), 0);
  assert.deepEqual(f.calls, ['second']);
});
test('late announcements cannot extend the five-second replacement window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise<boolean>(() => {}));
  f.recovery.sourceClosed({ peerId: 'peer', producerId: 'first', shareSessionId: 'share-1', replacing: true });
  t.mock.timers.tick(4900);
  f.recovery.sourceAvailable(replacement);
  t.mock.timers.tick(99);
  assert.equal(f.stops(), 0);
  t.mock.timers.tick(1);
  assert.equal(f.stops(), 1);
  f.recovery.sourceAvailable({ ...replacement, videoProducerId: 'third', publicationAttempt: 3 });
  assert.deepEqual(f.calls, ['second']);
});
test('legacy and malformed publication identity never opts into replacement recovery', () => {
  assert.deepEqual(screenPublicationMetadata({ shareSessionId: '\ninvalid', publicationAttempt: -1 }), { shareSessionId: undefined, publicationAttempt: undefined });
  const f = fixture();
  f.recovery.sourceClosed({ peerId: 'peer', producerId: 'first' });
  f.recovery.sourceAvailable(replacement);
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.calls, []);
});
test('screen audio matches the selected publication; legacy unmarked peers retain their existing behavior', () => {
  assert.equal(screenAudioMatchesPublication(replacement, { shareSessionId: 'share-1', publicationAttempt: 2 }), true);
  assert.equal(screenAudioMatchesPublication(replacement, { shareSessionId: 'share-1', publicationAttempt: 1 }), false);
  assert.equal(screenAudioMatchesPublication(replacement, { shareSessionId: 'old-share', publicationAttempt: 2 }), false);
  assert.equal(screenAudioMatchesPublication(replacement, {}), false);
  assert.equal(screenAudioMatchesPublication(undefined, { shareSessionId: 'share-1', publicationAttempt: 2 }), false);
  assert.equal(screenAudioMatchesPublication({ socketId: 'peer', videoProducerId: 'legacy' }, {}), true);
  assert.equal(screenAudioMatchesPublication(undefined, {}), true);
});
test('rapid fallback announcements share one three-request budget until recovery succeeds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releases: Array<() => void> = [];
  const f = fixture(() => new Promise<boolean>(resolve => releases.push(() => resolve(false))));
  for (let attempt = 2; attempt <= 5; attempt++)
    f.recovery.sourceAvailable({ ...replacement, videoProducerId: `video-${attempt}`, publicationAttempt: attempt });
  assert.equal(f.calls.length, 3);
  assert.equal(f.stops(), 1);
  releases.forEach(release => release());
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.stops(), 1);
});
