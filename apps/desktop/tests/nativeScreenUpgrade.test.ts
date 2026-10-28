import test from 'node:test';
import assert from 'node:assert/strict';
import { canUpgradeScreenCapture, upgradePublishedScreenCapture, type NativeScreenUpgradeQueue } from '../src/features/media/screen/nativeScreenUpgrade';
import { createScreenEncodingPlan, type ScreenFps } from '../src/features/media/screen/screenCapture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function capture(width: number | undefined = 1280, height: number | undefined = 720) {
  const track = {
    readyState: 'live', contentHint: 'detail', onended: null as (() => void) | null, stops: 0,
    getSettings: () => ({ width, height }),
    stop() { if (this.readyState !== 'ended') { this.stops++; this.readyState = 'ended'; } },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

function fixture() {
  const stock = capture(), native = capture();
  const controller = new AbortController();
  const queue: NativeScreenUpgradeQueue = { tail: Promise.resolve(), candidates: new Set() };
  const stockPlan = createScreenEncodingPlan({ preset: '720p', maxFps: 120, activity: 'active', sourceWidth: 1280, sourceHeight: 720 });
  let currentStream: MediaStream | null = stock.stream, intent = true, publication = true;
  let commits = 0, stopped = 0, acquired = 0;
  let scale = 1;
  const replacements: unknown[] = [];
  const committedDimensions: number[][] = [];
  let replace = async (_track: unknown) => {};
  let adopt = (stream: MediaStream) => { currentStream = stream; };
  const producer = {
    rtpSender: { getParameters: () => ({ encodings: [{ scaleResolutionDownBy: scale }] }) },
    replaceTrack: async ({ track }: { track: unknown }) => { replacements.push(track); await replace(track); },
  } as any;
  const candidate = {
    stream: native.stream,
    commit() { commits++; },
    stop() { native.track.stop(); },
  };
  let acquire = async () => candidate;
  const run = (maxFps: ScreenFps = 120) => upgradePublishedScreenCapture({
    stockStream: stock.stream, stockPlan, maxFps, producer, queue, signal: controller.signal,
    isIntentCurrent: () => intent, isPublicationCurrent: () => publication,
    currentStream: () => currentStream,
    acquire: async (_stock, options) => {
      acquired++;
      assert.equal(options.maxWidth, stockPlan.sourceWidth); assert.equal(options.maxHeight, stockPlan.sourceHeight); assert.equal(options.fps, maxFps);
      return acquire();
    },
    onCommit: (stream, _track, width, height) => { committedDimensions.push([width, height]); adopt(stream); },
    stopPublication: () => { stopped++; publication = false; },
  });
  return {
    stock, native, producer, stockPlan, controller, queue, replacements, committedDimensions, candidate, run,
    current: () => currentStream, commits: () => commits, stopped: () => stopped, acquired: () => acquired,
    setIntent: (value: boolean) => { intent = value; }, setPublication: (value: boolean) => { publication = value; },
    setCurrent: (value: MediaStream) => { currentStream = value; }, setScale: (value: number) => { scale = value; },
    acquire: (value: typeof acquire) => { acquire = value; }, replace: (value: typeof replace) => { replace = value; },
    onCommit: (value: typeof adopt) => { adopt = value; },
  };
}

test('native acquisition leaves the published stock track and stock commit queue available', async () => {
  const f = fixture(), preparing = deferred<typeof f.candidate>();
  f.acquire(() => preparing.promise);
  const tail = f.queue.tail, upgrade = f.run();
  assert.equal(f.queue.tail, tail, 'preparing native must not occupy the source-update queue');
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.stock.track.stops, 0);
  preparing.resolve(f.candidate);
  await upgrade;
  assert.deepEqual(f.replacements, [f.native.track]);
  assert.equal(f.current(), f.native.stream);
  assert.equal(f.commits(), 1);
  assert.equal(f.stock.track.stops, 1);
  assert.equal(f.native.track.stops, 0);
  assert.equal(f.queue.candidates.size, 0);
});

test('30 FPS publication retains live stock without acquiring a native candidate', async () => {
  const f = fixture();
  Object.assign(f.stockPlan, createScreenEncodingPlan({ preset: '720p', maxFps: 30, activity: 'active' }));
  const tail = f.queue.tail;
  await f.run(30);
  assert.equal(f.acquired(), 0);
  assert.equal(f.queue.tail, tail);
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.stock.track.readyState, 'live');
  assert.equal(f.stock.track.stops, 0);
  assert.deepEqual(f.replacements, []);
  assert.equal(f.commits(), 0);
  assert.equal(f.stopped(), 0);
});

