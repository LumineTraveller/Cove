// Offline analysis only: consumes an explicitly supplied export, never connects.
const fs = require('node:fs');
const { MEDIA_TIMING_DEFINITIONS, diagnosticRoundTripTimeMs } = require('../packages/client-core/dist');
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function distribution(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return sorted.length ? {
    count: sorted.length, min: sorted[0], median: percentile(0.5), p95: percentile(0.95),
    max: sorted[sorted.length - 1], mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  } : { count: 0, min: null, median: null, p95: null, max: null, mean: null };
}

function analyzeMediaDiagnostics(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.samples) || input.samples.length > 10_000)
    throw new Error('Expected a Cove diagnostics export with at most 10000 samples');
  const rtt = [], fps = [], bitrate = [];
  if (input.platform === 'android') {
    const transport = input.stage?.sharing ? 'screenSend' : input.stage?.watching ? 'receive' : 'send';
    const samples = input.samples.filter(sample => sample?.transport === transport);
    const validSamples = samples.filter(sample => sample.values && typeof sample.values === 'object');
    const value = diagnosticRoundTripTimeMs(validSamples, transport);
    if (value !== null) rtt.push(value);
    const video = samples.find(sample => sample.kind === 'video' && ['inbound-rtp', 'outbound-rtp'].includes(sample.type));
    if (finite(video?.values?.framesPerSecond)) fps.push(video.values.framesPerSecond);
    if (finite(input.interval?.videoBitrateBps)) bitrate.push(input.interval.videoBitrateBps / 1000);
  } else {
    for (const sample of input.samples) {
      const stats = sample?.stats;
      if (!stats) continue;
      if (finite(stats.rtt)) rtt.push(stats.rtt);
      const frameRate = stats.role === 'sender' ? stats.sendFps : stats.receiveFps;
      if (finite(frameRate)) fps.push(frameRate);
      if (finite(stats.bitrate)) bitrate.push(stats.bitrate);
    }
  }
  return {
    schemaVersion: 1,
    source: input.platform === 'android' ? 'android-export' : 'desktop-export',
    metricDefinitions: MEDIA_TIMING_DEFINITIONS,
    rttMs: distribution(rtt), videoFps: distribution(fps), videoBitrateKbps: distribution(bitrate),
    endToEndLatencyMs: null,
    note: 'RTT is client/SFU round-trip time. No capture-to-display delay or improvement is inferred. A single Android export is one sampling window.',
  };
}

if (require.main === module) {
  try {
    const filename = process.argv[2];
    if (!filename || process.argv.length !== 3) throw new Error('Usage: node tooling/analyze-media-diagnostics.cjs <export.json>');
    if (fs.statSync(filename).size > 32 * 1024 * 1024) throw new Error('Diagnostics export exceeds 32 MiB');
    console.log(JSON.stringify(analyzeMediaDiagnostics(JSON.parse(fs.readFileSync(filename, 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { analyzeMediaDiagnostics, distribution };
