// Repeated local regression evidence; elapsed time is test duration, not media latency.
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const suites = [
  { name: 'desktop-recovery', cwd: 'apps/desktop', args: ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/connectionDeadline.test.ts', 'tests/sessionRegistration.test.ts', 'tests/voiceConnectionRecovery.test.ts', 'tests/screenWatchRecovery.test.ts', 'tests/screenPublicationLifecycle.test.ts', 'tests/screenAudioLifecycle.test.ts', 'tests/screenCodecCompatibility.test.ts'] },
  { name: 'mobile-media', cwd: 'apps/mobile', args: ['node_modules/jest/bin/jest.js', '--runInBand', '--no-cache', '__tests__/useMobileMedia.test.tsx', '__tests__/useMobileScreenShare.test.tsx', '__tests__/sessionLoginFlow.test.tsx'] },
  { name: 'loopback-recovery', cwd: '.', args: ['--import', 'tsx', '--test', '--test-concurrency=1', 'apps/server/tests/connectionRecovery.test.ts', 'apps/server/tests/mobileRemoteControlRecovery.test.ts', 'apps/server/tests/mediaLifecycle.test.ts', 'apps/server/tests/mediaNativeIntegration.test.ts'] },
];
async function runSuite(suite, timeoutMs = 180_000) {
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, suite.args, { cwd: path.join(root, suite.cwd), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain bounded output without collecting payloads, addresses or credentials.
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let timedOut = false, cancelled = false, stopping = false;
    const stop = () => {
      if (stopping || !child.pid) return;
      stopping = true;
      // Kill only this owned test tree, never other node/Electron processes.
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
    };
    const interrupted = () => { cancelled = true; stop(); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); };
    const result = code => ({ suite: suite.name, passed: code === 0 && !timedOut && !cancelled, exitCode: code, timedOut, cancelled, testDurationMs: Math.round(performance.now() - started) });
    child.once('error', error => { cleanup(); resolve({ ...result(null), errorCode: error.code ?? 'SPAWN_FAILED' }); });
    child.once('close', code => { cleanup(); resolve(result(code)); });
  });
}
async function main(args) {
  let repeat = 1, output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--repeat') repeat = Number(args[++index]);
    else if (args[index] === '--output') output = args[++index];
    else throw new Error('Usage: node tooling/verify-media-recovery.cjs [--repeat 1..10] [--output report.json]');
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10 || (args.includes('--output') && !output)) throw new Error('Invalid repeat count or output path');
  const results = [];
  for (let round = 1; round <= repeat; round++) {
    for (const suite of suites) {
      const result = await runSuite(suite);
      results.push({ round, ...result });
      if (!result.passed) break;
    }
    if (results.some(result => !result.passed)) break;
  }
  const report = { schemaVersion: 1, node: process.version, platform: process.platform, repetitions: repeat,
    scope: 'local synthetic and hook regressions; not Android/weak-network acceptance',
    testDurationIsMediaLatency: false, passed: results.every(result => result.passed), results };
  const text = JSON.stringify(report, null, 2);
  if (output) fs.writeFileSync(path.resolve(output), text + '\n');
  console.log(text);
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { suites, runSuite };
