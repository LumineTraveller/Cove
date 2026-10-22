// Real Chromium/SFU regression with synthetic capture and an owned TCP proxy.
// Uses existing dependencies/builds. Never installs, publishes or touches devices.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
const resultPath = path.join(runtime, 'ice-restart-integration-result.json');
const logPath = path.join(runtime, 'ice-restart-browser.log');
const children = [];
let stopping = false;
const log = fs.openSync(logPath, 'w');
const started = Date.now();
function killOwned(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}
function launch(command, args, env, ipc = false) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ipc ? ['ignore', log, log, 'ipc'] : ['ignore', log, log] });
  children.push(child);
  return child;
}
const env = { ...process.env, COVE_TEST_NODE: process.execPath,
  COVE_QA_RENDERER_URL: 'http://127.0.0.1:55193',
  COVE_TEST_SERVER_MODULE: path.join(root, 'apps/server/dist/index.js') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'COVE_BOOTSTRAP_TOKEN', 'COVE_BOOTSTRAP_TOKEN_FILE']) delete env[key];
const bootstrap = path.join(runtime, 'ice-vite-bootstrap.mjs');
const vite = pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href;
const dependencyRoot = path.dirname(path.dirname(require.resolve('react/package.json')));
fs.writeFileSync(bootstrap, `import {createServer} from ${JSON.stringify(vite)};
const server=await createServer({root:${JSON.stringify(path.join(root, 'apps/desktop'))},configFile:${JSON.stringify(path.join(root, 'apps/desktop/vite.config.ts'))},cacheDir:${JSON.stringify(path.join(runtime, 'ice-vite-cache'))},server:{host:'127.0.0.1',port:55193,strictPort:true,fs:{allow:${JSON.stringify([root, dependencyRoot])}}}});
await server.listen();process.send?.({type:'ready'});
process.on('message',async m=>{if(m?.type==='stop'){await server.close();process.disconnect?.();}});
`);
const watchdog = setTimeout(() => { console.error('ICE browser regression exceeded 120 seconds'); shutdown(1); }, 120_000);
function shutdown(code) {
  if (stopping) return;
  stopping = true; clearTimeout(watchdog);
  for (const child of children) killOwned(child);
  process.exitCode = code;
}
process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
async function main() {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, status: 'starting', startedAt: new Date(started).toISOString() }));
  const renderer = launch(process.execPath, [bootstrap], env, true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Vite startup timed out')), 20_000);
    const done = fn => value => { clearTimeout(timer); fn(value); };
    renderer.once('error', done(reject));
    renderer.once('exit', done(code => reject(new Error('Owned Vite exited ' + code))));
    renderer.on('message', message => { if (message?.type === 'ready') done(resolve)(); });
  });
  if (stopping) return;
  const electron = createRequire(path.join(root, 'apps/desktop/package.json'))('electron');
  const browser = launch(electron, [path.join(root, 'apps/desktop/tests/ui/media-integration.electron.cjs'), '--ice-restart'], env);
  const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('close', resolve); });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const fresh = typeof result.runId === 'string' && Date.parse(result.startedAt) >= started && result.status === 'completed';
  if (code !== 0 || !fresh || !result.passed || !result.backendStopped ||
      !result.iceEvidence?.decodedFramesResumed || !result.iceEvidence?.syntheticAudioPacketsAndSamplesResumed)
    throw new Error('ICE integration failed or completion was not confirmed; see runtime/ice-restart-browser.log');
  console.log(JSON.stringify({ passed: true, runId: result.runId, ...result.iceEvidence, endToEndLatencyMeasured: false }, null, 2));
  if (renderer.connected) renderer.send({ type: 'stop' }, () => {});
  await new Promise(resolve => { if (renderer.exitCode !== null) return resolve(); const timer = setTimeout(resolve, 5_000); renderer.once('close', () => { clearTimeout(timer); resolve(); }); });
  shutdown(0);
}
main().catch(error => { console.error(error.message); shutdown(1); });
