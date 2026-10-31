import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeOpaqueFrameMetrics, writeOpaqueDesktopFrame } from '../src/features/media/screen/nativeOpaqueFrameView';

function frame(patch: Record<string, unknown> = {}) {
  return Object.assign({ format: 'BGRA', timestamp: 123456, duration: null as number | null,
    codedWidth: 1728, codedHeight: 1080, displayWidth: 1728, displayHeight: 1080,
    visibleRect: { x: 0, y: 0, width: 1728, height: 1080 },
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true },
    closes: 0, closeThrows: false,
    close() { this.closes++; if (this.closeThrows) throw Error('close failed'); },
  }, patch);
}
const video = (value: ReturnType<typeof frame>) => value as unknown as VideoFrame;
const opaque = (value: ReturnType<typeof frame>) => frame({ ...value, format: 'BGRX', closes: 0 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('legal null duration admits one view and only real write completion closes it', async () => {
  const input = frame(), output = opaque(input), metrics = createNativeOpaqueFrameMetrics(), gate = deferred();
  const writes: VideoFrame[] = [];
  const pending = writeOpaqueDesktopFrame(video(input), value => { writes.push(value); return gate.promise; }, metrics, () => video(output));
  assert.deepEqual(writes, [output]); assert.equal(output.closes, 0);
  assert.equal(metrics.active, 1); assert.equal(metrics.written, 0);
  // Existing queue.stop can retire its submission/source before this real promise.
  input.close(); assert.equal(output.closes, 0);
  gate.resolve(); await pending;
  assert.equal(input.closes, 1); assert.equal(output.closes, 1);
  assert.equal(metrics.admitted, 1); assert.equal(metrics.written, 1);
  assert.equal(metrics.active, 0); assert.equal(metrics.maxActive, 1); assert.equal(metrics.fallback, 0);
});

test('synchronous and rejected writes propagate without retrying original', async context => {
  for (const sync of [true, false]) await context.test(String(sync), async () => {
    const input = frame(), output = opaque(input), metrics = createNativeOpaqueFrameMetrics(), failure = Error('write failed');
    let writes = 0;
    await assert.rejects(writeOpaqueDesktopFrame(video(input), () => {
      writes++; if (sync) throw failure; return Promise.reject(failure);
    }, metrics, () => video(output)), error => error === failure);
    assert.equal(writes, 1); assert.equal(output.closes, 1); assert.equal(input.closes, 0);
    assert.equal(metrics.fallback, 0); assert.equal(metrics.written, 0); assert.equal(metrics.active, 0);
  });
});

test('construct or validation failures close only owned candidate before a single original write', async context => {
  const cases = ['throw', 'same', 'format', 'duration', 'undefined-duration', 'width', 'rect', 'color', 'unknown-color'] as const;
  for (const kind of cases) await context.test(kind, async () => {
    const input = frame(), output = opaque(input), metrics = createNativeOpaqueFrameMetrics();
    if (kind === 'format') output.format = 'BGRA';
    if (kind === 'duration') output.duration = 500;
    if (kind === 'undefined-duration') Object.assign(input, { duration: undefined });
    if (kind === 'width') output.codedWidth--;
    if (kind === 'rect') output.visibleRect = { ...output.visibleRect, x: 1 };
    if (kind === 'color') output.colorSpace = { ...output.colorSpace, fullRange: false };
    if (kind === 'unknown-color') Object.assign(input.colorSpace, { primaries: undefined });
    const writes: VideoFrame[] = [];
    await writeOpaqueDesktopFrame(video(input), value => { writes.push(value); return Promise.resolve(); }, metrics, () => {
      if (kind === 'throw') throw Error('constructor failed');
      return kind === 'same' ? video(input) : video(output);
    });
    assert.deepEqual(writes, [input]); assert.equal(input.closes, 0);
    assert.equal(output.closes, ['throw', 'same'].includes(kind) ? 0 : 1);
    assert.equal(metrics.fallback, 1); assert.equal(metrics.admitted, 0); assert.equal(metrics.active, 0);
  });
});

test('non-BGRA input does not construct or close a view', async () => {
  const input = frame({ format: 'NV12' }), metrics = createNativeOpaqueFrameMetrics();
  let created = 0, writes = 0;
  await writeOpaqueDesktopFrame(video(input), value => {
    assert.equal(value, input); writes++; return Promise.resolve();
  }, metrics, () => { created++; return video(opaque(input)); });
  assert.equal(created, 0); assert.equal(writes, 1); assert.equal(input.closes, 0);
});

test('close failure remains visible and does not mask the real write result', async context => {
  for (const rejects of [false, true]) await context.test(String(rejects), async () => {
    const input = frame(), output = opaque(input), metrics = createNativeOpaqueFrameMetrics(), failure = Error('write failed');
    output.closeThrows = true;
    const pending = writeOpaqueDesktopFrame(video(input), () => rejects ? Promise.reject(failure) : Promise.resolve(), metrics, () => video(output));
    if (rejects) await assert.rejects(pending, error => error === failure); else await pending;
    assert.equal(metrics.closeFailures, 1); assert.equal(metrics.active, 1);
    assert.equal(metrics.closed, 0); assert.equal(output.closes, 1); assert.equal(input.closes, 0);
    assert.equal(metrics.fallback, 0);
  });
});
