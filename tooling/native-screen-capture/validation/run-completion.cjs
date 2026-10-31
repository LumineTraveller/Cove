// Synthetic GPU validation only. This runner does not build, install, capture
// the desktop or publish anything. GPU execution starts only when invoked.
const path = require('node:path');
const { spawn } = require('node:child_process');

function options(argv) {
  const result = {
    binary: path.resolve(__dirname, '../../../runtime/native-throughput-20261028-cpu-fence-mapready/synthetic-pipeline-test.exe'),
    pixelFormat: 'cpu-nv12', completion: 'fence', timeoutMs: 120000, stopAfterMs: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (value === undefined || seen.has(name)) throw new Error('Invalid or duplicate validation argument');
    seen.add(name);
    if (name === '--binary') result.binary = path.resolve(value);
    else if (name === '--pixel-format' && ['bgra', 'nv12', 'both', 'cpu-nv12'].includes(value)) result.pixelFormat = value;
    else if (name === '--completion' && ['query', 'fence'].includes(value)) result.completion = value;
    else if (['--timeout-ms', '--stop-after-ms'].includes(name) && /^\d+$/.test(value)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || number > 600000) throw new Error('Invalid validation time');
      result[name === '--timeout-ms' ? 'timeoutMs' : 'stopAfterMs'] = number;
    } else throw new Error('Invalid validation argument');
  }
  if (result.stopAfterMs !== null && (result.completion !== 'fence' || result.stopAfterMs >= result.timeoutMs))
    throw new Error('Scheduled cancellation requires fence and must precede the timeout');
  return result;
}

function run(config) {
  // Async spawn deliberately keeps stdin open as a pipe. spawnSync or .end()
  // would give production Input::pump EOF rather than a cancellable command pipe.
  const child = spawn(config.binary, ['--pixel-format', config.pixelFormat, '--completion', config.completion], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = '', done = null, error = null, invalidProtocol = false;
  let stopReason = null, hardKilled = false, spawnError = false, forceTimer = null;
  const requestStop = reason => {
    if (stopReason || child.exitCode !== null) return;
    stopReason = reason;
    child.stdin.write('stop\n');
    forceTimer = setTimeout(() => { hardKilled = true; child.kill(); }, 2000);
  };
  const timeout = setTimeout(() => requestStop('timeout'), config.timeoutMs);
  const scheduled = config.stopAfterMs === null ? null : setTimeout(() => requestStop('scheduled'), config.stopAfterMs);
  const interrupt = () => requestStop('interrupt');
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  child.stdin.on('error', () => {}); // The child may close its pipe while exiting.
  child.on('error', () => { spawnError = true; });
  const line = value => {
    if (!value.trim()) return;
    process.stdout.write(value + '\n');
    try {
      const record = JSON.parse(value);
      if (record.type === 'done') done = record;
      else if (record.type === 'error') error = record;
    } catch { invalidProtocol = true; }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    pending += data;
    if (pending.length > 1024 * 1024) { invalidProtocol = true; requestStop('protocol'); return; }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, end).replace(/\r$/, '')); pending = pending.slice(end + 1);
    }
  });
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('close', (code, signal) => {
    clearTimeout(timeout); if (scheduled) clearTimeout(scheduled); if (forceTimer) clearTimeout(forceTimer);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (pending) line(pending.replace(/\r$/, ''));
    const cancelled = stopReason === 'scheduled' && code === 2 && error?.code === 'test_cancelled';
    const completed = stopReason === null && code === 0 && done?.passed === true &&
      done.selectedCompletion === config.completion && done.pixelFormat === config.pixelFormat &&
      done.productionCompletion === (config.completion === 'fence') && config.stopAfterMs === null;
    const passed = !spawnError && !invalidProtocol && !hardKilled && (cancelled || completed);
    console.log(JSON.stringify({ type: 'completion-validation', passed, selectedCompletion: config.completion,
      pixelFormat: config.pixelFormat, cancelled, stopReason, hardKilled, exitCode: code, signal,
      spawnError, invalidProtocol, desktopCapture: false }));
    process.exitCode = passed ? 0 : 1;
  });
}

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log('node run-completion.cjs [--binary EXE] [--pixel-format cpu-nv12|nv12|bgra|both] [--completion fence|query] [--timeout-ms N] [--stop-after-ms N]');
} else {
  try { run(options(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
