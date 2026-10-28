'use strict';
// Real Electron 44 interoperability, using only this synthetic immutable frame.
// The node launcher is the explicit GPU execution entry point; importing this
// file and node --check are side-effect free.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'runtime/nv12-shader-probe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fail(code) { throw new Error(code); }
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function configuration(args) {
  let helper = path.join(runtime, 'helper.exe');
  let addon = path.join(root, 'runtime/native-screen-capture/native-screen-handles.node');
  let cpuFrame = false;
  let cpuFrameNativeFormat = false;
  for (let index = 0; index < args.length; ++index) {
    if (args[index] === '--helper' && args[index + 1]) helper = path.resolve(args[++index]);
    else if (args[index] === '--addon' && args[index + 1]) addon = path.resolve(args[++index]);
    else if (args[index] === '--cpu-frame' && !cpuFrame) cpuFrame = true;
    else if (args[index] === '--cpu-frame-native-format' && !cpuFrame) {
      cpuFrame = true; cpuFrameNativeFormat = true;
    }
    else fail('invalid_probe_arguments');
  }
  if (!inside(runtime, helper) || path.extname(helper).toLowerCase() !== '.exe' || !fs.statSync(helper).isFile()) fail('isolated_shader_helper_required');
  const addonRoots = [path.join(root, 'runtime/native-screen-capture'), path.join(root, 'apps/desktop/build')];
  if (!addonRoots.some(parent => inside(parent, addon)) || path.extname(addon) !== '.node' || !fs.statSync(addon).isFile()) fail('existing_handle_bridge_required');
  const preload = path.join(root, 'apps/desktop/dist-electron/preload.js');
  if (!fs.statSync(preload).isFile()) fail('compiled_product_preload_required');
  return { helper, addon, preload, cpuFrame, cpuFrameNativeFormat };
}
async function bounded(promise, milliseconds, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function launch() {
  const config = configuration(process.argv.slice(2));
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtime, 'interop-'));
  const env = { ...process.env, COVE_NV12_INTEROP_DIR: directory, COVE_NV12_INTEROP_HELPER: config.helper,
    COVE_NV12_INTEROP_ADDON: config.addon, COVE_NV12_INTEROP_CPU_FRAME: config.cpuFrame ? '1' : '0',
    COVE_NV12_INTEROP_CPU_FRAME_NATIVE_FORMAT: config.cpuFrameNativeFormat ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require(path.join(root, 'apps/desktop/node_modules/electron'));
  const child = spawn(electron, [__filename], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Chromium diagnostic output is drained, never saved. In particular, raw
  // native handle transport and arbitrary native stderr cannot enter a log.
  child.stdout.resume(); child.stderr.resume();
  let stopping, interrupted = false, timedOut = false;
  const cancel = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      for (let count = 0; count < 30 && child.exitCode === null && child.signalCode === null; ++count) await delay(100);
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Exact owned Electron tree only. The helper itself has no child process.
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', resolve);
      });
    })();
    return stopping;
  };
  const interrupt = () => { interrupted = true; void cancel(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const watchdog = setTimeout(() => { timedOut = true; void cancel(); }, 30000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(watchdog); await stopping; process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  const resultPath = path.join(directory, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  console.log(JSON.stringify({ directory: path.relative(root, directory), resultPath: path.relative(root, resultPath), exitCode: code, interrupted, timedOut, result }, null, 2));
  process.exitCode = code || interrupted || timedOut || !result?.passed ? 1 : 0;
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
  const directory = path.resolve(process.env.COVE_NV12_INTEROP_DIR || '');
  if (!inside(runtime, directory)) fail('invalid_isolated_output_directory');
  const config = configuration(['--helper', process.env.COVE_NV12_INTEROP_HELPER || '', '--addon', process.env.COVE_NV12_INTEROP_ADDON || '',
    ...(process.env.COVE_NV12_INTEROP_CPU_FRAME_NATIVE_FORMAT === '1' ? ['--cpu-frame-native-format']
      : process.env.COVE_NV12_INTEROP_CPU_FRAME === '1' ? ['--cpu-frame'] : [])]);
  const profile = path.join(directory, 'profile'); fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.on('window-all-closed', () => {});
  const result = { passed: false, probe: 'nv12-electron44-interop', startedAt: new Date().toISOString(),
    scope: 'One immutable synthetic 64x64 NV12 texture, actual sandboxed product preload, VideoFrame, generator and optional processor.',
    desktopCapture: false, microphone: false, networkUsed: false, pixelsOrHandlesPersisted: false,
    deliveryMode: config.cpuFrameNativeFormat ? 'native-format-nv12-cpu-frame'
      : config.cpuFrame ? 'explicit-nv12-cpu-frame' : 'direct-shared-nv12',
    syncMode: 'held-query', nativeStages: [], nativeValidation: null, renderer: null,
    rendererDiagnostics: 'nv12-plane-and-marker-errors-v1',
    rendererProbeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'renderer.cjs'))).digest('hex'),
    helperSha256: crypto.createHash('sha256').update(fs.readFileSync(config.helper)).digest('hex'),
    preloadSha256: crypto.createHash('sha256').update(fs.readFileSync(config.preload)).digest('hex'),
    addonSha256: crypto.createHash('sha256').update(fs.readFileSync(config.addon)).digest('hex') };
  const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  let window, helper, lines, owner, imported, transfer, stopped = false, cleanupStarted = false;
  let transferSettled = false, transferComplete = false, mainReleased = false, permitSent = false, referencesReleased = false;
  let helperClosed = false, helperCode = null, temporaryMainHandles = 0, protocolError, receiverFault;
  let readySeen = false, frameSeen = false, doneSeen = false, importedAckSent = false, releasedAckSent = false;
  let resolveReferences; const referencePromise = new Promise(resolve => { resolveReferences = resolve; });
  const pendingMessages = [], pendingWaiters = [];
  const stop = () => { stopped = true; if (helper && !helperClosed) helper.kill(); };
  process.on('message', message => { if (message?.type === 'stop') stop(); });
  process.once('disconnect', stop);
  const checkActive = () => { if (stopped) fail('probe_cancelled'); if (protocolError) fail(protocolError); if (receiverFault) fail(receiverFault); };
  const releaseMain = () => { if (imported && transferSettled && !mainReleased) { mainReleased = true; imported.release(); } };
  function nextMessage(type, timeout) {
    const operation = (async () => {
      while (true) {
        checkActive();
        const value = pendingMessages.length ? pendingMessages.shift() : await new Promise(resolve => pendingWaiters.push(resolve));
        checkActive();
        if (!value || value.type !== type) fail('unexpected_native_message_order');
        return value;
      }
    })();
    return bounded(operation, timeout, 'native_' + type + '_timeout');
  }
  function deliver(value) { if (pendingWaiters.length) pendingWaiters.shift()(value); else pendingMessages.push(value); }
  function nativeLine(line) {
    try {
      if (line.length > 8192) fail('native_protocol_line_too_large');
      const value = JSON.parse(line);
      if (value.probe !== 'nv12-pixel-shader') fail('unexpected_native_probe');
      if (value.type === 'error') {
        result.nativeError = { code: /^[a-z0-9_]{1,80}$/.test(value.code) ? value.code : 'invalid_error_code',
          hresult: Number.isInteger(value.hresult) ? value.hresult : null,
          deviceRemovedReason: Number.isInteger(value.deviceRemovedReason) ? value.deviceRemovedReason : null };
        protocolError = 'native_probe_failed'; deliver({ type: 'error' });
      } else if (value.type === 'stage') {
        const allowed = ['hlsl_compiled', 'hardware_device3_created', 'nv12_shared_plane_views_created',
          'shader_draws_and_test_copy_submitted', 'producer_gpu_complete', 'synthetic_rec709_pixels_validated'];
        if (!allowed.includes(value.stage) || result.nativeStages.includes(value.stage)) fail('invalid_native_stage');
        result.nativeStages.push(value.stage);
      } else if (value.type === 'validation') {
        if (result.nativeValidation || value.width !== 64 || value.height !== 64 || value.syncMode !== 'held-query' ||
            value.ySamples !== 4096 || value.uvSamples !== 2048 || !Number.isInteger(value.yMaxError) ||
            !Number.isInteger(value.uvMaxError) || value.yMaxError < 0 || value.yMaxError > 1 || value.uvMaxError < 0 || value.uvMaxError > 1 || value.gpuExecuted !== true) fail('invalid_native_validation');
        result.nativeValidation = { ySamples: value.ySamples, uvSamples: value.uvSamples,
          yMaxError: value.yMaxError, uvMaxError: value.uvMaxError, syncMode: value.syncMode, gpuExecuted: true };
      } else if (value.type === 'ready') {
        if (readySeen || !result.nativeValidation || value.protocol !== 2 || value.pixelFormat !== 'nv12' || value.width !== 64 || value.height !== 64 ||
            value.sourceWidth !== 64 || value.sourceHeight !== 64 || value.poolSize !== 1 ||
            value.pattern !== 'quadrants-gray-color-bars-checker-v2' || value.colorSpace?.primaries !== 'bt709' ||
            value.colorSpace.transfer !== 'bt709' || value.colorSpace.matrix !== 'bt709' || value.colorSpace.range !== 'limited') fail('invalid_native_ready');
        readySeen = true; deliver({ type: 'ready' });
      } else if (value.type === 'frame') {
        if (!readySeen || frameSeen || value.slot !== 0 || value.serial !== 1 || value.pixelFormat !== 'nv12' ||
            value.width !== 64 || value.height !== 64 || value.producerGpuComplete !== true || value.refresh !== false ||
            value.timestamp !== 1000 || typeof value.handle !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(value.handle) || BigInt(value.handle) === 0n) fail('invalid_native_frame');
        frameSeen = true;
        // The sole raw handle stays in this in-memory queue, never in result.
        deliver({ type: 'frame', handle: value.handle });
      } else if (value.type === 'done') {
        if (doneSeen || value.frames !== 1 || value.allReferencesReleased !== true || !releasedAckSent) fail('invalid_native_done');
        doneSeen = true; deliver({ type: 'done' });
      } else fail('unknown_native_message');
    } catch (error) { protocolError = /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'invalid_native_protocol'; deliver({ type: 'error' }); helper?.kill(); }
  }
  try {
    result.phase = 'waiting_for_electron'; save(); await app.whenReady();
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.electron !== '44.0.0') fail('electron44_windows_x64_required');
    if (typeof sharedTexture?.importSharedTexture !== 'function' || typeof sharedTexture?.sendSharedTexture !== 'function') fail('public_shared_texture_unavailable');
    result.versions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
    window = new BrowserWindow({ show: false, width: 160, height: 120,
      webPreferences: { preload: config.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false, additionalArguments: ['--cove-native-gpu-capture=1'] } });
    result.security = { sandbox: true, contextIsolation: true, nodeIntegration: false, actualProductPreload: true, windowShown: false };
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const network = /^(?:https?|wss?):/i.test(details.url); if (network) result.networkRequestsBlocked = (result.networkRequestsBlocked || 0) + 1;
      callback({ cancel: network });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => { receiverFault = 'renderer_process_gone'; stop(); });
    ipcMain.handle('cove:native-screen:stop', (event, _requestId, fault) => {
      if (event.sender === window?.webContents) receiverFault = fault === 'receiver_failed' ? 'preload_receiver_failed' : 'renderer_requested_stop';
      return true;
    });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; script-src \'none\'"><title>Cove synthetic NV12 interop</title>'));
    const targetFrame = window.webContents.mainFrame;
    const requestId = 'nv12probe_' + crypto.randomBytes(8).toString('hex');
    const metadata = { requestId, sessionId: crypto.randomUUID(), slot: 0, serial: 1, width: 64, height: 64, timestamp: 1000, refresh: false };
    const setup = require('./renderer.cjs');
    result.rendererSetup = await window.webContents.executeJavaScript('(' + setup.toString() + ')(' +
      JSON.stringify(requestId) + ',' + JSON.stringify({ cpuFrame: config.cpuFrame,
        cpuFrameNativeFormat: config.cpuFrameNativeFormat }) + ')');
    if (!result.rendererSetup?.supported || !result.rendererSetup.generatorAvailable ||
        result.rendererSetup.cpuFrame !== config.cpuFrame ||
        result.rendererSetup.cpuFrameNativeFormat !== config.cpuFrameNativeFormat) fail('renderer_real_api_unavailable');
    result.phase = 'native_shader'; save();
    const bridge = require(config.addon);
    if (typeof bridge.openChild !== 'function') fail('verified_child_bridge_unavailable');
    helper = spawn(config.helper, ['--owner-pid', String(process.pid), '--share', '--sync-mode', 'held-query'],
      { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    helper.stdin.on('error', () => {});
    const childExit = new Promise(resolve => helper.once('close', code => { helperClosed = true; helperCode = code; deliver({ type: 'closed' }); resolve(code); }));
    helper.once('error', () => { protocolError = 'native_spawn_failed'; deliver({ type: 'error' }); });
    helper.stderr.resume();
    await bounded(new Promise((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', () => reject(new Error('native_spawn_failed'))); }), 1000, 'native_spawn_timeout');
    owner = bridge.openChild(helper.pid);
    lines = readline.createInterface({ input: helper.stdout }); lines.on('line', nativeLine);
    await nextMessage('ready', 7000); const frame = await nextMessage('frame', 1000); checkActive();
    result.phase = 'electron_import'; save();
    let owned; const sourceHandle = Buffer.alloc(8); sourceHandle.writeBigUInt64LE(BigInt(frame.handle)); frame.handle = undefined;
    try {
      owned = owner.duplicate(sourceHandle); temporaryMainHandles++;
      if (!Buffer.isBuffer(owned.handle) || owned.handle.length !== 8 || owned.handle.readBigUInt64LE() === 0n) fail('invalid_owned_duplicate');
      imported = sharedTexture.importSharedTexture({ textureInfo: { handle: { ntHandle: owned.handle }, pixelFormat: 'nv12',
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' },
        codedSize: { width: 64, height: 64 }, timestamp: 1000 }, allReferencesReleased: () => {
        referencesReleased = true; resolveReferences();
      } });
      result.synchronousImportReturned = true;
    } finally { sourceHandle.fill(0); if (owned) { owned.close(); temporaryMainHandles--; } }
    result.mainTemporaryHandleClosed = temporaryMainHandles === 0;
    result.phase = 'renderer_transfer'; save();
    transfer = Promise.resolve().then(() => sharedTexture.sendSharedTexture({ frame: targetFrame, importedSharedTexture: imported }, metadata));
    transfer.then(() => { transferComplete = true; }, () => {}).finally(() => { transferSettled = true; if (cleanupStarted) releaseMain(); });
    await bounded(transfer, 1500, 'shared_texture_transfer_timeout'); transferSettled = true; transferComplete = true;
    helper.stdin.write('imported 0 1\n'); importedAckSent = true;
    releaseMain(); targetFrame.send('cove:native-screen:release-permit', metadata); permitSent = true;
    const rendererDeadline = Date.now() + 2500;
    while (true) {
      checkActive();
      const state = await window.webContents.executeJavaScript('({ status: window.__coveNv12Probe?.status, result: window.__coveNv12Probe?.result, errorCode: window.__coveNv12Probe?.errorCode })');
      if (state.status === 'failed') {
        result.renderer = state.result;
        fail(/^[a-z0-9_]{1,100}$/.test(state.errorCode) ? state.errorCode : 'renderer_validation_failed');
      }
      if (state.status === 'complete') { result.renderer = state.result; break; }
      if (Date.now() >= rendererDeadline) fail('renderer_validation_timeout');
      await delay(20);
    }
    result.phase = 'reference_release'; save();
    await bounded(referencePromise, 5000, 'all_references_release_timeout'); checkActive();
    if (!transferSettled || !transferComplete || !mainReleased || !permitSent || !referencesReleased || !importedAckSent) fail('release_barrier_incomplete');
    releasedAckSent = true; helper.stdin.write('released 0 1\n');
    await nextMessage('done', 1000);
    await bounded(childExit, 1500, 'native_exit_timeout');
    if (helperCode !== 0) fail('native_exit_failed');
    result.releaseBarrier = { transferSettled, transferComplete, mainReleased, permitSent, allReferencesReleased: referencesReleased, importedAckSent, releasedAckSent };
    result.passed = !!result.renderer?.passed && result.renderer.deliveryMode === result.deliveryMode && doneSeen;
    if (!result.passed) fail('renderer_result_not_passed');
    result.phase = 'complete';
  } catch (error) {
    result.errorCode = /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'interop_internal_failure';
    result.phase = 'failed'; result.passed = false;
  } finally {
    cleanupStarted = true;
    if (window && !window.isDestroyed()) {
      await bounded(window.webContents.executeJavaScript('window.__coveNv12ProbeCleanup?.()'), 1000, 'renderer_cleanup_timeout').catch(() => {});
      window.destroy();
    }
    if (transfer && !transferSettled) await bounded(transfer.catch(() => {}), 1500, 'transfer_cleanup_timeout').catch(() => {});
    try { releaseMain(); } catch { result.passed = false; result.errorCode ||= 'main_import_release_failed'; }
    if (helper && !helperClosed) {
      helper.stdin.end('stop\n');
      for (let count = 0; count < 10 && !helperClosed; ++count) await delay(50);
      if (!helperClosed) { helper.kill(); for (let count = 0; count < 20 && !helperClosed; ++count) await delay(50); }
    }
    lines?.close(); owner?.close();
    result.ownedResourcesAfterCleanup = { helperAlive: !!helper && !helperClosed, childHandleOwnerOpen: false,
      temporaryMainHandles, mainImportRetained: !!imported && !mainReleased, rendererWindowAlive: !!window && !window.isDestroyed() };
    if (result.ownedResourcesAfterCleanup.helperAlive || temporaryMainHandles || result.ownedResourcesAfterCleanup.mainImportRetained || result.ownedResourcesAfterCleanup.rendererWindowAlive) {
      result.passed = false; result.errorCode ||= 'owned_cleanup_incomplete';
    }
    result.helperExitCode = helperCode; result.finishedAt = new Date().toISOString(); save();
    app.exit(result.passed ? 0 : 2);
  }
}
if (process.versions.electron || require.main === module)
  (process.versions.electron ? runElectron() : launch()).catch(() => { console.error('nv12_interop_launcher_failed'); process.exitCode = 2; });
module.exports = { configuration, inside };