test('native acquisition failure keeps the already published stock source live', async () => {
  const f = fixture();
  f.acquire(async () => { throw new Error('helper unavailable'); });
  await f.run();
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.stock.track.stops, 0);
  assert.deepEqual(f.replacements, []);
  assert.equal(f.stopped(), 0);
});

test('aborting a ready queued candidate releases it before an earlier source commit completes', async () => {
  const f = fixture(), earlier = deferred<void>();
  f.queue.tail = earlier.promise;
  const upgrade = f.run();
  await flush();
  assert.equal(f.queue.candidates.size, 1);
  f.controller.abort();
  assert.equal(f.native.track.stops, 1);
  assert.equal(f.stock.track.stops, 0);
  earlier.resolve();
  await upgrade;
  assert.deepEqual(f.replacements, []);
});

test('a late native replacement rolls back before the following stock update commits', async () => {
  const f = fixture(), replacing = deferred<void>(), newest = capture();
  f.replace(async track => { if (track === f.native.track) await replacing.promise; });
  const upgrade = f.run();
  await flush();
  f.setIntent(false);
  f.controller.abort();
  const update = f.queue.tail.then(async () => {
    await f.producer.replaceTrack({ track: newest.track });
    f.setCurrent(newest.stream);
  });
  replacing.resolve();
  await Promise.all([upgrade, update]);
  assert.deepEqual(f.replacements, [f.native.track, f.stock.track, newest.track]);
  assert.equal(f.current(), newest.stream);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
  assert.equal(f.commits(), 0);
  assert.equal(f.stopped(), 0);
});

test('a native track that ends during replace is rolled back to live stock', async () => {
  const f = fixture();
  f.replace(async track => { if (track === f.native.track) f.native.track.stop(); });
  await f.run();
  assert.deepEqual(f.replacements, [f.native.track, f.stock.track]);
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.commits(), 0);
});

test('failed native replacement preserves stock without producing another publication', async () => {
  const f = fixture();
  f.replace(async () => { throw new Error('replace rejected'); });
  await f.run();
  assert.deepEqual(f.replacements, [f.native.track]);
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
  assert.equal(f.stopped(), 0);
});

test('rollback failure stops the current publication through its normal teardown', async () => {
  const f = fixture();
  f.replace(async track => {
    if (track === f.native.track) f.setIntent(false);
    else throw new Error('stock restore failed');
  });
  await f.run();
  assert.deepEqual(f.replacements, [f.native.track, f.stock.track]);
  assert.equal(f.stopped(), 1);
  assert.equal(f.native.track.stops, 1);
});

test('a rollback failing after publication replacement cannot stop the new publication', async () => {
  const f = fixture(), rollback = deferred<void>(), newest = capture();
  f.replace(async track => {
    if (track === f.native.track) f.setIntent(false);
    else await rollback.promise;
  });
  const upgrade = f.run();
  await flush();
  f.setPublication(false);
  f.setCurrent(newest.stream);
  rollback.reject(new Error('old sender closed'));
  await upgrade;
  assert.equal(f.stopped(), 0);
  assert.equal(f.current(), newest.stream);
  assert.equal(newest.track.stops, 0);
});

