// Synthetic GPU capability only: no desktop, Electron import or encoder.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const root = path.resolve(__dirname, '../../..');
let helper = path.join(root, 'runtime/nv12-probe/helper.exe');
let addon = path.join(root, 'runtime/native-screen-capture/native-screen-handles.node');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--helper' && args[i + 1]) helper = path.resolve(args[++i]);
  else if (args[i] === '--addon' && args[i + 1]) addon = path.resolve(args[++i]);
  else throw new Error('Expected --helper PATH and/or --addon PATH');
}
if (!fs.existsSync(helper) || !fs.existsSync(addon)) throw new Error('Existing probe helper and handle bridge required');
const bridge = require(addon);
const child = spawn(helper, ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let owner, ready, frame = false, done = false, reason;
const timeout = setTimeout(() => { reason = 'probe_timeout'; child.kill(); }, 10000);
child.once('spawn', () => {
  try { owner = bridge.openChild(child.pid); }
  catch { reason = 'child_owner_open_failed'; child.kill(); }
});
child.once('error', () => { reason = 'probe_spawn_failed'; });
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  try {
    const value = JSON.parse(line);
    if (value.type === 'error') { reason = value.code; return; }
    if (value.probe !== 'nv12-video-processor') throw new Error('unexpected_probe');
    if (value.type === 'ready') {
      if (ready || value.protocol !== 2 || value.pixelFormat !== 'nv12' || value.width !== 64 || value.height !== 64)
        throw new Error('invalid_probe_ready');
      ready = value;
    } else if (value.type === 'frame') {
      if (!ready || frame || value.slot !== 0 || value.serial !== 1 || !value.producerGpuComplete)
        throw new Error('invalid_probe_frame');
      const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(value.handle));
      const owned = owner.duplicate(handle);
      try {
        if (!Buffer.isBuffer(owned.handle) || owned.handle.length !== 8) throw new Error('invalid_duplicate');
        frame = true;
      } finally { owned.close(); }
      // No Electron import happened. Cancel explicitly instead of fabricating
      // imported/released acknowledgements or an allReferencesReleased pass.
      child.stdin.end('stop\n');
    } else if (value.type === 'done') {
      done = value.frames === 1 && value.allReferencesReleased === false;
    }
  } catch (error) { reason = error.message; child.kill(); }
});
child.once('exit', code => {
  clearTimeout(timeout); lines.close(); if (owner) owner.close();
  const passed = !reason && code === 0 && !!ready && frame && done;
  console.log(JSON.stringify({ passed, probe: 'nv12-video-processor', desktopCapture: false,
    capabilityAndColorState: passed, mainOwnedDuplicateClosed: frame, electronImportVerified: false,
    rgbPixelsVerified: false, generatorWriteMeasured: false, ready: ready || null,
    code, reason: reason || null }));
  if (!passed) process.exitCode = 2;
});
