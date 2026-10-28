// CPU-only pooled shared-memory copy test. Nothing is captured or installed.
// node --expose-gc this-file.cjs ADDON.node FIXTURE.exe [--benchmark]
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

function handle(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value));
  return result;
}
function linesFor(child) {
  const lines = createInterface({ input: child.stdout });
  const queued = []; const pending = [];
  lines.on('line', line => {
    const next = pending.shift();
    if (next) next.resolve(JSON.parse(line));
    else queued.push(JSON.parse(line));
  });
  child.on('exit', () => pending.splice(0).forEach(next => next.reject(new Error('fixture_exited'))));
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_timeout')), 10000);
    pending.push({ resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
  });
}
function patterned(arrayBuffer) {
  assert(arrayBuffer instanceof ArrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length <= 8192) {
    for (let index = 0; index < bytes.length; ++index)
      assert.equal(bytes[index], (index * 31 + 17) & 255);
  } else {
    for (const index of [0, 1, 7, 4095, 4096, 4097, bytes.length >> 1, bytes.length - 2, bytes.length - 1])
      assert.equal(bytes[index], (index * 31 + 17) & 255);
  }
}
async function collectGarbage() {
  if (!global.gc) return;
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
}
function timedCopies(read, bytesPerFrame, frames) {
  const cpu = process.cpuUsage(); const start = process.hrtime.bigint();
  for (let index = 0; index < frames; ++index) read();
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  const used = process.cpuUsage(cpu);
  return { frames, bytesPerFrame, seconds, framesPerSecond: frames / seconds,
    cpuSeconds: (used.user + used.system) / 1e6 };
}

