// Bounded read-only protocol probe. Unknown native input types are no-ops:
// this never moves the pointer, presses a key/button, or opens another window.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const executable = path.resolve(__dirname, process.argv.includes('--baseline')
  ? '../runtime/remote-input-helper-baseline.exe' : '../apps/desktop/build/remote-input-helper.exe');
const startedAt = performance.now();
const helper = spawn(executable, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const samples = [];
const warmupSamples = [];
let seq = 0;
let sentAt = 0;
let output = '';
let readyMs = 0;
const timeout = setTimeout(() => { helper.kill(); throw new Error('No-op probe exceeded 5 seconds'); }, 5000);
const next = () => {
  sentAt = performance.now();
  helper.stdin.write(JSON.stringify({ type: 'noop', seq: ++seq }) + '\n');
};
helper.stderr.on('data', chunk => process.stderr.write(chunk));
helper.stdout.on('data', chunk => {
  output += chunk.toString('utf8');
  let newline;
  while ((newline = output.indexOf('\n')) >= 0) {
    const message = JSON.parse(output.slice(0, newline));
    output = output.slice(newline + 1);
    if (message.ready) { readyMs = performance.now() - startedAt; next(); }
    else if (message.seq === seq) {
      const elapsed = performance.now() - sentAt;
      if (seq > 20) samples.push(elapsed);
      else warmupSamples.push(elapsed);
      if (seq < 220) next();
      else helper.stdin.end('{"type":"stop"}\n');
    } else throw new Error('Unexpected native acknowledgement');
  }
});
helper.on('close', code => {
  clearTimeout(timeout);
  if (code !== 0 || samples.length !== 200) throw new Error(`Incomplete probe: ${code}, ${samples.length}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  const report = {
    capturedAt: new Date().toISOString(),
    kind: 'same-host native pipe round trip; noop only; excludes SendInput, WAN and video',
    samples: samples.length,
    startToReadyMs: readyMs,
    startToFirstAckMs: readyMs + warmupSamples[0],
    firstAckMs: warmupSamples[0],
    first20MaxMs: Math.max(...warmupSamples),
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1),
  };
  const target = process.argv[2];
  if (target) fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
