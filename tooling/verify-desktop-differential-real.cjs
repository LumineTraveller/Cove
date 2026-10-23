'use strict';

// Isolated release-asset verification. Never launches an installer or opens a
// BrowserWindow. The Electron worker uses its own userData/cache/session.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const desktop = path.join(repo, 'apps', 'desktop');
const args = process.argv.slice(2);
const argument = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const phase = argument('phase', 'probe');
if (!['probe', 'remote-cloud', 'remote-github', 'fallback', 'all'].includes(phase)) throw new Error('Unsupported validation phase');
const output = path.resolve(argument('output', path.join(repo, 'runtime', 'validation-after-038ae81', 'desktop-differential', `run-${Date.now()}`)));
const allowed = path.join(repo, 'runtime', 'validation-after-038ae81', 'desktop-differential');
const outputRelative = path.relative(allowed, output);
if (!outputRelative || path.isAbsolute(outputRelative) || outputRelative.startsWith('..')) throw new Error('Output must be a dedicated directory inside the validation runtime');
function checkExistingAncestors(directory) {
  const directories = [];
  for (let current = directory; ; current = path.dirname(current)) {
    directories.push(current);
    if (current === path.dirname(current)) break;
  }
  for (const current of directories.reverse()) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)) !== '') {
      throw new Error('Validation output contains a redirected or non-directory ancestor');
    }
  }
}
checkExistingAncestors(output);
const worker = Boolean(process.versions.electron);
if (worker) {
  const marker = path.join(output, 'owner.json');
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048) throw new Error('Invalid validation owner marker');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (owner.token !== argument('owner-token', '') || owner.pid !== process.ppid) throw new Error('Worker does not belong to this validation launch');
} else {
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Validation output must be new or empty; existing evidence is never reused');
  fs.mkdirSync(output, { recursive: true });
}
checkExistingAncestors(output);
const realRelative = path.relative(fs.realpathSync(allowed), fs.realpathSync(output));
if (!realRelative || path.isAbsolute(realRelative) || realRelative.startsWith('..')) throw new Error('Validation real path escaped the dedicated runtime');
const ownerToken = worker ? argument('owner-token', '') : crypto.randomUUID();
if (!worker) fs.writeFileSync(path.join(output, 'owner.json'), JSON.stringify({ pid: process.pid, token: ownerToken }), { flag: 'wx' });
if (args.includes('--guard-only') && !worker) {
  process.stdout.write(JSON.stringify({ passed: true, output: path.relative(repo, output), ancestorsNoLinks: true }) + '\n');
  process.exit(0);
}
const reportFile = path.join(output, 'result.json');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const limits = { attemptsPerSource: 2, attemptMs: 150_000, metadataMs: 15_000, overallMs: 690_000 };
const oldFile = path.join(repo, 'runtime', 'release-2.1.1-0.8.3', 'differential-reconstruction', 'Cove-Setup-2.1.0.exe');
const newAssets = path.resolve(argument('new-assets', path.join(os.tmpdir(), 'cove-cloud-publish-2.1.1')));
const newFile = path.join(newAssets, 'Cove-Setup-2.1.1.exe');

