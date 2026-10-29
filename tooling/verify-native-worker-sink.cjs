'use strict';
// Owns one hidden CPU-only Electron smoke and, in dev mode, one ephemeral Vite
// server. It neither discovers nor controls any running app or server.
const path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2];
if (!['dev', 'file'].includes(mode)) throw Error('Expected dev or file mode');
const runtime = path.join(root, 'runtime', 'native-worker-sink-smoke');
fs.mkdirSync(runtime, { recursive: true });
(async () => {
  let server, child, watchdog;
  try {
    let origin;
    if (mode === 'dev') {
      const { createServer } = await import('vite');
      server = await createServer({
        configFile: path.join(root, 'apps', 'desktop', 'vite.config.ts'),
        root: path.join(root, 'apps', 'desktop'),
        cacheDir: path.join(runtime, 'vite-cache'),
        server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
      });
      await server.listen();
      origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    const env = { ...process.env, COVE_WORKER_SMOKE_MODE: mode,
      ...(origin ? { COVE_WORKER_SMOKE_ORIGIN: origin } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require(path.join(root, 'apps', 'desktop', 'node_modules', 'electron')),
      [path.join(root, 'apps', 'desktop', 'tests', 'ui', 'native-worker-sink.electron.cjs')],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(runtime, `${mode}-runner.log`));
    child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
    watchdog = setTimeout(() => { child.kill(); }, 12_000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    log.end(); process.exitCode = code === 0 ? 0 : 1;
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
