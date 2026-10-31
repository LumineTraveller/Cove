// CPU-only standalone test: node --expose-gc this-file.cjs ADDON.node FIXTURE.exe [--benchmark]
// Builds are explicit and separate; this test installs or captures nothing.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

function handle(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
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
async function main() {
  const [addonPath, fixturePath] = process.argv.slice(2);
  assert(addonPath && fixturePath, 'Expected addon.node and controlled fixture.exe paths');
  const addon = require(path.resolve(addonPath));
  assert.equal(addon.supportsCpuFrames, true);
  const child = spawn(path.resolve(fixturePath), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const next = linesFor(child);
  let owner;
  try {
    const ready = await next();
    assert.equal(ready.pid, child.pid);
    owner = addon.openChild(child.pid);
    const source = handle(ready.mappings[0].handle);
    const read = bytes => owner.readFrame(source, bytes);
    assert.equal(typeof owner.cpuSeconds(), 'number');
    assert.throws(() => addon.openChild(process.pid), /invalid_child_pid/);
    assert.throws(() => addon.openChild(4), /child_not_owned|child_unavailable/);
    const copy = read(8192);
    assert(copy instanceof ArrayBuffer);
    assert.equal(copy.byteLength, 8192);
    for (let i = 0; i < copy.byteLength; ++i) assert.equal(new Uint8Array(copy)[i], (i * 31 + 17) & 255);
    for (const bytes of [1, 7, 4095, 4096, 4097, 8191]) {
      const exact = read(bytes);
      assert.equal(exact.byteLength, bytes);
      assert.equal(new Uint8Array(exact)[bytes - 1], ((bytes - 1) * 31 + 17) & 255);
    }
    for (const bytes of [0, -1, 1.5, NaN, Infinity, -Infinity, 16777217, Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1, '8192', null, undefined, 8192n, true]) {
      assert.throws(() => read(bytes), /invalid_frame_byte_length/);
    }
    for (const bad of [undefined, null, 1, 'handle', new Uint8Array(8), Buffer.alloc(0), Buffer.alloc(7),
      Buffer.alloc(9), Buffer.alloc(8), Buffer.alloc(8, 255), handle(0x8000000000000000n)]) {
      assert.throws(() => owner.readFrame(bad, 1), /source_handle_must_be_buffer8|invalid_source_handle/);
    }
    assert.throws(() => owner.readFrame(source), /expected_source_handle_and_byte_length/);
    assert.throws(() => owner.readFrame(source, 1, 2), /expected_source_handle_and_byte_length/);
    assert.throws(() => owner.readFrame.call({}, source, 1), /invalid_native_handle_owner/);
    assert.throws(() => owner.readFrame(handle(ready.event), 1), /source_frame_map_failed|source_handle_duplicate_failed/);
    assert.throws(() => owner.readFrame(source, 8193), /source_frame_map_failed/);
    assert.throws(() => owner.readFrame(source, 16 * 1024 * 1024), /source_frame_map_failed/);
    const maximum = owner.readFrame(handle(ready.mappings[2].handle), 16 * 1024 * 1024);
    assert.equal(maximum.byteLength, 16 * 1024 * 1024);
    assert.equal(new Uint8Array(maximum)[maximum.byteLength - 1], ((maximum.byteLength - 1) * 31 + 17) & 255);
    // The result is independent owned memory: writes in either process cannot
    // mutate the other's bytes after the copy/ack boundary.
    child.stdin.write('fill 0 90\n');
    assert.equal((await next()).filled, 0);
    assert.equal(new Uint8Array(copy)[0], 17);
    const filled = new Uint8Array(read(8192));
    assert(filled.every(value => value === 90));
    filled.fill(201);
    assert.equal(new Uint8Array(read(1))[0], 90);
    const resource = owner.duplicate(source);
    assert(Buffer.isBuffer(resource.handle));
    resource.close(); resource.close();
    const separate = addon.openChild(child.pid);
    separate.close(); separate.close();
    assert.throws(() => separate.readFrame(source, 1), /child_unavailable/);
    assert.throws(() => separate.duplicate(source), /child_unavailable/);
    assert.throws(() => separate.cpuSeconds(), /child_unavailable/);
    // Session and resource GC finalizers must coexist with explicit close.
    for (let i = 0; i < 200; ++i) {
      addon.openChild(child.pid);
      owner.duplicate(source);
    }
    if (global.gc) { global.gc(); await new Promise(resolve => setImmediate(resolve)); global.gc(); }
    let benchmark;
    if (process.argv.includes('--benchmark')) {
      const frame = ready.mappings[1]; const frameHandle = handle(frame.handle);
      const frames = 1200;
      for (let i = 0; i < 60; ++i) owner.readFrame(frameHandle, frame.bytes);
      if (global.gc) global.gc();
      const cpu = process.cpuUsage(); const start = process.hrtime.bigint();
      for (let i = 0; i < frames; ++i) {
        const value = owner.readFrame(frameHandle, frame.bytes);
        assert.equal(value.byteLength, frame.bytes);
      }
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const used = process.cpuUsage(cpu);
      benchmark = { frames, bytesPerFrame: frame.bytes, seconds,
        framesPerSecond: frames / seconds, cpuSeconds: (used.user + used.system) / 1e6 };
    }
    const exited = once(child, 'exit');
    child.stdin.end('quit\n');
    assert.deepEqual(await exited, [0, null]);
    assert.throws(() => read(1), /child_unavailable/);
    assert.equal(typeof owner.cpuSeconds(), 'number');
    owner.close(); owner.close();
    assert.equal(new Uint8Array(copy)[0], 17);
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, boundaryCases: 48,
      finalizersExercised: Boolean(global.gc), benchmark }));
  } finally {
    if (owner) owner.close();
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
