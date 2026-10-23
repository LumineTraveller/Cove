'use strict';
// Runs existing dependencies only. Every process and artifact belongs to one
// private runtime/pip-20261023/integration-* directory; no installed app is used.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'runtime', 'pip-20261023');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: 'stop' }, () => {});
  for (let count = 0; count < 30 && child.exitCode === null && child.signalCode === null; count++) await delay(100);
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Only the PID tree spawned by this launcher, never global node/Electron.
  if (process.platform === 'win32') await new Promise(resolve => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', resolve); });
  else child.kill('SIGKILL');
}
function spawnLogged(command, args, options, filename) {
  const handle = fs.openSync(filename, 'w');
  let child;
  try { child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', handle, handle, 'ipc'] }); }
  catch (error) { fs.closeSync(handle); throw error; }
  child.once('close', () => fs.closeSync(handle));
  return child;
}
function ready(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Vite startup timed out')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Owned Vite exited: ' + code)); });
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
}
async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // The real SFU reserves rtcMinPort=port+1 through rtcMaxPort=port+200.
  // Windows may select 65xxx for port=0, which would overflow that range.
  if (port > 65000) return freeUdpPort();
  return port;
}
async function run(round) {
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtime, 'integration-'));
  const resultPath = path.join(directory, 'result.json');
  const sources = ['apps/desktop/src/features/media/screen/screenPictureInPicture.ts', 'apps/desktop/src/features/media/screen/useScreenPictureInPicture.ts',
    'apps/desktop/src/features/media/screen/ShareViewV2.tsx', 'apps/desktop/src/features/media/screen/ShareStatusBarV2.tsx', 'apps/desktop/src/styles/ui-v2.css',
    'apps/desktop/tests/ui/media-integration.tsx', 'apps/desktop/tests/ui/floating-viewer-fixture.tsx', 'apps/desktop/tests/ui/floating-viewer.electron.cjs',
    'apps/desktop/tests/ui/floating-viewer-backend.cjs', 'apps/desktop/tests/ui/floating-viewer-preload.cjs'];
  fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ startedAt: new Date().toISOString(), files: Object.fromEntries(sources.map(filename => [filename, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex')])) }, null, 2) + '\n');
  const env = { ...process.env, COVE_FLOATING_RUN_DIR: directory, COVE_FLOATING_RESULT_PATH: resultPath, COVE_TEST_NODE: process.execPath, COVE_QA_MEDIA_PORT: String(await freeUdpPort()) };
  delete env.ELECTRON_RUN_AS_NODE;
  const viteEntry = pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href;
  const dependencies = path.dirname(fs.realpathSync(path.join(root, 'node_modules/vite')));
  const bootstrap = path.join(directory, 'vite-bootstrap.mjs');
  fs.writeFileSync(bootstrap, `import {createServer} from ${JSON.stringify(viteEntry)};\nconst server=await createServer({root:${JSON.stringify(path.join(root, 'apps/desktop'))},configFile:${JSON.stringify(path.join(root, 'apps/desktop/vite.config.ts'))},cacheDir:${JSON.stringify(path.join(directory, 'vite-cache'))},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:null,fs:{allow:${JSON.stringify([root, dependencies])}}}});\nawait server.listen();process.send?.({type:'ready',url:'http://127.0.0.1:'+server.httpServer.address().port});process.on('message',async message=>{if(message?.type==='stop'){await server.close();process.disconnect?.();}});\n`);
  const vite = spawnLogged(process.execPath, [bootstrap], { cwd: root, env }, path.join(directory, 'vite.log'));
  let electron;
  let interrupted = false;
  const onSignal = () => { interrupted = true; void stopOwned(electron); void stopOwned(vite); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let launchError;
  try {
    const info = await ready(vite);
    const executable = require(path.join(root, 'apps/desktop/node_modules/electron'));
    electron = spawnLogged(executable, [path.join(root, 'apps/desktop/tests/ui/floating-viewer.electron.cjs')], { cwd: root, env: { ...env, COVE_QA_RENDERER_URL: info.url } }, path.join(directory, 'electron.log'));
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { void stopOwned(electron); reject(new Error('Floating viewer test timed out')); }, 240000);
      electron.once('error', error => { clearTimeout(timeout); reject(error); });
      electron.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
    if (code !== 0) launchError = 'Electron exited: ' + code;
  } catch (error) { launchError = error.stack || String(error); }
  finally {
    await stopOwned(electron); await stopOwned(vite);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  return { round, passed: !launchError && !interrupted && result?.passed === true, directory: path.relative(root, directory), launchError, interrupted, result };
}
async function main(args) {
  let repeat = 1;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--repeat') throw new Error('Usage: node tooling/verify-floating-viewer.cjs [--repeat 1..5]');
    repeat = Number(args[1]);
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error('Repeat must be between 1 and 5');
  const results = [];
  for (let round = 1; round <= repeat; round++) { const result = await run(round); results.push(result); console.log(JSON.stringify({ round, passed: result.passed, directory: result.directory, launchError: result.launchError, error: result.result?.error })); if (!result.passed) break; }
  const report = { schemaVersion: 1, passed: results.length === repeat && results.every(result => result.passed), node: process.version, abi: process.versions.modules, finishedAt: new Date().toISOString(), results };
  fs.writeFileSync(path.join(runtime, 'integration-latest.json'), JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
