// CPU-only cached shared-memory test. Nothing is captured or installed.
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
  // Check the entire small boundary fixture and sample both ends/page crossings
  // for the larger synthetic frame/maximum mapping without a costly JS scan.
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
  for (let index = 0; index < frames; ++index) assert.equal(read().byteLength, bytesPerFrame);
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
  assert.equal(addon.supportsCachedCpuFrames, true, 'This test requires official CompareObjectHandles support');
  const child = spawn(path.resolve(fixturePath), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const next = linesFor(child);
  let owner;
  try {
    const ready = await next();
    assert.equal(ready.pid, child.pid);
    owner = addon.openChild(child.pid);
    const sources = ready.mappings.map(mapping => handle(mapping.handle));
    const sizes = ready.mappings.map(mapping => mapping.bytes);
    const read = slot => owner.readFrameCached(slot, sources[slot], sizes[slot]);
    const first = sizes.map((bytes, slot) => {
      const value = read(slot);
      assert.equal(value.byteLength, bytes);
      patterned(value);
      return value;
    });
    // Repeated calls validate the same child section object while retaining
    // exactly these three logical cache entries (native harness checks counts).
    for (let iteration = 0; iteration < 200; ++iteration) {
      const value = read(0);
      assert.equal(value.byteLength, sizes[0]);
      assert.equal(new Uint8Array(value)[iteration % sizes[0]], ((iteration % sizes[0]) * 31 + 17) & 255);
    }
    for (const slot of [1, 2, 0, 2, 1]) {
      const value = read(slot);
      assert.equal(value.byteLength, sizes[slot]);
      patterned(value);
    }
    // Existing uncached reads can still request independent exact byte lengths.
    for (const bytes of [1, 7, 4095, 4096, 4097, 8191]) {
      const boundaryOwner = addon.openChild(child.pid);
      try {
        const value = boundaryOwner.readFrameCached(0, sources[0], bytes);
        assert.equal(value.byteLength, bytes);
        patterned(value);
      } finally { boundaryOwner.close(); }
    }
    for (const slot of [-1, 3, 1.5, NaN, Infinity, -Infinity, '0', null, undefined, 0n, true])
      assert.throws(() => owner.readFrameCached(slot, sources[0], sizes[0]), /invalid_frame_slot/);
    for (const bytes of [0, -1, 1.5, NaN, Infinity, -Infinity, 16777217, Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1, '8192', null, undefined, 8192n, true])
      assert.throws(() => owner.readFrameCached(0, sources[0], bytes), /invalid_frame_byte_length/);
    for (const bad of [undefined, null, 1, 'handle', new Uint8Array(8), Buffer.alloc(0), Buffer.alloc(7),
      Buffer.alloc(9), Buffer.alloc(8), Buffer.alloc(8, 255), handle(0x8000000000000000n)])
      assert.throws(() => owner.readFrameCached(0, bad, sizes[0]), /source_handle_must_be_buffer8|invalid_source_handle/);
    assert.throws(() => owner.readFrameCached(0, sources[0]), /expected_slot_source_handle_and_byte_length/);
    assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0], true), /expected_slot_source_handle_and_byte_length/);
    assert.throws(() => owner.readFrameCached.call({}, 0, sources[0], sizes[0]), /invalid_native_handle_owner/);
    assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0] - 1), /cached_frame_mismatch/);
    assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0] + 1), /cached_frame_mismatch/);
    assert.throws(() => owner.readFrameCached(0, sources[1], sizes[0]), /cached_frame_mismatch/);
    assert.throws(() => owner.readFrameCached(1, sources[0], sizes[1]), /cached_frame_mismatch/);
    const invalidOwner = addon.openChild(child.pid);
    try {
      assert.throws(() => invalidOwner.readFrameCached(0, handle(ready.event), 1),
        /source_frame_map_failed|source_handle_duplicate_failed/);
      assert.throws(() => invalidOwner.readFrameCached(0, sources[0], sizes[0] + 1), /source_frame_map_failed/);
      // A failed initial mapping must not occupy or poison the cache slot.
      patterned(invalidOwner.readFrameCached(0, sources[0], sizes[0]));
    } finally { invalidOwner.close(); invalidOwner.close(); }

    child.stdin.write('fill 0 90\n');
    assert.equal((await next()).filled, 0);
    patterned(first[0]);
    const filled = new Uint8Array(read(0));
    assert(filled.every(value => value === 90));
    filled.fill(201);
    assert.equal(new Uint8Array(read(0))[0], 90);
    // One cache slot's producer updates cannot affect the other two sections.
    patterned(read(1)); patterned(read(2));
    assert.equal(owner.readFrame(sources[0], 1).byteLength, 1);
    const resource = owner.duplicate(sources[0]);
    resource.close(); resource.close();
    const closed = addon.openChild(child.pid);
    closed.readFrameCached(0, sources[0], sizes[0]);
    closed.close(); closed.close();
    assert.throws(() => closed.readFrameCached(0, sources[0], sizes[0]), /child_unavailable/);
    assert.throws(() => closed.readFrame(sources[0], 1), /child_unavailable/);
    assert.throws(() => closed.cpuSeconds(), /child_unavailable/);

    function abandonCachedOwner() {
      const abandoned = addon.openChild(child.pid);
      for (let slot = 0; slot < 3; ++slot) abandoned.readFrameCached(slot, sources[slot], sizes[slot]);
    }
    for (let iteration = 0; iteration < 20; ++iteration) abandonCachedOwner();
    await collectGarbage();

    let benchmark;
    if (process.argv.includes('--benchmark')) {
      const bytesPerFrame = sizes[1]; const frames = 600;
      const cached = () => read(1);
      const uncached = () => owner.readFrame(sources[1], bytesPerFrame);
      for (let iteration = 0; iteration < 40; ++iteration) { cached(); uncached(); }
      await collectGarbage();
      const cachedResult = timedCopies(cached, bytesPerFrame, frames);
      await collectGarbage();
      const uncachedResult = timedCopies(uncached, bytesPerFrame, frames);
      benchmark = { cached: cachedResult, uncached: uncachedResult,
        limitation: 'Synthetic copy only; excludes capture, renderer IPC and encoding' };
    }

    // The fixture replaces the child's section after the cache retains its
    // original section. Reusing a raw child-table handle must fail identity
    // comparison instead of silently returning bytes from the stale section.
    child.stdin.write('replace 0\n');
    const replacement = await next();
    assert.equal(replacement.replaced, 0);
    const replacementHandle = handle(replacement.handle);
    assert.throws(() => owner.readFrameCached(0, replacementHandle, sizes[0]), /cached_frame_mismatch/);
    const rawHandleReused = replacement.handle === ready.mappings[0].handle;
    assert.equal(rawHandleReused, true, 'Fixture must recycle the exact raw handle to exercise object identity');
    if (rawHandleReused)
      assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0]), /cached_frame_mismatch/);
    else
      assert.throws(() => owner.readFrameCached(0, sources[0], sizes[0]), /source_handle_duplicate_failed|cached_frame_mismatch/);
    // Replacement is usable by an independent new owner and by the old API.
    const freshOwner = addon.openChild(child.pid);
    try { patterned(freshOwner.readFrameCached(0, replacementHandle, sizes[0])); }
    finally { freshOwner.close(); }
    patterned(owner.readFrame(replacementHandle, sizes[0]));
    patterned(first[0]);

    const exited = once(child, 'exit');
    child.stdin.end('quit\n');
    assert.deepEqual(await exited, [0, null]);
    assert.throws(() => read(1), /child_unavailable/);
    assert.throws(() => owner.readFrame(replacementHandle, 1), /child_unavailable/);
    assert.equal(typeof owner.cpuSeconds(), 'number');
    owner.close(); owner.close();
    first.forEach(patterned);
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, allThreeSlotsExercised: true,
      replacementRejected: true, rawHandleReused, finalizersExercised: Boolean(global.gc), benchmark }));
  } finally {
    if (owner) owner.close();
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