test('late native replace success cannot restore stock over a new publication', async () => {
  const f = fixture(), replacing = deferred<void>(), newest = capture();
  f.replace(() => replacing.promise);
  const upgrade = f.run();
  await flush();
  f.setPublication(false);
  f.setCurrent(newest.stream);
  f.controller.abort();
  replacing.resolve();
  await upgrade;
  assert.deepEqual(f.replacements, [f.native.track]);
  assert.equal(f.current(), newest.stream);
  assert.equal(newest.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
  assert.equal(f.stopped(), 0);
});

test('only the currently published native track ending can stop sharing', async () => {
  const f = fixture();
  await f.run();
  const ended = f.native.track.onended!;
  const newest = capture();
  f.setCurrent(newest.stream);
  ended();
  assert.equal(f.stopped(), 0);
  f.setCurrent(f.native.stream);
  ended();
  assert.equal(f.stopped(), 1);
});

test('native admission preserves the sender resize contract before acquisition and queued commit', async () => {
  const f = fixture();
  assert.equal(canUpgradeScreenCapture(f.producer, { ...f.stockPlan, nativeResolution: true }), false);
  assert.equal(canUpgradeScreenCapture(f.producer, { ...f.stockPlan, scaleResolutionDownBy: 2 }), false);
  assert.equal(canUpgradeScreenCapture(f.producer, { ...f.stockPlan, sourceWidth: 2560 }), false);
  f.setScale(2);
  await f.run();
  assert.equal(f.acquired(), 0);
  f.setScale(1);
  const earlier = deferred<void>();
  f.queue.tail = earlier.promise;
  const upgrade = f.run();
  await flush();
  f.setScale(2);
  earlier.resolve();
  await upgrade;
  assert.deepEqual(f.replacements, []);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
});

test('native dimensions cannot exceed stock or change its aspect ratio', async () => {
  for (const [width, height] of [[1282, 720], [960, 720], [1280, 0]]) {
    const f = fixture();
    f.native.track.getSettings = () => ({ width, height });
    await f.run();
    assert.deepEqual(f.replacements, []);
    assert.equal(f.stock.track.stops, 0);
    assert.equal(f.native.track.stops, 1);
  }
});

test('a callback failing after native adoption releases detached stock and stops the current publication', async () => {
  const f = fixture();
  f.onCommit(stream => {
    f.setCurrent(stream);
    throw new Error('analysis initialization failed after adoption');
  });
  await f.run();
  assert.equal(f.stopped(), 1);
  assert.equal(f.stock.track.stops, 1, 'stock is no longer reachable through the local publication ref');
  assert.equal(f.native.track.stops, 1);
  assert.equal(f.queue.candidates.size, 0);
});

test('native commit follows settled stock geometry instead of provisional startup plan geometry', async () => {
  const f = fixture(), earlier = deferred<void>();
  Object.assign(f.stockPlan, createScreenEncodingPlan({
    preset: '540p', maxFps: 120, activity: 'active', sourceWidth: 960, sourceHeight: 540,
  }));
  f.stock.track.getSettings = () => ({ width: 960, height: 540 });
  f.native.track.getSettings = () => ({ width: 864, height: 540 });
  f.queue.tail = earlier.promise;
  const upgrade = f.run();
  await flush();
  f.stock.track.getSettings = () => ({ width: 864, height: 540 });
  earlier.resolve();
  await upgrade;
  assert.deepEqual(f.replacements, [f.native.track]);
  assert.equal(f.current(), f.native.stream);
  assert.deepEqual(f.committedDimensions, [[864, 540]]);
  assert.equal(f.stockPlan.sourceWidth, 960, 'startup plan is not rewritten to manufacture eligibility');
  assert.equal(f.stock.track.stops, 1);
  assert.equal(f.native.track.stops, 0);
});

test('unknown, oversized or differently shaped current stock geometry keeps stock published', async () => {
  for (const stockSettings of [
    { width: undefined, height: 720 },
    { width: 1280, height: 0 },
    { width: 1281, height: 720 },
    { width: 1280, height: 721 },
    { width: 1280, height: 800 },
    { width: 960, height: 720 },
  ]) {
    const f = fixture();
    f.stock.track.getSettings = () => stockSettings;
    await f.run();
    assert.deepEqual(f.replacements, []);
    assert.equal(f.current(), f.stock.stream);
    assert.equal(f.stock.track.stops, 0);
    assert.equal(f.native.track.stops, 1);
  }
});

test('a native aspect ratio differing from settled stock is rejected even when it fits the startup plan', async () => {
  const f = fixture();
  f.stock.track.getSettings = () => ({ width: 960, height: 540 });
  f.native.track.getSettings = () => ({ width: 864, height: 540 });
  await f.run();
  assert.deepEqual(f.replacements, []);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
});

test('native geometry permits only two pixels of even-rounding difference within preset bounds', async () => {
  for (const width of [866, 868]) {
    const f = fixture();
    f.stock.track.getSettings = () => ({ width: 864, height: 540 });
    f.native.track.getSettings = () => ({ width, height: 540 });
    await f.run();
    assert.equal(f.commits(), width === 866 ? 1 : 0);
    assert.equal(f.stock.track.stops, width === 866 ? 1 : 0);
    assert.equal(f.native.track.stops, width === 866 ? 0 : 1);
  }
});

test('stock geometry changing during native replacement rolls back before native ownership commits', async () => {
  const f = fixture();
  f.replace(async track => {
    if (track === f.native.track) f.stock.track.getSettings = () => ({ width: 960, height: 720 });
  });
  await f.run();
  assert.deepEqual(f.replacements, [f.native.track, f.stock.track]);
  assert.equal(f.current(), f.stock.stream);
  assert.equal(f.commits(), 0);
  assert.equal(f.stock.track.stops, 0);
  assert.equal(f.native.track.stops, 1);
});