if (!process.versions.electron) {
  if (fs.existsSync(path.join(output, 'launch.json'))) throw new Error('This output has a prior launch; inspect its result/PID before choosing another output');
  const sourceDirectory = path.join(desktop, 'electron');
  const compiledDirectory = path.join(output, 'compiled');
  const productNames = ['stable-nsis-updater', 'differential-baseline', 'update-cache-safety', 'update-diagnostics', 'update-state'];
  const sourceDigests = productNames.map(name => {
    const relative = `apps/desktop/electron/${name}.ts`;
    const frozen = execFileSync('git', ['show', `038ae81:${relative}`], { cwd: repo, windowsHide: true });
    const current = fs.readFileSync(path.join(sourceDirectory, name + '.ts'));
    const normalize = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
    if (normalize(frozen) !== normalize(current)) throw new Error(`Product source differs from frozen 038ae81: ${relative}`);
    return { file: relative, sha256: crypto.createHash('sha256').update(current).digest('hex'),
      frozenBlobSha256: crypto.createHash('sha256').update(frozen).digest('hex'),
      comparison: 'UTF-8 with CRLF normalized to LF', frozen038ae81Matched: true };
  });
  // Compile only this protected updater's dependency closure into the isolated
  // runtime, with the same target/module/strict settings as electron/tsconfig.
  // Existing delivered dist files and candidate packages remain untouched.
  const compileArgs = [require.resolve('typescript/bin/tsc'), '--target', 'ES2020', '--module', 'CommonJS', '--lib', 'ES2020',
    '--moduleResolution', 'Node', '--strict', '--esModuleInterop', '--skipLibCheck', '--rootDir', sourceDirectory,
    '--outDir', compiledDirectory, path.join(sourceDirectory, 'stable-nsis-updater.ts')];
  execFileSync(process.execPath, compileArgs, { cwd: repo, windowsHide: true, timeout: 60_000, stdio: 'pipe' });
  const compiledDigests = productNames.map(name => ({ file: `compiled/${name}.js`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(compiledDirectory, name + '.js'))).digest('hex') }));
  writeJson(path.join(output, 'provenance.json'), { frozenCommit: '038ae81', sources: sourceDigests, compiled: compiledDigests,
    outputGuard: { output: path.relative(repo, output), realOutput: path.relative(fs.realpathSync(repo), fs.realpathSync(output)), ancestorsNoLinks: true, dedicatedFreshDirectory: true },
    harness: { file: 'tooling/verify-desktop-differential-real.cjs', sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') },
    compiler: require('typescript').version, build: 'tsc protected updater dependency closure; target ES2020, CommonJS, lib ES2020, strict, esModuleInterop, skipLibCheck',
    existingDistModified: false, builtAt: new Date().toISOString() });
  const electron = require(require.resolve('electron', { paths: [desktop] }));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const child = spawn(electron, [__filename, '--electron-worker', `--owner-token=${ownerToken}`, `--phase=${phase}`, `--output=${output}`, `--new-assets=${newAssets}`], {
    cwd: repo, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeJson(path.join(output, 'launch.json'), { pid: child.pid, phase, commit, startedAt: new Date().toISOString(), limits,
    installerExecuted: false, userCacheTouched: false, proxyOrTlsPolicyChanged: false });
  const out = fs.createWriteStream(path.join(output, 'worker.log'), { flags: 'wx' });
  child.stdout.on('data', data => { out.write(data); process.stdout.write(data); });
  child.stderr.on('data', data => out.write(data));
  const watchdog = setTimeout(() => child.kill(), limits.overallMs + 15_000);
  child.once('error', error => { clearTimeout(watchdog); out.end(); process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    clearTimeout(watchdog); out.end();
    writeJson(path.join(output, 'exit.json'), { code, signal, finishedAt: new Date().toISOString() });
    process.exitCode = code === 0 ? 0 : 1;
    process.stdout.write(`Validation evidence: ${path.relative(repo, reportFile)}\n`);
  });
} else {
  void runWorker();
}

async function hashFile(file, checkCancelled) {
  checkCancelled?.();
  const before = fs.statSync(file);
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  for await (const bytes of fs.createReadStream(file)) { checkCancelled?.(); sha256.update(bytes); sha512.update(bytes); }
  checkCancelled?.();
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Input asset changed while hashing');
  return { bytes: after.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

async function runWorker() {
  const { app } = require('electron');
  for (const name of ['userData', 'sessionData']) {
    const directory = path.join(output, `electron-${name}`);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  const { CancellationToken } = require('builder-util-runtime');
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
  const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
  const { StableNsisUpdater } = require(path.join(output, 'compiled', 'stable-nsis-updater.js'));
  const { safeDownloadDiagnostic } = require(path.join(output, 'compiled', 'update-diagnostics.js'));
  const safe = value => safeDownloadDiagnostic(value instanceof Error ? value.message : value);
  const cleanUrl = value => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; } };
  const header = (response, name) => {
    const value = response.headers[name];
    return Array.isArray(value) ? value[0] : value ?? null;
  };
  const report = { status: 'running', phase, startedAt: new Date().toISOString(), limits,
    method: 'Frozen StableNsisUpdater + electron-updater 6.8.9 + actual ElectronHttpExecutor / Electron net',
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      updater: require('electron-updater/package.json').version },
    provenance: JSON.parse(fs.readFileSync(path.join(output, 'provenance.json'), 'utf8')),
    installerExecuted: false, userUpdaterCacheTouched: false, originalAssetsModified: false, networkPolicyChanged: false,
    assets: {}, probes: [], remote: [], fallback: [] };
  const save = () => writeJson(reportFile, report);
  const announce = message => { process.stdout.write(`[validation] ${message}\n`); save(); };
  let activeToken;
  const activeExecutors = new Set();
  const watchdog = setTimeout(() => {
    report.status = 'timed-out'; report.finishedAt = new Date().toISOString(); save();
    activeToken?.cancel();
    for (const executor of activeExecutors) executor.abortOwned();
    app.exit(1);
  }, limits.overallMs);

  class ObservedExecutor extends ElectronHttpExecutor {
    constructor(evidence) { super(null); this.evidence = evidence; this.active = new Set(); activeExecutors.add(this); }
    createRequest(options, callback) {
      let url = `${options.protocol || 'https:'}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path}`;
      const range = options.headers?.range ?? options.headers?.Range ?? null;
      const item = { url: cleanUrl(url), range, redirects: [], status: null, bytes: 0 };
      this.evidence.requests.push(item);
      const request = super.createRequest(options, response => {
        item.finalUrl = cleanUrl(url); item.status = response.statusCode;
        item.contentRange = header(response, 'content-range'); item.contentLength = header(response, 'content-length');
        item.contentEncoding = header(response, 'content-encoding');
        const wanted = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
        if (wanted) item.rangeHeadersMatch = response.statusCode === 206 &&
          item.contentRange === `bytes ${wanted[1]}-${wanted[2]}/${report.assets.new.bytes}` &&
          Number(item.contentLength) === Number(wanted[2]) - Number(wanted[1]) + 1 && !item.contentEncoding;
        response.on('data', bytes => { item.bytes += bytes.length; });
        response.once('end', () => { item.ended = true; save(); });
        response.once('aborted', () => { item.aborted = true; save(); });
        callback(response);
      });
      this.active.add(request);
      request.once('close', () => this.active.delete(request));
      request.once('error', error => { item.error = safe(error); save(); });
      request.on('redirect', (status, method, next) => { url = next; item.redirects.push({ status, method, url: cleanUrl(next) }); save(); });
      return request;
    }
    abortOwned() { for (const request of this.active) { try { request.abort(); } catch {} } }
    disposeObservation() { activeExecutors.delete(this); }
  }

  const sources = {
    cloud: 'https://cove.luxe/releases/v2.1.1/',
    github: 'https://github.com/LumineTraveller/Cove/releases/download/v2.1.1/',
  };

  function makeUpdater(directory, executor, source) {
    fs.mkdirSync(path.join(directory, 'user-data'), { recursive: true });
    const config = path.join(directory, 'app-update.yml');
    fs.writeFileSync(config, 'updaterCacheDirName: isolated-updater-cache\n');
    const adapter = { version: '2.1.0', name: 'cove-validation', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: path.join(directory, 'user-data'), baseCachePath: directory,
      whenReady: () => app.whenReady(), relaunch() { throw new Error('Validation cannot relaunch'); },
      quit() { throw new Error('Validation cannot quit an installed app'); },
      onQuit() { throw new Error('Automatic installer must remain disabled in validation'); } };
    const updater = new StableNsisUpdater(null, adapter);
    updater.httpExecutor = executor;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = false; updater.disableWebInstaller = true;
    updater.setFeedURL({ provider: 'generic', url: source, useMultipleRangeRequest: false });
    return updater;
  }

  async function small(executor, url) {
    const token = new CancellationToken();
    const timer = setTimeout(() => token.cancel(), limits.metadataMs);
    try { return await executor.downloadToBuffer(new URL(url), { cancellationToken: token }); }
    finally { clearTimeout(timer); token.dispose(); }
  }

  try {
    await app.whenReady();
    if (report.runtime.updater !== '6.8.9') throw new Error('Review protected hook contracts before changing electron-updater');
    const [oldDigest, newDigest] = await Promise.all([hashFile(oldFile), hashFile(newFile)]);
    const prior = JSON.parse(fs.readFileSync(path.join(repo, 'runtime', 'release-2.1.1-0.8.3', 'github-releases.json'), 'utf8'));
    const officialOld = prior.find(release => release.tag_name === 'v2.1.0').assets.find(asset => asset.name === path.basename(oldFile));
    if (`sha256:${oldDigest.sha256}` !== officialOld.digest || oldDigest.bytes !== officialOld.size) throw new Error('Old asset does not match prior official GitHub release digest');
    const latestBytes = fs.readFileSync(path.join(newAssets, 'latest.yml'));
    const latest = parseUpdateInfo(latestBytes.toString('utf8'), 'latest.yml', new URL(sources.cloud + 'latest.yml'));
    const target = latest.files.find(file => file.url === path.basename(newFile));
    if (latest.version !== '2.1.1' || target.size !== newDigest.bytes || target.sha512 !== newDigest.sha512) throw new Error('New asset does not match the published latest.yml');
    const shaLine = fs.readFileSync(path.join(newAssets, 'SHA256SUMS'), 'utf8').split(/\r?\n/).find(line => line.endsWith('  ' + path.basename(newFile)));
    if (!shaLine?.startsWith(newDigest.sha256 + '  ')) throw new Error('New asset does not match published SHA256SUMS');
    report.assets = { old: { ...oldDigest, officialGitHubSha256Matched: true }, new: { ...newDigest, publishedManifestMatched: true },
      expectedNewSha512: target.sha512, expectedVersion: latest.version };
    fs.writeFileSync(path.join(output, 'published-latest.yml'), latestBytes);
    announce('Existing official old/new installers verified; no complete package downloaded');

    if (phase === 'probe' || phase === 'all') {
      for (const [source, feed] of Object.entries(sources)) {
        const evidence = { source, status: 'running', requests: [] }; report.probes.push(evidence); save();
        const executor = new ObservedExecutor(evidence);
        try {
          const bytes = await small(executor, feed + 'latest.yml');
          const actual = parseUpdateInfo(bytes.toString('utf8'), 'latest.yml', new URL(feed + 'latest.yml'));
          const actualTarget = actual.files.find(file => file.url === target.url);
          if (actual.version !== latest.version || actualTarget?.sha512 !== target.sha512 || actualTarget?.size !== target.size) throw new Error('Live metadata differs from existing published installer');
          evidence.status = 'passed'; evidence.liveMetadataMatches = true;
          fs.writeFileSync(path.join(output, `${source}-latest.yml`), bytes);
        } catch (error) { evidence.status = 'failed'; evidence.error = safe(error); }
        finally { executor.abortOwned(); executor.disposeObservation(); save(); }
        announce(`Actual Electron net metadata probe ${source}: ${evidence.status}`);
      }
    }

    if (phase === 'all' || phase.startsWith('remote-')) {
      const selected = phase === 'all' ? Object.keys(sources) : [phase.slice('remote-'.length)];
      for (const source of selected) {
        for (let attempt = 1; attempt <= limits.attemptsPerSource; attempt++) {
          const evidence = { source, attempt, status: 'running', startedAt: new Date().toISOString(), modes: [], requests: [], logs: [], readyEvents: 0 };
          report.remote.push(evidence); save();
          const directory = path.join(output, source, `attempt-${attempt}`);
          const cache = path.join(directory, 'isolated-updater-cache');
          fs.mkdirSync(path.join(cache, 'pending'), { recursive: true });
          fs.copyFileSync(oldFile, path.join(cache, 'installer.exe'), fs.constants.COPYFILE_EXCL);
          const executor = new ObservedExecutor(evidence);
          const updater = makeUpdater(directory, executor, sources[source]);
          updater.logger = { info: value => evidence.logs.push(safe(value)), warn: value => evidence.logs.push('WARN ' + safe(value)), error: value => evidence.logs.push('ERROR ' + safe(value)) };
          updater.on('error', error => { evidence.eventError = safe(error); save(); });
          updater.on('update-downloaded', () => { evidence.readyEvents++; save(); });
          const token = new CancellationToken(); activeToken = token;
          updater.setDownloadModeListener(mode => {
            evidence.modes.push(mode); save();
            // Failed public differential trials must not redownload an existing
            // 106MB complete package. Actual full fallback is exercised below.
            if (mode.downloadMode === 'full') { evidence.remoteFullTransferPrevented = true; token.cancel(); }
          });
          let rejectDeadline;
          const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
          const checkAttempt = () => { if (evidence.attemptTimedOut || token.cancelled) throw new Error('Differential attempt was cancelled or exceeded its time budget'); };
          const timer = setTimeout(() => {
            evidence.attemptTimedOut = true; token.cancel(); executor.abortOwned();
            rejectDeadline(new Error(`Differential attempt exceeded ${limits.attemptMs} ms`));
          }, limits.attemptMs);
          announce(`Actual Electron net differential ${source}, attempt ${attempt}/${limits.attemptsPerSource}`);
          try {
            const check = await Promise.race([updater.checkForUpdates(), deadline]);
            const offered = check?.updateInfo?.files?.find(file => file.url === target.url);
            if (!check?.isUpdateAvailable || check.updateInfo.version !== '2.1.1' || offered?.sha512 !== target.sha512 || offered?.size !== target.size) throw new Error('Live update offer differs from the validated official target');
            const files = await Promise.race([updater.downloadUpdate(token), deadline]);
            const digest = await hashFile(files[0], checkAttempt);
            const ranges = evidence.requests.filter(item => item.range);
            if (digest.sha512 !== target.sha512 || digest.sha256 !== newDigest.sha256 || digest.bytes !== target.size || evidence.readyEvents !== 1) throw new Error('Reconstruction/final readiness does not match the published full installer');
            if (!ranges.length || ranges.some(item => !item.rangeHeadersMatch || !item.ended || item.bytes !== Number(item.contentLength))) throw new Error('Observed Range response boundaries were not all valid');
            if (evidence.modes.at(-1)?.differentialOutcome !== 'completed') throw new Error('Native updater did not report verified differential completion');
            evidence.reconstructed = { ...digest, file: path.relative(output, files[0]) };
            evidence.rangeBodyBytes = ranges.reduce((sum, item) => sum + item.bytes, 0);
            evidence.rangePercent = 100 * evidence.rangeBodyBytes / target.size;
            const baseline = JSON.parse(fs.readFileSync(path.join(cache, 'cove-baseline.json'), 'utf8'));
            const mapHash = crypto.createHash('sha512').update(fs.readFileSync(path.join(cache, 'current.blockmap'))).digest('base64');
            evidence.baselinePreserved = (await hashFile(path.join(cache, 'installer.exe'), checkAttempt)).sha512 === oldDigest.sha512 &&
              baseline.version === '2.1.0' && baseline.sha512 === oldDigest.sha512 && baseline.blockmapSha512 === mapHash;
            if (!evidence.baselinePreserved) throw new Error('Installed-version baseline EXE/blockmap pair was not preserved');
            checkAttempt();
            evidence.status = 'passed';
          } catch (error) { evidence.status = 'failed'; evidence.error = safe(error); }
          finally {
            clearTimeout(timer); token.cancel(); token.dispose(); executor.abortOwned(); executor.disposeObservation();
            evidence.finishedAt = new Date().toISOString(); activeToken = undefined; save();
          }
          announce(`Actual Electron net differential ${source} attempt ${attempt}: ${evidence.status}`);
          if (evidence.status === 'passed') break;
          if (attempt < limits.attemptsPerSource) await new Promise(resolve => setTimeout(resolve, 1_500));
        }
      }
    }

    if (phase === 'all' || phase === 'fallback') {
      const http = require('node:http');
      const { Transform } = require('node:stream');
      for (const scenario of ['missing', 'corrupt', 'corrupt-full-rejected']) {
        const evidence = { scenario, status: 'running', requests: [], modes: [], readyEvents: 0, logs: [] };
        report.fallback.push(evidence); save();
        const server = http.createServer((request, response) => {
          const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
          evidence.serverRequests ??= [];
          evidence.serverRequests.push({ path: request.url, range: request.headers.range ?? null });
          if (requestPath === '/latest.yml') { response.writeHead(200, { 'Content-Length': latestBytes.length }); response.end(latestBytes); return; }
          if (requestPath !== '/' + target.url) { response.writeHead(404); response.end(); return; }
          response.writeHead(200, { 'Content-Length': newDigest.bytes, 'Content-Type': 'application/octet-stream' });
          const stream = fs.createReadStream(newFile);
          if (scenario === 'corrupt-full-rejected') {
            let changed = false;
            stream.pipe(new Transform({ transform(bytes, _encoding, next) {
              if (!changed) { bytes[0] ^= 1; changed = true; }
              next(null, bytes);
            } })).pipe(response);
          } else stream.pipe(response);
          response.on('close', () => stream.destroy());
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const directory = path.join(output, 'fallback', scenario);
        const cache = path.join(directory, 'isolated-updater-cache');
        fs.mkdirSync(path.join(cache, 'pending'), { recursive: true });
        if (scenario !== 'missing') {
          fs.copyFileSync(oldFile, path.join(cache, 'installer.exe'), fs.constants.COPYFILE_EXCL);
          const fd = fs.openSync(path.join(cache, 'installer.exe'), 'r+');
          try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, 0); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 0); } finally { fs.closeSync(fd); }
          writeJson(path.join(cache, 'cove-baseline.json'), { schema: 1, version: '2.1.0', sha512: oldDigest.sha512, size: oldDigest.bytes });
        }
        const executor = new ObservedExecutor(evidence);
        const updater = makeUpdater(directory, executor, `http://127.0.0.1:${server.address().port}/`);
        updater.logger = { info: value => evidence.logs.push(safe(value)), warn: value => evidence.logs.push('WARN ' + safe(value)), error: value => evidence.logs.push('ERROR ' + safe(value)) };
        updater.setDownloadModeListener(mode => { evidence.modes.push(mode); save(); });
        updater.on('update-downloaded', () => { evidence.readyEvents++; });
        updater.on('error', error => { evidence.eventError = safe(error); });
        const token = new CancellationToken(); activeToken = token;
        let rejectDeadline;
        const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
        const checkScenario = () => { if (evidence.scenarioTimedOut || token.cancelled) throw new Error('Full fallback scenario was cancelled or exceeded 60000 ms'); };
        const timer = setTimeout(() => {
          evidence.scenarioTimedOut = true; token.cancel(); executor.abortOwned();
          rejectDeadline(new Error('Full fallback scenario exceeded 60000 ms'));
        }, 60_000);
        try {
          await Promise.race([updater.checkForUpdates(), deadline]);
          let files;
          try { files = await Promise.race([updater.downloadUpdate(token), deadline]); }
          catch (error) {
            if (scenario !== 'corrupt-full-rejected' || !/checksum mismatch/i.test(String(error))) throw error;
            evidence.badFullChecksumRejected = true;
          }
          if (evidence.requests.some(item => item.range) || evidence.serverRequests.some(item => item.path.endsWith('.blockmap'))) throw new Error('Unusable baseline attempted differential byte requests');
          const fallback = evidence.modes.find(mode => mode.downloadMode === 'full');
          const expectedCode = scenario === 'missing' ? 'ENOENT' : 'COVE_BASELINE_MISMATCH';
          if (fallback?.fallbackCode !== expectedCode) throw new Error('Baseline preflight did not identify the exact full fallback reason');
          if (scenario === 'corrupt-full-rejected') {
            if (!evidence.badFullChecksumRejected || evidence.readyEvents !== 0) throw new Error('Corrupt full transfer became ready');
          } else {
            const digest = await hashFile(files[0], checkScenario);
            if (digest.sha512 !== target.sha512 || digest.sha256 !== newDigest.sha256 || evidence.readyEvents !== 1) throw new Error('Full fallback does not match the official installer');
            evidence.completeInstaller = { ...digest, file: path.relative(output, files[0]) };
          }
          checkScenario();
          evidence.status = 'passed';
        } catch (error) { evidence.status = 'failed'; evidence.error = safe(error); }
        finally {
          clearTimeout(timer); token.cancel(); token.dispose(); executor.abortOwned(); executor.disposeObservation(); activeToken = undefined;
          server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save();
        }
        announce(`Actual Electron net, real-asset local fallback ${scenario}: ${evidence.status}`);
      }
    }

    const remoteSources = phase === 'all' ? Object.keys(sources) : phase.startsWith('remote-') ? [phase.slice('remote-'.length)] : [];
    const remotePassed = remoteSources.every(source => report.remote.some(item => item.source === source && item.status === 'passed'));
    const otherPassed = [...report.probes, ...report.fallback].every(item => item.status === 'passed');
    report.status = remotePassed && otherPassed ? 'passed' : 'failed';
  } catch (error) { report.status = 'failed'; report.error = safe(error); }
  finally {
    clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); save();
    process.stdout.write(`[validation] Final ${phase}: ${report.status}\n`);
    app.exit(report.status === 'passed' ? 0 : 1);
  }
}
