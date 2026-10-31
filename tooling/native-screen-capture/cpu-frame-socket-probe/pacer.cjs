'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { summary, demand } = require('./protocol.cjs');
const binary = path.resolve(__dirname, '../../../runtime/cpu-frame-socket-probe/pacer.exe');

// Native ticks drive I/O callbacks; setImmediate only coalesces an I/O batch.
// It is not a timer, spin loop or a source of synthetic extra phase credits.
function startPacer({ seconds, onReady, onTick, check = () => {} }) {
  demand(Number.isInteger(seconds) && seconds >= 2 && seconds <= 35, 'invalid_pacer_duration');
  demand(fs.existsSync(binary) && fs.statSync(binary).isFile(), 'built_native_pacer_required');
  const child = spawn(binary, ['--owner-pid', String(process.pid), '--seconds', String(seconds)], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); child.stderr.resume();
  let resolveDone, rejectDone, settle = false, closed = false, pending = '', ready = false, lastSeq = 0;
  let immediate = null, latest = null, terminal = null, failure = null, stopping = null, firstArrival = null, lastArrival = null;
  let readyTimer = null, watchdog = null;
  const gaps = [], stats = { kind: 'win32-high-resolution-waitable-timer', targetFps: 120, ready: false,
    sourceRecords: 0, ioCallbacks: 0, ioCoalescedTicks: 0, nativeSkippedPhases: 0, maxNativeSequence: 0 };
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  function finish() {
    if (settle) return; settle = true; clearTimeout(readyTimer); clearTimeout(watchdog); clearImmediate(immediate); immediate = null;
    if (failure || !terminal) rejectDone(new Error(failure || 'native_pacer_missing_done'));
    else resolveDone(state());
  }
  function fault(code) { failure ||= code; void stop(); }
  function deliver() {
    immediate = null; const tick = latest; latest = null;
    if (!tick || failure) return;
    try {
      check(); const now = performance.now();
      if (lastArrival !== null) gaps.push(now - lastArrival);
      firstArrival ??= now; lastArrival = now; stats.ioCallbacks++;
      onTick(tick);
    } catch (error) { fault(/^[a-z0-9_]{1,80}$/.test(error?.message) ? error.message : 'native_pacer_callback_failed'); }
  }
  function record(value) {
    demand(value && typeof value === 'object', 'invalid_native_pacer_protocol');
    if (value.type === 'ready') {
      demand(!ready && value.fps === 120 && value.highResolution === true, 'invalid_native_pacer_ready');
      ready = stats.ready = true; clearTimeout(readyTimer); readyTimer = null; check(); onReady?.();
    } else if (value.type === 'tick') {
      demand(ready && !terminal && Number.isInteger(value.seq) && value.seq > lastSeq && value.seq <= 5000 &&
        Number.isFinite(value.elapsedUs) && value.elapsedUs >= 0 && value.elapsedUs <= (seconds + 2) * 1e6 &&
        Number.isFinite(value.lateUs) && value.lateUs >= 0 && value.lateUs <= 2000000 &&
        Number.isInteger(value.skipped) && value.skipped >= 0 && value.skipped <= 5000, 'invalid_native_pacer_tick');
      lastSeq = value.seq; stats.sourceRecords++; stats.nativeSkippedPhases += value.skipped; stats.maxNativeSequence = value.seq;
      if (latest) stats.ioCoalescedTicks++; latest = value;
      if (!immediate) immediate = setImmediate(deliver);
    } else if (value.type === 'done') {
      demand(ready && !terminal && Number.isInteger(value.ticks) && value.ticks >= 0 && value.ticks <= 5000 &&
        Number.isInteger(value.skipped) && value.skipped >= 0 && value.skipped <= 5000 &&
        Number.isFinite(value.elapsedUs) && value.elapsedUs > 0 && value.elapsedUs <= (seconds + 2) * 1e6 &&
        Number.isFinite(value.cpuUserUs) && value.cpuUserUs >= 0 && Number.isFinite(value.cpuKernelUs) && value.cpuKernelUs >= 0 &&
        ['duration', 'stop', 'owner_exit'].includes(value.reason) && typeof value.writerJoined === 'boolean', 'invalid_native_pacer_done');
      terminal = { ticks: value.ticks, skipped: value.skipped, elapsedUs: value.elapsedUs, cpuUserUs: value.cpuUserUs,
        cpuKernelUs: value.cpuKernelUs, reason: value.reason, writerJoined: value.writerJoined };
      clearImmediate(immediate); immediate = null; deliver();
    } else demand(false, 'unknown_native_pacer_record');
  }
  child.stdout.on('data', chunk => {
    if (failure) return;
    try {
      pending += chunk.toString('utf8'); demand(pending.length <= 65536, 'native_pacer_output_overflow');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        demand(line.length > 0 && line.length <= 512, 'native_pacer_line_invalid'); record(JSON.parse(line));
      }
      demand(pending.length <= 512, 'native_pacer_line_overflow');
    } catch (error) { fault(/^[a-z0-9_]{1,80}$/.test(error?.message) ? error.message : 'native_pacer_invalid_json'); }
  });
  child.once('error', () => { failure ||= 'native_pacer_spawn_failed'; closed = true; finish(); });
  child.once('close', code => { closed = true; if (code !== 0) failure ||= 'native_pacer_exit_failed'; finish(); });
  readyTimer = setTimeout(() => fault('native_pacer_ready_timeout'), 2000);
  watchdog = setTimeout(() => fault('native_pacer_watchdog'), (seconds + 3) * 1000);
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!closed) {
        try { child.stdin.end('stop\n'); } catch {}
        await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => {
          const timer = setTimeout(() => { if (!closed) child.kill(); resolve(); }, 750);
          child.once('close', () => { clearTimeout(timer); resolve(); });
        })]);
      }
      if (!closed) { failure ||= 'native_pacer_cleanup_timeout'; finish(); }
      return state();
    })();
    return stopping;
  }
  function state() {
    return { ...stats, terminal, sourceTicksPerSecond: terminal ? terminal.ticks / (terminal.elapsedUs / 1e6) : null,
      mainIoTicksPerSecond: stats.ioCallbacks > 1 && lastArrival > firstArrival ? (stats.ioCallbacks - 1) * 1000 / (lastArrival - firstArrival) : null,
      mainIoGapMs: summary(gaps), childAlive: !closed, pendingImmediate: !!immediate, pendingReadyTimer: !!readyTimer && !ready,
      failure };
  }
  return { done, stop, state };
}
module.exports = { startPacer, binary };
