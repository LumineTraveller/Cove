// Real Chromium/SFU regression with synthetic capture and an owned TCP/UDP proxy.
// Uses existing dependencies/builds. Never installs, publishes or touches devices.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
// Workspace package dist files can change while lockfile/config hashes stay the
// same. A fresh Vite optimizer cache is therefore required for every invocation.
function createIceRestartRunLayout(runtime, protocol, soakSeconds, fixtureRunId = randomUUID()) {
  if (!path.isAbsolute(runtime) || !['tcp','udp'].includes(protocol) || !Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 3600)
    throw new Error('Invalid ICE fixture layout');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fixtureRunId))
    throw new Error('Invalid ICE fixture run ID');
  const prefix = `ice-${protocol}${soakSeconds?'-soak':''}-${fixtureRunId}`;
  return { fixtureRunId, cacheDir: path.join(runtime, `${prefix}-vite-cache`), bootstrap: path.join(runtime, `${prefix}-vite-bootstrap.mjs`) };
}
module.exports = { createIceRestartRunLayout };
function runCli() {
const root = path.resolve(__dirname, '..');
const protocol=process.argv.includes('--udp')?'udp':'tcp';
const acceptance=process.argv.includes('--acceptance');
const extended=process.argv.includes('--extended');
if(extended&&!acceptance)throw new Error('Extended cases require the isolated acceptance backend');
const durationArg=process.argv.find(arg=>arg.startsWith('--soak-seconds='));
const soakSeconds=durationArg?Number(durationArg.split('=')[1]):0;
if(!Number.isInteger(soakSeconds)||soakSeconds<0||soakSeconds>3600)throw new Error('Invalid soak duration (0..3600 seconds)');
function portFlag(name,fallback){const arg=process.argv.find(value=>value.startsWith(`--${name}=`));const port=arg?Number(arg.split('=')[1]):fallback;if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid '+name);return port;}
const rendererPort=portFlag('renderer-port',acceptance?55197:55193),mediaPort=portFlag('media-port',acceptance?41024:41020);
const runtime = path.join(root, 'runtime',...(acceptance?['acceptance-20261023']:[]));
fs.mkdirSync(runtime, { recursive: true });
const resultPath = !acceptance&&protocol==='tcp'&&!soakSeconds?path.join(runtime,'ice-restart-integration-result.json'):path.join(runtime, `ice-restart-${protocol}${soakSeconds?'-soak':''}${extended?'-extended':''}-result.json`);
const logPath = !acceptance&&protocol==='tcp'&&!soakSeconds?path.join(runtime,'ice-restart-browser.log'):path.join(runtime, `ice-restart-${protocol}${soakSeconds?'-soak':''}${extended?'-extended':''}-browser.log`);
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
  COVE_QA_RENDERER_URL: 'http://127.0.0.1:'+rendererPort,
  COVE_QA_PROTOCOL:protocol,COVE_QA_SOAK_SECONDS:String(soakSeconds),COVE_QA_RESULT_PATH:resultPath,
  COVE_QA_EXTENDED:String(extended),
  COVE_QA_MEDIA_PORT:String(mediaPort),
  ...(acceptance?{COVE_QA_BACKEND_MODULE:path.join(root,'tooling/recovery-acceptance-backend.cjs')}:{}),
  COVE_TEST_SERVER_MODULE: path.join(root, 'apps/server/dist/index.js') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'COVE_BOOTSTRAP_TOKEN', 'COVE_BOOTSTRAP_TOKEN_FILE']) delete env[key];
const { fixtureRunId, cacheDir, bootstrap } = createIceRestartRunLayout(runtime, protocol, soakSeconds);
const vite = pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href;
const dependencyRoot = path.dirname(path.dirname(require.resolve('react/package.json')));
fs.writeFileSync(bootstrap, `import {createServer} from ${JSON.stringify(vite)};
const server=await createServer({root:${JSON.stringify(path.join(root, 'apps/desktop'))},configFile:${JSON.stringify(path.join(root, 'apps/desktop/vite.config.ts'))},cacheDir:${JSON.stringify(cacheDir)},server:{host:'127.0.0.1',port:${rendererPort},strictPort:true,hmr:false,watch:null,fs:{allow:${JSON.stringify([root, dependencyRoot])}}}});
await server.listen();process.send?.({type:'ready'});
process.on('message',async m=>{if(m?.type==='stop'){await server.close();process.disconnect?.();}});
`);
const watchdog = setTimeout(() => { console.error('ICE browser regression exceeded its bounded duration'); shutdown(1); }, (soakSeconds+240)*1000);
function shutdown(code) {
  if (stopping) return;
  stopping = true; clearTimeout(watchdog);
  for (const child of children) killOwned(child);
  process.exitCode = code;
}
process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
async function main() {
  fs.writeFileSync(resultPath, JSON.stringify({ passed: false, status: 'starting', fixtureRunId, startedAt: new Date(started).toISOString() }));
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
  result.fixtureRunId = fixtureRunId;
  result.fixtureCacheDir = path.relative(root, cacheDir);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const fresh = typeof result.runId === 'string' && Date.parse(result.startedAt) >= started && result.status === 'completed';
  if (code !== 0 || !fresh || !result.passed || !result.backendStopped ||
      !result.iceEvidence?.decodedFramesResumed || !result.iceEvidence?.syntheticAudioPacketsAndSamplesResumed ||
      !result.iceEvidence?.nonConcealedAudioSamplesResumed || !result.iceEvidence?.nonSilentAudioDecodeVerified)
    throw new Error('ICE integration failed or completion was not confirmed; see '+path.relative(root,logPath));
  if(soakSeconds&&(!result.soakEvidence||result.soakEvidence.elapsedMs<soakSeconds*1000||result.soakEvidence.cycles<1))throw new Error('Timed soak did not complete its requested duration');
  console.log(JSON.stringify({ passed: true, runId: result.runId, fixtureRunId, fixtureCacheDir: result.fixtureCacheDir, ...result.iceEvidence,
    ...(result.soakEvidence?{soak:{requestedSeconds:result.soakEvidence.requestedSeconds,elapsedMs:result.soakEvidence.elapsedMs,cycles:result.soakEvidence.cycles,operations:result.soakEvidence.operations}}:{}),
    endToEndLatencyMeasured: false }, null, 2));
  if (renderer.connected) renderer.send({ type: 'stop' }, () => {});
  await new Promise(resolve => { if (renderer.exitCode !== null) return resolve(); const timer = setTimeout(resolve, 5_000); renderer.once('close', () => { clearTimeout(timer); resolve(); }); });
  shutdown(0);
}
main().catch(error => { console.error(error.message); shutdown(1); });
}
if (require.main === module) runCli();
