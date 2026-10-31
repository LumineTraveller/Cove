const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const repoRoot = path.resolve(__dirname, '../../..');
const runtime = path.join(repoRoot, 'runtime', 'native-screen-capture');
let addonPath;
let childPath = path.join(runtime, 'handle-test-child.exe');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--addon' && args[i + 1]) addonPath = path.resolve(args[++i]);
  else if (args[i] === '--child' && args[i + 1]) childPath = path.resolve(args[++i]);
  else throw new Error('Expected --addon PATH and/or --child PATH');
}
addonPath ||= [path.join(repoRoot, 'apps', 'desktop', 'build', 'native-screen-handles.node'),
  path.join(runtime, 'native-screen-handles.node')].find(candidate => fs.existsSync(candidate));
if (!addonPath || !fs.existsSync(addonPath) || !fs.existsSync(childPath)) {
  throw new Error('Existing addon and owned event child are required; run validation/run.ps1 first');
}
if (typeof global.gc !== 'function') throw new Error('Run this test with node --expose-gc');
const api = require(addonPath);
const child = spawn(childPath, [String(process.pid)], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout });
const queue = [], pending = [];
lines.on('line', line => {
  const value = JSON.parse(line);
  if (pending.length) pending.shift()(value); else queue.push(value);
});
function next() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => pending.push(resolve)); }
async function command(text) { child.stdin.write(`${text}\n`); return next(); }
function buffer(hex) { const value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(hex)); return value; }
function hex(value) { return `0x${value.readBigUInt64LE().toString(16)}`; }
let session;
const deadline = setTimeout(() => { child.kill(); process.exitCode = 3; }, 15000);
(async () => {
  const ready = await next();
  const source = buffer(ready.handle);
  assert.throws(() => api.openChild(process.pid), /invalid_child_pid/);
  assert.throws(() => api.openChild(0), /invalid_child_pid/);
  assert.throws(() => api.openChild(NaN), /invalid_child_pid/);
  assert.throws(() => api.openChild('1'), /invalid_child_pid/);
  session = api.openChild(child.pid);
  let helperCpuSeconds = session.cpuSeconds();
  assert.equal(typeof helperCpuSeconds, 'number');
  assert.ok(Number.isFinite(helperCpuSeconds) && helperCpuSeconds >= 0);
  assert.throws(() => session.cpuSeconds.call({}), /invalid_native_handle_owner/);
  assert.throws(() => session.duplicate(Buffer.alloc(7)), /buffer8/);
  assert.throws(() => session.duplicate(Buffer.alloc(8)), /invalid_source_handle/);
  assert.throws(() => session.duplicate(Buffer.alloc(8, 255)), /invalid_source_handle/);
  assert.throws(() => session.duplicate.call({}, source), /invalid_native_handle_owner/);
  const owner = session.duplicate(source);
  const original = Buffer.from(owner.handle);
  assert.equal((await command(`check ${hex(original)}`)).valid, true);
  assert.throws(() => owner.close.call(session), /invalid_native_handle_owner/);
  owner.close();
  assert.equal((await command(`check ${hex(original)}`)).valid, false);
  owner.close();
  const injected = [];
  let recycled = false;
  for (let i = 0; i < 32 && !recycled; ++i) {
    const remote = await command('allocate'); injected.push(remote.handle);
    recycled = remote.handle.toLowerCase() === hex(original).toLowerCase();
  }
  assert.equal(recycled, true, 'Owned test event must exercise a recycled main handle value');
  owner.close();
  for (const remote of injected) assert.equal((await command(`check ${remote}`)).valid, true);
  let gcOwner = session.duplicate(source);
  const gcValue = Buffer.from(gcOwner.handle);
  assert.equal((await command(`check ${hex(gcValue)}`)).valid, true);
  gcOwner = null;
  let finalized = false;
  for (let i = 0; i < 20 && !finalized; ++i) {
    global.gc(); await new Promise(resolve => setTimeout(resolve, 10));
    finalized = !(await command(`check ${hex(gcValue)}`)).valid;
  }
  assert.equal(finalized, true, 'GC finalizer must close its owned main handle');
  const compatible = api.duplicateFromChild(child.pid, source); compatible.close(); compatible.close();
  const nextCpuSeconds = session.cpuSeconds();
  assert.ok(Number.isFinite(nextCpuSeconds) && nextCpuSeconds >= helperCpuSeconds);
  helperCpuSeconds = nextCpuSeconds;
  const survivor = session.duplicate(source);
  const exited = once(child, 'exit'); child.stdin.end('stop\n');
  const [code] = await exited; assert.equal(code, 0);
  const finalCpuSeconds = session.cpuSeconds();
  assert.ok(Number.isFinite(finalCpuSeconds) && finalCpuSeconds >= helperCpuSeconds);
  assert.throws(() => session.duplicate(source), /child_unavailable/);
  survivor.close(); survivor.close();
  session.close(); session.close();
  assert.throws(() => session.duplicate(source), /child_unavailable/);
  assert.throws(() => session.cpuSeconds(), /child_unavailable/);
  console.log(JSON.stringify({ passed: true, gpu: false, desktopCapture: false, actualChild: true,
    explicitCloseInvalidatedHandle: true, recycledHandleSurvivedRepeatedClose: recycled,
    gcFinalizerClosedHandle: finalized, childExitRejected: true, closedSessionRejected: true,
    helperCpuSecondsNumeric: true, helperCpuSecondsNondecreasing: true, cpuSecondsClosedRejected: true }));
})().catch(error => { console.error(error); process.exitCode = 2; child.kill(); }).finally(() => {
  clearTimeout(deadline); if (session) session.close();
});