async function main() {
  const [addonPath, fixturePath] = process.argv.slice(2);
  assert(addonPath && fixturePath, 'Expected addon.node and controlled fixture.exe paths');
  const addon = require(path.resolve(addonPath));
  assert.equal(addon.supportsCpuFrames, true);
  assert.equal(addon.supportsCachedCpuFrames, true);
  assert.equal(addon.supportsCachedCpuFramesInto, true, 'This test requires pooled cached copying');
  const child = spawn(path.resolve(fixturePath), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const next = linesFor(child);
  let owner;
  try {
    const ready = await next();
    assert.equal(ready.pid, child.pid);
    owner = addon.openChild(child.pid);
    const sources = ready.mappings.map(mapping => handle(mapping.handle));
    const sizes = ready.mappings.map(mapping => mapping.bytes);
    const targets = sizes.map(bytes => new ArrayBuffer(bytes));
    const readInto = slot => owner.readFrameCachedInto(slot, sources[slot], targets[slot]);
    for (let slot = 0; slot < 3; ++slot) {
      new Uint8Array(targets[slot]).fill(0xa5);
      assert.equal(readInto(slot), undefined);
      assert.equal(targets[slot].byteLength, sizes[slot]);
      patterned(targets[slot]);
    }
    // Allocating and pooled methods share each slot's identity and size, while
    // each returned owned ArrayBuffer remains independent of reusable targets.
    const first = sizes.map((bytes, slot) => {
      const value = owner.readFrameCached(slot, sources[slot], bytes);
      assert.notEqual(value, targets[slot]);
      patterned(value);
      return value;
    });
    const firstTarget = targets[0];
    for (let iteration = 0; iteration < 200; ++iteration) {
      new Uint8Array(firstTarget).fill(iteration & 255);
      assert.equal(readInto(0), undefined);
      assert.equal(targets[0], firstTarget);
      assert.equal(new Uint8Array(firstTarget)[iteration % sizes[0]], ((iteration % sizes[0]) * 31 + 17) & 255);
    }
    for (const slot of [1, 2, 0, 2, 1]) {
      assert.equal(readInto(slot), undefined);
      patterned(targets[slot]);
      patterned(owner.readFrameCached(slot, sources[slot], sizes[slot]));
    }
    patterned(owner.readFrame(sources[0], sizes[0]));
    // An allocating method may initialize a cache that pooled copying reuses.
    const allocatingFirst = addon.openChild(child.pid);
    try {
      patterned(allocatingFirst.readFrameCached(0, sources[0], sizes[0]));
      const destination = new ArrayBuffer(sizes[0]);
      assert.equal(allocatingFirst.readFrameCachedInto(0, sources[0], destination), undefined);
      patterned(destination);
    } finally { allocatingFirst.close(); }

    for (const bytes of [1, 7, 4095, 4096, 4097, 8191]) {
      const boundaryOwner = addon.openChild(child.pid);
      try {
        const destination = new ArrayBuffer(bytes);
        assert.equal(boundaryOwner.readFrameCachedInto(0, sources[0], destination), undefined);
        assert.equal(destination.byteLength, bytes);
        patterned(destination);
      } finally { boundaryOwner.close(); }
    }
    for (const slot of [-1, 3, 1.5, NaN, Infinity, -Infinity, '0', null, undefined, 0n, true])
      assert.throws(() => owner.readFrameCachedInto(slot, sources[0], targets[0]), /invalid_frame_slot/);
    for (const bad of [undefined, null, 1, 'handle', new Uint8Array(8), Buffer.alloc(0), Buffer.alloc(7),
      Buffer.alloc(9), Buffer.alloc(8), Buffer.alloc(8, 255), handle(0x8000000000000000n)])
      assert.throws(() => owner.readFrameCachedInto(0, bad, targets[0]), /source_handle_must_be_buffer8|invalid_source_handle/);

    const detached = new ArrayBuffer(sizes[0]);
    structuredClone(detached, { transfer: [detached] });
    assert.equal(detached.byteLength, 0);
    const invalidTargets = [undefined, null, 1, 8192n, 'target', true, {}, [],
      new ArrayBuffer(0), new ArrayBuffer(16 * 1024 * 1024 + 1),
      Buffer.alloc(sizes[0]), new Uint8Array(sizes[0]), new DataView(new ArrayBuffer(sizes[0])),
      new Proxy(new ArrayBuffer(sizes[0]), {}), Object.create(ArrayBuffer.prototype), detached];
    if (typeof SharedArrayBuffer === 'function') invalidTargets.push(new SharedArrayBuffer(sizes[0]));
    for (const target of invalidTargets)
      assert.throws(() => owner.readFrameCachedInto(0, sources[0], target), /invalid_frame_target|native_handle_api_failed/);
    assert.throws(() => owner.readFrameCachedInto(0, sources[0]), /expected_slot_source_handle_and_target/);
    assert.throws(() => owner.readFrameCachedInto(0, sources[0], targets[0], true), /expected_slot_source_handle_and_target/);
    assert.throws(() => owner.readFrameCachedInto.call({}, 0, sources[0], targets[0]), /invalid_native_handle_owner/);
    const wrongSize = new ArrayBuffer(sizes[0] - 1);
    new Uint8Array(wrongSize).fill(0xa5);
    assert.throws(() => owner.readFrameCachedInto(0, sources[0], wrongSize), /cached_frame_mismatch/);
    assert(new Uint8Array(wrongSize).every(value => value === 0xa5));
    assert.throws(() => owner.readFrameCachedInto(0, sources[0], new ArrayBuffer(sizes[0] + 1)), /cached_frame_mismatch/);
    new Uint8Array(targets[0]).fill(0xa5);
    assert.throws(() => owner.readFrameCachedInto(0, sources[1], targets[0]), /cached_frame_mismatch/);
    assert(new Uint8Array(targets[0]).every(value => value === 0xa5));
    assert.throws(() => owner.readFrameCachedInto(1, sources[0], targets[1]), /cached_frame_mismatch/);
    const invalidOwner = addon.openChild(child.pid);
    try {
      assert.throws(() => invalidOwner.readFrameCachedInto(0, handle(ready.event), new ArrayBuffer(1)),
        /source_frame_map_failed|source_handle_duplicate_failed/);
      assert.throws(() => invalidOwner.readFrameCachedInto(0, sources[0], new ArrayBuffer(sizes[0] + 1)), /source_frame_map_failed/);
      assert.equal(invalidOwner.readFrameCachedInto(0, sources[0], targets[0]), undefined);
      patterned(targets[0]);
    } finally { invalidOwner.close(); invalidOwner.close(); }

    child.stdin.write('fill 0 90\n');
    assert.equal((await next()).filled, 0);
    patterned(first[0]);
    assert.equal(readInto(0), undefined);
    assert(new Uint8Array(targets[0]).every(value => value === 90));
    new Uint8Array(targets[0]).fill(201);
    const filledOwnedCopy = owner.readFrameCached(0, sources[0], sizes[0]);
    assert(new Uint8Array(filledOwnedCopy).every(value => value === 90));
    assert.equal(readInto(0), undefined);
    assert(new Uint8Array(targets[0]).every(value => value === 90));
    assert.equal(new Uint8Array(filledOwnedCopy)[0], 90);
    patterned(targets[1]); patterned(targets[2]);
    assert.equal(new Uint8Array(owner.readFrame(sources[0], 1))[0], 90);

    const closed = addon.openChild(child.pid);
    assert.equal(closed.readFrameCachedInto(0, sources[0], targets[0]), undefined);
    closed.close(); closed.close();
    assert.throws(() => closed.readFrameCachedInto(0, sources[0], targets[0]), /child_unavailable/);
    assert.throws(() => closed.readFrameCached(0, sources[0], sizes[0]), /child_unavailable/);
    assert.throws(() => closed.readFrame(sources[0], 1), /child_unavailable/);
    function abandonPooledOwner() {
      const abandoned = addon.openChild(child.pid);
      for (let slot = 0; slot < 3; ++slot)
        assert.equal(abandoned.readFrameCachedInto(slot, sources[slot], targets[slot]), undefined);
    }
    for (let iteration = 0; iteration < 20; ++iteration) abandonPooledOwner();
    await collectGarbage();

    let benchmark;
    if (process.argv.includes('--benchmark')) {
      const bytesPerFrame = sizes[1]; const frames = 600;
      const pooled = () => assert.equal(readInto(1), undefined);
      const allocating = () => assert.equal(owner.readFrameCached(1, sources[1], bytesPerFrame).byteLength, bytesPerFrame);
      for (let iteration = 0; iteration < 40; ++iteration) { pooled(); allocating(); }
      await collectGarbage();
      const pooledResult = timedCopies(pooled, bytesPerFrame, frames);
      await collectGarbage();
      const allocatingResult = timedCopies(allocating, bytesPerFrame, frames);
      benchmark = { pooled: pooledResult, cachedAllocating: allocatingResult,
        limitation: 'Sequential synthetic copy only; excludes capture, renderer IPC and encoding' };
    }

    child.stdin.write('replace 0\n');
    const replacement = await next();
    assert.equal(replacement.replaced, 0);
    const rawHandleReused = replacement.handle === ready.mappings[0].handle;
    assert.equal(rawHandleReused, true, 'Fixture must recycle the exact raw handle to exercise object identity');
    const replacementHandle = handle(replacement.handle);
    new Uint8Array(targets[0]).fill(0xc3);
    assert.throws(() => owner.readFrameCachedInto(0, replacementHandle, targets[0]), /cached_frame_mismatch/);
    assert.throws(() => owner.readFrameCachedInto(0, sources[0], targets[0]), /cached_frame_mismatch/);
    assert(new Uint8Array(targets[0]).every(value => value === 0xc3));
    assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0]), /cached_frame_mismatch/);
    const freshOwner = addon.openChild(child.pid);
    try {
      assert.equal(freshOwner.readFrameCachedInto(0, replacementHandle, targets[0]), undefined);
      patterned(targets[0]);
    } finally { freshOwner.close(); }
    patterned(owner.readFrame(replacementHandle, sizes[0]));
    patterned(first[0]);
    assert.equal(new Uint8Array(filledOwnedCopy)[0], 90);

    const exited = once(child, 'exit');
    child.stdin.end('quit\n');
    assert.deepEqual(await exited, [0, null]);
    assert.throws(() => readInto(1), /child_unavailable/);
    assert.throws(() => owner.readFrameCached(1, sources[1], sizes[1]), /child_unavailable/);
    assert.equal(typeof owner.cpuSeconds(), 'number');
    owner.close(); owner.close();
    targets.forEach(patterned);
    first.forEach(patterned);
    assert.equal(new Uint8Array(filledOwnedCopy)[0], 90);
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, allThreeSlotsExercised: true,
      targetReused: true, targetBrandAndDetachmentChecked: true, sharedCacheWithAllocatingMethod: true,
      replacementRejected: true, rawHandleReused, finalizersExercised: Boolean(global.gc), benchmark }));
  } finally {
    if (owner) owner.close();
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
