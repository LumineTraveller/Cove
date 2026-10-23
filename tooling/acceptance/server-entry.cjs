'use strict';
// This entry belongs only to the portable acceptance server, never a service.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readConfig } = require('./portable-common.cjs');
const root = __dirname;
const config = readConfig(root);
for (const name of ['NODE_PATH', 'MEDIASOUP_WORKER_BIN', 'MEDIASOUP_USE_VALGRIND', 'MEDIASOUP_BUILDTYPE']) delete process.env[name];
Object.assign(process.env, {
  COVE_DATA_DIR: path.join(config.state, 'server'),
  COVE_DOWNLOAD_DIR: path.join(config.state, 'downloads'),
  COVE_HTTP_PORT: String(config.httpPort), COVE_HTTP_HOST: config.listenHost,
  MEDIASOUP_PORT: String(config.mediaPort), MEDIASOUP_IP: config.announceAddress, MEDIASOUP_LISTEN_IP: config.listenHost,
  COVE_SERVER_SECURITY_ENABLED: 'false', UPDATE_DOWNLOAD_BASE_URL: '',
});
const check = process.argv.includes('--check');
const smoke = process.argv.includes('--smoke');
async function main() {
  if (check) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try { if (db.prepare('SELECT 7 AS value').get().value !== 7) throw new Error('SQLite probe failed'); }
    finally { db.close(); }
    const ffmpeg = spawnSync(require('ffmpeg-static'), ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (ffmpeg.status !== 0) throw new Error('Bundled FFmpeg probe failed');
    const worker = await require('mediasoup').createWorker({ logLevel: 'error' });
    worker.close();
    console.log(JSON.stringify({ ok: true, node: process.version, modules: process.versions.modules,
      sqlite: true, mediasoup: true, ffmpeg: ffmpeg.stdout.split(/\r?\n/)[0] }));
    return;
  }
  fs.mkdirSync(process.env.COVE_DATA_DIR, { recursive: true });
  const { startServer, stopServer } = require('./dist/index.js');
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await stopServer(); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  const port = await startServer(smoke ? 0 : config.httpPort);
  console.log(`Cove Acceptance Server ${config.sourceVersion} (${config.sourceCommit})`);
  console.log(`HTTP http://${config.listenHost}:${port}; media ${config.announceAddress}:${config.mediaPort} (TCP/UDP)`);
  console.log(`Isolated test data: ${process.env.COVE_DATA_DIR}`);
  if (smoke) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Packaged server HTTP probe failed: ${response.status}`);
    } finally { await stop(); }
    console.log(JSON.stringify({ ok: true, http: true, port, data: process.env.COVE_DATA_DIR }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
