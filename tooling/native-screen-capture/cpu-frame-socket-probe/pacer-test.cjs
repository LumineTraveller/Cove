'use strict';
// CPU-only native pacing verification. Does not import Electron or create a
// WebSocket, VideoFrame, capture session, GPU device or global timer request.
const { performance } = require('node:perf_hooks');
const { startPacer } = require('./pacer.cjs');
const { demand } = require('./protocol.cjs');
async function main() {
  let callbacks = 0;
  const started = performance.now();
  const pacer = startPacer({ seconds: 3, onReady() {}, onTick() { callbacks++; } });
  try {
    const result = await pacer.done;
    demand(result.terminal?.reason === 'duration' && result.terminal.writerJoined, 'pacer_normal_exit_required');
    demand(result.sourceTicksPerSecond >= 118 && result.sourceTicksPerSecond <= 122, 'native_pacer_not_120hz');
    demand(result.mainIoTicksPerSecond >= 118 && result.mainIoTicksPerSecond <= 122, 'main_io_pacer_not_120hz');
    const cpuSeconds = (result.terminal.cpuUserUs + result.terminal.cpuKernelUs) / 1e6;
    demand(cpuSeconds / (result.terminal.elapsedUs / 1e6) < .10, 'native_pacer_cpu_unexpected');
    await pacer.stop();
    demand(!pacer.state().childAlive && !pacer.state().pendingImmediate, 'native_pacer_cleanup_failed');
    console.log(JSON.stringify({ passed: true, scope: 'CPU-only pacer and Node I/O delivery; no Electron or frame throughput claim.',
      elapsedWallMs: performance.now() - started, callbacks, nativeCpuSeconds: cpuSeconds, result: pacer.state() }, null, 2));
  } finally { await pacer.stop(); }
}
if (require.main === module) main().catch(error => {
  console.error(/^[a-z0-9_]{1,80}$/.test(error?.message) ? error.message : 'native_pacer_cpu_test_failed'); process.exitCode = 2;
});
