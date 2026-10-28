import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import * as protocol from '../electron/native-screen-capture-protocol';
import type * as cpuDelivery from '../electron/native-screen-cpu-delivery';
import type * as cpuPipeline from '../electron/native-screen-cpu-buffer-pipeline';
import type { NativeScreenCaptureController } from '../electron/native-screen-capture';

// Exercise the production broker, fake only Electron/GPU and the owned child pipes.
// These tests never import Electron, spawn a process or inspect the desktop.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../electron/native-screen-capture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const compiledCpuDelivery = ts.transpileModule(fs.readFileSync(new URL('../electron/native-screen-cpu-delivery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const compiledCpuPipeline = ts.transpileModule(fs.readFileSync(new URL('../electron/native-screen-cpu-buffer-pipeline.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const options = { maxWidth: 1920, maxHeight: 1080, fps: 120 as const };
const ready = { type: 'ready', protocol: 2, width: 1920, height: 1080, sourceWidth: 2560,
  sourceHeight: 1440, poolSize: 3, cursorSupported: true };
const frame = (serial = 1, slot = 0) => ({ type: 'frame', serial, slot, width: 1920, height: 1080,
  timestamp: serial * 1000, handle: '0xabcd', refresh: false });
const cpuReady = { ...ready, protocol: 4, pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt709-limited' };
const cpuFrame = (serial = 1, slot = 0) => ({ ...frame(serial, slot), pixelFormat: 'nv12', storage: 'cpu', byteLength: 1920 * 1080 * 3 / 2 });
const flush = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };

function harness(overrides: { enabled?: boolean; platform?: string; electron?: string; missingBridge?: boolean; timing?: boolean; pixelFormat?: 'bgra' | 'nv12'; storage?: 'gpu' | 'cpu'; completion?: 'query' | 'fence'; cpuDeliveryScheduling?: cpuDelivery.NativeCpuDeliveryScheduling; cpuOwnership?: cpuPipeline.NativeCpuOwnership; supportsCpuFrames?: boolean; supportsCachedCpuFrames?: boolean; supportsCachedCpuFramesInto?: boolean; missingReadInto?: boolean } = {}) {
  let now = 100_000, uuid = 0, importError = false, sendError = false, sendThrows = false, sendFrameError = false;
  let duplicateError = false, closeError = false, openError = false;
  let cpuReadError = false;
  const timers = new Map<any, { due: number; callback: () => void }>();
  const immediates = new Set<{ callback(): void }>();
  const allImmediates: { callback(): void }[] = [];
  const setImmediate = (callback: () => void) => {
    const immediate = { callback }; immediates.add(immediate); allImmediates.push(immediate); return immediate;
  };
  const runImmediate = () => {
    const immediate = immediates.values().next().value;
    assert.ok(immediate, 'a delivery immediate must be pending');
    immediates.delete(immediate); immediate.callback();
  };
  const setTimer = (callback: () => void, milliseconds: number) => {
    const id = { unref() {} }; timers.set(id, { due: now + milliseconds, callback }); return id;
  };
  const advance = (milliseconds: number) => {
    const until = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due; timers.delete(next[0]); next[1].callback();
    }
    now = until;
  };
  const children: any[] = [], imports: any[] = [], transfers: any[] = [], sent: any[] = [], duplicates: any[] = [], childHandles: any[] = [], cpuReads: any[] = [];
  const bridgeLoads: string[] = [];
  const handles = { supportsCpuFrames: overrides.supportsCpuFrames ?? true,
    supportsCachedCpuFrames: overrides.supportsCachedCpuFrames,
    supportsCachedCpuFramesInto: overrides.supportsCachedCpuFramesInto, openChild(pid: number) {
    if (openError) throw Error('open failed');
    const owner = { pid, closes: 0, close() { owner.closes++; }, readFrame(source: Buffer, expectedBytes: number) {
      if (cpuReadError) throw Error('read failed');
      cpuReads.push({ source: Buffer.from(source), expectedBytes }); return new ArrayBuffer(expectedBytes);
    }, readFrameCached(slot: number, source: Buffer, expectedBytes: number) {
      if (cpuReadError) throw Error('read failed');
      cpuReads.push({ source: Buffer.from(source), expectedBytes, cachedSlot: slot }); return new ArrayBuffer(expectedBytes);
    }, readFrameCachedInto(slot: number, source: Buffer, target: ArrayBuffer) {
      if (cpuReadError) throw Error('read failed');
      new Uint8Array(target).fill(cpuReads.length + 1);
      cpuReads.push({ source: Buffer.from(source), expectedBytes: target.byteLength, cachedSlot: slot, target });
    }, duplicate(source: Buffer) {
    if (duplicateError) throw Error('duplicate failed');
    const owned = { pid, source: Buffer.from(source), handle: Buffer.alloc(8), closes: 0,
      close() { owned.closes++; if (closeError) throw Error('close failed'); } };
    owned.handle.writeBigUInt64LE(0xdef0n); duplicates.push(owned); return owned;
    } }; if (overrides.missingReadInto) delete (owner as any).readFrameCachedInto;
    childHandles.push(owner); return owner;
  } };
  const target = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    mainFrame: { send(channel: string, data: unknown, binary?: ArrayBuffer) {
      if (sendFrameError) throw Error('target unavailable');
      sent.push({ channel, data, ...(binary ? { binary } : {}) });
    } } });
  const spawn = (file: string, args: string[], config: unknown) => {
    const writes: string[] = [];
    const stdin = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false,
      write(line: string) { writes.push(line); return true; }, end(line: string) { writes.push(line); } });
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new EventEmitter(),
      stderr: Object.assign(new EventEmitter(), { resume() {} }), exitCode: null as number | null,
      signalCode: null, pid: 9001 + children.length, killed: false, kill() { child.killed = true; }, file, args, config, writes,
      emitMessage(message: unknown) { child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n')); },
      close() { child.exitCode = 0; child.emit('close', 0); } });
    children.push(child); return child;
  };
  const sharedTexture = {
    importSharedTexture(config: any) {
      if (importError) throw Error('contains_sensitive_error_not_forwarded');
      const imported = { config, released: 0, handle: Buffer.from(config.textureInfo.handle.ntHandle),
        release() { imported.released++; } };
      imports.push(imported); return imported;
    },
    sendSharedTexture(config: any, metadata: any) {
      if (sendThrows) throw Error('sensitive_send_error');
      if (sendError) return Promise.reject(Error('sensitive_send_error'));
      let resolve!: () => void, reject!: (reason?: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      transfers.push({ config, metadata, promise, resolve, reject }); return promise;
    },
  };
  const module = { exports: {} as { NativeScreenCaptureController: typeof NativeScreenCaptureController } };
  const cpuModule = { exports: {} as typeof cpuDelivery };
  const pipelineModule = { exports: {} as typeof cpuPipeline };
  vm.runInNewContext(compiledCpuPipeline, { exports: pipelineModule.exports, Buffer, ArrayBuffer,
    setTimeout: setTimer, clearTimeout: (id: any) => timers.delete(id),
    setImmediate, clearImmediate: (id: any) => immediates.delete(id),
    require(name: string) {
      if (name === 'node:perf_hooks') return { performance: { now: () => now } };
      if (name === './native-screen-capture-protocol') return protocol;
      throw Error(`Unexpected CPU pipeline import ${name}`);
    },
  });
  vm.runInNewContext(compiledCpuDelivery, { exports: cpuModule.exports, Buffer, ArrayBuffer,
    setTimeout: setTimer, clearTimeout: (id: any) => timers.delete(id),
    setImmediate, clearImmediate: (id: any) => immediates.delete(id),
    require(name: string) {
      if (name === 'node:perf_hooks') return { performance: { now: () => now } };
      if (name === './native-screen-capture-protocol') return protocol;
      throw Error(`Unexpected CPU import ${name}`);
    },
  });
  vm.runInNewContext(compiled, { exports: module.exports, Buffer, ArrayBuffer,
    process: { platform: overrides.platform ?? 'win32', arch: 'x64', pid: 1234, versions: { electron: overrides.electron ?? '44.0.0' } },
    Date: class extends Date { static now() { return now; } }, setTimeout: setTimer, clearTimeout: (id: any) => timers.delete(id),
    require(name: string) {
      if (name === 'electron') return { sharedTexture };
      if (name === 'node:child_process') return { spawn };
      if (name === 'node:crypto') return { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` };
      if (name === 'node:perf_hooks') return { performance: { now: () => now } };
      if (name === 'node:path') return path;
      if (name.endsWith('native-screen-handles.node')) {
        bridgeLoads.push(name);
        if (overrides.missingBridge) throw Error('missing');
        return handles;
      }
      if (name === './native-screen-capture-protocol') return protocol;
      if (name === './native-screen-cpu-delivery') return cpuModule.exports;
      if (name === './native-screen-cpu-buffer-pipeline') return pipelineModule.exports;
      throw Error(`Unexpected import ${name}`);
    },
  });
  const config = { enabled: overrides.enabled ?? true, helperPath: 'owned-helper.exe', timing: overrides.timing, pixelFormat: overrides.pixelFormat, storage: overrides.storage, completion: overrides.completion, cpuDeliveryScheduling: overrides.cpuDeliveryScheduling, cpuOwnership: overrides.cpuOwnership };
  const controller = new module.exports.NativeScreenCaptureController(config);
  const choose = (patch: Partial<protocol.NativeScreenSourceSelection> = {}) => controller.noteStockSelection({ sourceId: 'screen:0:0',
    displayId: '123', primaryDisplayId: '123', displayCount: 1, sourceWidth: 2560, sourceHeight: 1440, selectedAt: now, ...patch });
  const start = (requestId = 'request_01', requested: protocol.NativeScreenOptions = {
    ...options, ...(overrides.storage === 'cpu' ? { colorSpace: 'bt709-limited' as const } : {}),
  }) => { choose(); return controller.start(target as any, requestId, requested); };
  return { controller, config, target, start, choose, children, imports, transfers, sent, duplicates, childHandles, bridgeLoads, cpuReads, timers, advance, immediates, allImmediates, runImmediate,
    failImport() { importError = true; }, failSend(sync = false) { sendError = true; sendThrows = sync; },
    failDuplicate() { duplicateError = true; }, failHandleClose() { closeError = true; },
    failOpen() { openError = true; },
    failCpuRead() { cpuReadError = true; },
    failTargetSend() { sendFrameError = true; } };
}

test('disabled, unsupported platform/version, malformed inputs and absent selection stay on stock', async () => {
  for (const config of [{ enabled: false }, { platform: 'linux' }, { electron: '43.0.0' }, { missingBridge: true }]) {
    const h = harness(config);
    assert.equal((await h.start()).ok, false); assert.equal(h.children.length, 0);
  }
  const h = harness();
  for (const value of [null, {}, { ...options, fps: 121 }, { ...options, maxWidth: 0 }, { ...options, maxHeight: NaN },
    { ...options, maxWidth: Infinity }, { ...options, maxWidth: 1920.5 }])
    assert.equal((await h.controller.start(h.target as any, 'request_01', value as any)).ok, false);
  assert.equal((await h.controller.start(h.target as any, 'bad', options)).ok, false);
  assert.equal((await h.controller.start(h.target as any, 'request_01', options)).ok, false);
  assert.equal(h.children.length, 0);
});

test('stock selection must be a fresh, one-use, single primary screen with known landscape geometry', async () => {
  for (const patch of [{ sourceId: 'window:10:0' }, { displayCount: 2 }, { displayId: 'other' },
    { selectedAt: 89_999 }, { selectedAt: 100_001 }, { sourceWidth: undefined }, { sourceHeight: 4000 }, { sourceWidth: 16385 }]) {
    const h = harness(); h.choose(patch);
    assert.equal((await h.controller.start(h.target as any, 'request_01', options)).ok, false);
    assert.equal(h.children.length, 0);
  }
  const h = harness(); h.choose(); h.advance(10_000);
  const pending = h.controller.start(h.target as any, 'request_01', options);
  h.children[0].emitMessage(ready); assert.equal((await pending).ok, true);
  assert.equal((await h.controller.start(h.target as any, 'request_02', options)).ok, false);
  h.controller.reset(); h.children[0].close();
});

test('only fixed CLI arguments reach owned helper; ready validates exact floor-even scaling', async () => {
  const h = harness(); const pending = h.start();
  assert.deepEqual(Array.from(h.children[0].args), ['--owner-pid', '1234', '--max-width', '1920', '--max-height', '1080', '--fps', '120']);
  h.children[0].emitMessage(ready);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(h.controller.snapshot().activeSessions, 1);
  assert.equal((await h.start()).ok, false);
  h.controller.reset(); h.children[0].close();
});

test('optional stage timing distinguishes import, transfer and downstream reference hold without changing credits', async () => {
  assert.equal(harness().controller.snapshot().timing, null);
  const h = harness({ timing: true }); const pending = h.start();
  h.children[0].emitMessage(ready); await pending; h.children[0].emitMessage(frame());
  h.advance(9); h.transfers[0].resolve(); await flush();
  assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
  h.advance(8); h.imports[0].config.allReferencesReleased();
  const timing = h.controller.snapshot().timing!;
  assert.equal(timing.import.count, 1); assert.equal(timing.import.totalMs, 0);
  assert.equal(timing.transfer.totalMs, 9); assert.equal(timing.transfer.buckets[4], 1);
  assert.equal(timing.reference.totalMs, 17); assert.equal(timing.reference.buckets[5], 1);
  assert.equal(h.children[0].writes.filter((line: string) => line.startsWith('released ')).length, 1);
  timing.reference.buckets.fill(999); timing.reference.totalMs = 999;
  assert.equal(h.controller.snapshot().timing!.reference.totalMs, 17);
  assert.equal(h.controller.snapshot().timing!.reference.buckets[5], 1);
  h.controller.reset(); h.children[0].close();
  assert.equal(h.controller.snapshot().pendingReferences, 0);
});

test('unqualified GPU NV12 stays on stock before helper or handle work and preserves selection and request ID', async () => {
  for (const storage of [undefined, 'gpu'] as const) {
    for (const colorSpace of [undefined, 'bt601-limited', 'bt709-limited'] as const) {
      const h = harness({ pixelFormat: 'nv12', storage }); h.choose();
      const result = await h.controller.start(h.target as any, 'request_01', { ...options, colorSpace });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'unsupported_pixel_format');
      assert.equal(h.children.length, 0); assert.equal(h.bridgeLoads.length, 0); assert.equal(h.childHandles.length, 0);
      assert.equal(h.imports.length, 0); assert.equal(h.duplicates.length, 0); assert.equal(h.sent.length, 0);
      assert.equal(h.timers.size, 0); assert.equal(h.controller.snapshot().disabled, false);
      assert.equal(h.controller.snapshot().failureCode, null);
      // Change only the harness-owned configuration. Reusing the exact request
      // without choosing again proves rejection consumed neither capability.
      h.config.pixelFormat = 'bgra';
      const pending = h.controller.start(h.target as any, 'request_01', { ...options, colorSpace });
      assert.equal(h.children.length, 1); h.children[0].emitMessage(ready);
      assert.equal((await pending).ok, true);
      h.controller.reset(); h.children[0].close(); assert.equal(h.timers.size, 0);
    }
  }
});

test('default and explicit GPU BGRA keep protocol 2 and the established helper invocation', async () => {
  for (const pixelFormat of [undefined, 'bgra'] as const) {
    for (const storage of [undefined, 'gpu'] as const) {
      const h = harness({ pixelFormat, storage }); const pending = h.start();
      h.children[0].emitMessage(ready);
      const started = await pending; assert.equal(started.ok, true);
      assert.deepEqual(Array.from(h.children[0].args), ['--owner-pid', '1234', '--max-width', '1920', '--max-height', '1080', '--fps', '120']);
      h.children[0].emitMessage(frame());
      assert.equal(h.imports[0].config.textureInfo.pixelFormat, 'bgra');
      assert.equal(h.imports[0].config.textureInfo.colorSpace, undefined);
      assert.equal(h.controller.snapshot().pixelFormat, 'bgra');
      h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased();
      h.controller.reset(); h.children[0].close();
    }
  }
});

test('BGRA sessions reject GPU or CPU NV12 ready announcements', async () => {
  const nv12Ready = { ...ready, protocol: 3, pixelFormat: 'nv12', colorSpace: 'bt709-limited' };
  for (const announcement of [nv12Ready, cpuReady, { ...nv12Ready, colorSpace: 'bt601-limited' },
    { ...nv12Ready, colorSpace: undefined }, { ...nv12Ready, protocol: 2 }]) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(announcement);
    assert.equal((await pending).ok, false); assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); h.children[0].close();
  }
});

test('GPU BGRA and CPU NV12 sessions cannot change or omit their required frame pixel format', async () => {
  for (const storage of ['gpu', 'cpu'] as const) {
    for (const format of storage === 'cpu' ? [undefined, 'bgra', 'invalid'] : ['nv12', 'invalid']) {
      const h = harness({ pixelFormat: storage === 'cpu' ? 'nv12' : 'bgra', storage }); const pending = h.start();
      h.children[0].emitMessage(storage === 'cpu' ? cpuReady : ready);
      await pending; h.children[0].emitMessage({ ...(storage === 'cpu' ? cpuFrame() : frame()), pixelFormat: format });
      assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); assert.equal(h.imports.length, 0); h.children[0].close();
    }
  }
});

test('CPU requires an explicit supported color request before opening any child handle', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu' });
  for (const colorSpace of [undefined, 'bt2020-limited', 'bt601', null]) {
    assert.equal((await h.start('request_01', { ...options, colorSpace } as any)).ok, false);
    assert.equal(h.children.length, 0); assert.equal(h.childHandles.length, 0);
  }
});

test('GPU BGRA accepts both codec color requests without changing its helper invocation', async () => {
  for (const colorSpace of ['bt601-limited', 'bt709-limited'] as const) {
    const h = harness(); const pending = h.start('request_01', { ...options, colorSpace });
    h.children[0].emitMessage(ready); assert.equal((await pending).ok, true);
    assert.equal(h.children[0].args.includes('--color-space'), false);
    h.controller.reset(); h.children[0].close();
  }
});

test('CPU ready must match its requested matrix; absent legacy color means only BT709', async () => {
  for (const requested of ['bt601-limited', 'bt709-limited'] as const) {
    for (const announced of ['bt601-limited', 'bt709-limited', undefined, 'bt2020-limited']) {
      const h = harness({ pixelFormat: 'nv12', storage: 'cpu' });
      const pending = h.start('request_01', { ...options, colorSpace: requested });
      assert.deepEqual(Array.from(h.children[0].args.slice(-2)), ['--color-space', requested]);
      h.children[0].emitMessage({ ...cpuReady, colorSpace: announced });
      const result = await pending;
      const matches = (announced ?? 'bt709-limited') === requested;
      assert.equal(result.ok, matches);
      assert.equal(h.cpuReads.length, 0); assert.equal(h.duplicates.length, 0); assert.equal(h.imports.length, 0);
      if (result.ok) assert.equal(result.colorSpace, requested);
      else assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol');
      h.controller.reset(); h.children[0].close();
    }
  }
});

test('CPU frame and final ACK cannot change the immutable session color contract', async () => {
  for (const colorSpace of ['bt601-limited', 'bt709-limited'] as const) {
    const other = colorSpace === 'bt601-limited' ? 'bt709-limited' : 'bt601-limited';
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu' });
    const pending = h.start('request_01', { ...options, colorSpace });
    h.children[0].emitMessage({ ...cpuReady, colorSpace }); await pending;
    h.children[0].emitMessage({ ...cpuFrame(), colorSpace });
    const sent = h.sent.find(entry => entry.channel === 'cove:native-screen:cpu-frame');
    assert.equal(sent.data.colorSpace, colorSpace);
    assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, { ...sent.data, colorSpace: other }), false);
    assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent.data), true);
    h.children[0].emitMessage({ ...cpuFrame(2, 1), colorSpace: other });
    assert.equal(h.cpuReads.length, 1); assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol');
    h.children[0].close();
  }
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu' });
  const pending = h.start('request_01', { ...options, colorSpace: 'bt601-limited' });
  h.children[0].emitMessage({ ...cpuReady, colorSpace: 'bt601-limited' }); await pending;
  h.children[0].emitMessage(cpuFrame());
  assert.equal(h.cpuReads.length, 0); assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol');
  h.children[0].close();
});

test('completion experiments are explicit and leave the default helper invocation unchanged', async () => {
  for (const completion of [undefined, 'query', 'fence'] as const) {
    const h = harness({ completion }); const pending = h.start();
    assert.equal(h.children[0].args.includes('--completion'), completion !== undefined);
    if (completion) assert.deepEqual(Array.from(h.children[0].args.slice(-2)), ['--completion', completion]);
    h.children[0].emitMessage(ready); await pending; h.controller.reset(); h.children[0].close();
  }
});

test('CPU mapping cache is explicitly negotiated and receives the validated slot', async () => {
  for (const supported of [undefined, false, true]) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', supportsCachedCpuFrames: supported });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    h.children[0].emitMessage(cpuFrame(1, 2));
    assert.equal(h.cpuReads.length, 1);
    assert.equal(h.cpuReads[0].cachedSlot, supported === true ? 2 : undefined);
    h.controller.reset(); h.children[0].close();
    assert.equal(h.controller.snapshot().cpuFramesInFlight, 0);
  }
});

test('CPU frame buffers are bounded to slots and only reused after matching completion', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  for (let serial = 1; serial <= 7; serial++) {
    const slot = (serial - 1) % 3;
    h.children[0].emitMessage(cpuFrame(serial, slot));
    assert.equal(h.cpuReads.length, serial);
    assert.equal(h.cpuReads.at(-1).cachedSlot, slot);
    assert.equal(h.controller.snapshot().cpuFrameBuffers, Math.min(serial, 3));
    const metadata = h.sent.filter(entry => entry.channel === 'cove:native-screen:cpu-frame').at(-1).data;
    assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, metadata), true);
    if (serial > 3) assert.equal(h.cpuReads[serial - 1].target, h.cpuReads[serial - 4].target);
  }
  assert.notEqual(h.cpuReads[0].target, h.cpuReads[1].target);
  h.controller.reset(); h.children[0].close();
  assert.equal(h.controller.snapshot().cpuFrameBuffers, 0);

  const late = harness({ pixelFormat: 'nv12', storage: 'cpu', supportsCachedCpuFramesInto: true });
  const start = late.start(); late.children[0].emitMessage(cpuReady); await start;
  late.children[0].emitMessage(cpuFrame(1, 0));
  late.children[0].emitMessage(cpuFrame(2, 0));
  assert.equal(late.cpuReads.length, 1);
  assert.equal(late.controller.snapshot().failureCode, 'cpu_frame_failed');
  assert.equal(late.controller.snapshot().cpuFrameBuffers, 0);
  late.children[0].close();
});

test('protocol 4 CPU frames never enter GPU import and credit only the matching renderer completion', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', timing: true }); const pending = h.start();
  assert.deepEqual(Array.from(h.children[0].args.slice(-6)), ['--pixel-format', 'nv12', '--frame-storage', 'cpu', '--color-space', 'bt709-limited']);
  h.children[0].emitMessage(cpuReady); const started = await pending; assert.ok(started.ok);
  if (started.ok) assert.equal(started.storage, 'cpu');
  h.children[0].emitMessage(cpuFrame());
  assert.equal(h.imports.length, 0); assert.equal(h.transfers.length, 0);
  assert.equal(h.cpuReads.length, 1); assert.equal(h.cpuReads[0].expectedBytes, 1920 * 1080 * 3 / 2);
  const sent = h.sent.find(entry => entry.channel === 'cove:native-screen:cpu-frame');
  assert.ok(sent); assert.equal(sent.binary.byteLength, h.cpuReads[0].expectedBytes);
  assert.equal(h.controller.snapshot().frameStorage, 'cpu'); assert.equal(h.controller.snapshot().cpuFramesInFlight, 1);
  assert.deepEqual(h.children[0].writes, ['imported 0 1\n']);
  assert.equal(h.controller.acknowledgeCpuFrame({} as any, sent.data), false);
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, { ...sent.data, sessionId: 'another-session' }), false);
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent.data), true);
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent.data), false);
  assert.deepEqual(h.children[0].writes, ['imported 0 1\n', 'released 0 1\n']);
  assert.equal(h.controller.snapshot().cpuFramesInFlight, 0);
  h.controller.reset(); h.children[0].close(); assert.equal(h.controller.snapshot().sessions, 0);
});

test('CPU storage requires addon capability and exact NV12 byte length; wrong storage never reads a handle', async () => {
  for (const config of [{ pixelFormat: 'nv12', storage: 'cpu', supportsCpuFrames: false }, { storage: 'cpu' }] as const) {
    const h = harness(config); assert.equal((await h.start()).ok, false); assert.equal(h.children.length, 0);
  }
  for (const patch of [{ byteLength: undefined }, { byteLength: 1 }, { byteLength: 1920 * 1080 * 3 / 2 + 1 },
    { storage: undefined }, { storage: 'gpu' }, { pixelFormat: 'bgra' }]) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu' }); const pending = h.start();
    h.children[0].emitMessage(cpuReady); await pending; h.children[0].emitMessage({ ...cpuFrame(), ...patch });
    assert.equal(h.cpuReads.length, 0); assert.equal(h.imports.length, 0);
    assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); h.children[0].close();
  }
});

test('CPU copy failure and stop retire the owned delivery without fabricated credits or late-session acknowledgement', async () => {
  for (const failRead of [false, true]) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu' }); const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    if (failRead) h.failCpuRead(); h.children[0].emitMessage(cpuFrame());
    const metadata = h.sent.find(entry => entry.channel === 'cove:native-screen:cpu-frame')?.data;
    h.controller.reset(); h.children[0].close();
    assert.equal(h.controller.snapshot().cpuFramesInFlight, 0); assert.equal(h.controller.snapshot().sessions, 0);
    if (metadata) assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, metadata), false);
    assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
    if (failRead) assert.equal(h.controller.snapshot().failureCode, 'cpu_frame_failed');
  }
});

test('CPU scheduling is opt-in and does not change GPU delivery or helper arguments', async () => {
  for (const cpuDeliveryScheduling of [undefined, 'immediate', 'yield'] as const) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuDeliveryScheduling });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    assert.equal(h.controller.snapshot().cpuDeliveryScheduling, cpuDeliveryScheduling ?? 'immediate');
    const args = Array.from(h.children[0].args);
    assert.equal(args.some(value => String(value).includes('scheduling')), false);
    h.children[0].emitMessage(cpuFrame());
    assert.equal(h.cpuReads.length, cpuDeliveryScheduling === 'yield' ? 0 : 1);
    assert.equal(h.immediates.size, cpuDeliveryScheduling === 'yield' ? 1 : 0);
    if (cpuDeliveryScheduling === 'yield') h.runImmediate();
    assert.equal(h.cpuReads.length, 1);
    assert.equal(h.cpuReads[0].source.readBigUInt64LE(), 0xabcdn);
    h.controller.reset(); h.children[0].close();
    assert.equal(h.timers.size, 0); assert.equal(h.immediates.size, 0);
  }
  const gpu = harness({ cpuDeliveryScheduling: 'yield' });
  const pending = gpu.start(); gpu.children[0].emitMessage(ready); await pending;
  assert.equal(gpu.controller.snapshot().cpuDeliveryScheduling, 'immediate');
  gpu.children[0].emitMessage(frame());
  assert.equal(gpu.imports.length, 1); assert.equal(gpu.transfers.length, 1);
  assert.equal(gpu.cpuReads.length, 0); assert.equal(gpu.immediates.size, 0);
  gpu.transfers[0].resolve(); await flush(); gpu.imports[0].config.allReferencesReleased();
  gpu.controller.reset(); gpu.children[0].close();
});

test('a three-frame CPU stdout batch yields between copies and accepts the intervening final ACK', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuDeliveryScheduling: 'yield', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  h.children[0].stdout.emit('data', Buffer.from([cpuFrame(1, 0), cpuFrame(2, 1), cpuFrame(3, 2)].map(value => JSON.stringify(value) + '\n').join('')));
  assert.equal(h.controller.snapshot().cpuFramesInFlight, 3);
  assert.equal(h.controller.snapshot().cpuFrameBuffers, 0);
  assert.equal(h.cpuReads.length, 0); assert.equal(h.immediates.size, 1);
  assert.deepEqual(h.children[0].writes, []);
  for (let slot = 0; slot < 3; slot++) {
    h.runImmediate();
    assert.equal(h.cpuReads.length, slot + 1);
    assert.equal(h.cpuReads[slot].source.readBigUInt64LE(), 0xabcdn);
    assert.equal(h.cpuReads[slot].cachedSlot, slot);
    assert.equal(h.controller.snapshot().cpuFrameBuffers, slot + 1);
    const sent = h.sent.filter(entry => entry.channel === 'cove:native-screen:cpu-frame');
    assert.equal(sent.length, slot + 1);
    assert.equal(sent[slot].data.serial, slot + 1);
    assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent[slot].data), true);
    assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent[slot].data), false);
    assert.deepEqual(h.children[0].writes.slice(-2), [`imported ${slot} ${slot + 1}\n`, `released ${slot} ${slot + 1}\n`]);
  }
  assert.equal(h.controller.snapshot().cpuFramesInFlight, 0);
  assert.equal(h.controller.snapshot().releasedFrames, 3);
  assert.equal(h.immediates.size, 0); assert.equal(h.imports.length, 0);
  h.controller.reset(); h.children[0].close();
  assert.equal(h.controller.snapshot().cpuFrameBuffers, 0); assert.equal(h.timers.size, 0);
});

for (const ending of ['reset', 'close', 'copy failure', 'timeout'] as const) {
  test(`queued CPU ${ending} cancels delivery before any late mapping read`, async () => {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuDeliveryScheduling: 'yield', supportsCachedCpuFramesInto: true });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    for (let slot = 0; slot < 3; slot++) h.children[0].emitMessage(cpuFrame(slot + 1, slot));
    if (ending === 'reset') h.controller.reset();
    if (ending === 'close') h.children[0].close();
    if (ending === 'copy failure') { h.failCpuRead(); h.runImmediate(); }
    if (ending === 'timeout') h.advance(1500);
    assert.equal(h.immediates.size, 0);
    assert.equal(h.controller.snapshot().cpuFramesInFlight, 0);
    assert.equal(h.controller.snapshot().cpuFrameBuffers, 0);
    assert.equal(h.childHandles[0].closes, 1);
    h.allImmediates.forEach(immediate => immediate.callback());
    assert.equal(h.cpuReads.length, 0);
    assert.equal(h.sent.filter(entry => entry.channel === 'cove:native-screen:cpu-frame').length, 0);
    assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
    h.children[0].close();
    assert.equal(h.controller.snapshot().sessions, 0); assert.equal(h.timers.size, 0);
  });
}

test('yield allows synchronous renderer ACK and stops queued reads when the child closes during send', async () => {
  for (const closeDuringSend of [false, true]) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuDeliveryScheduling: 'yield' });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    const originalSend = h.target.mainFrame.send;
    h.target.mainFrame.send = (channel, data, binary) => {
      originalSend(channel, data, binary);
      if (channel === 'cove:native-screen:cpu-frame') {
        if (closeDuringSend) h.children[0].close();
        else assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, data), true);
      }
    };
    h.children[0].emitMessage(cpuFrame(1, 0)); h.children[0].emitMessage(cpuFrame(2, 1));
    h.runImmediate();
    assert.equal(h.cpuReads.length, 1);
    assert.equal(h.controller.snapshot().releasedFrames, closeDuringSend ? 0 : 1);
    if (!closeDuringSend) { h.runImmediate(); assert.equal(h.cpuReads.length, 2); }
    h.controller.reset(); h.children[0].close();
    h.allImmediates.forEach(immediate => immediate.callback());
    assert.equal(h.cpuReads.length, closeDuringSend ? 1 : 2);
    assert.equal(h.childHandles[0].closes, 1);
    assert.equal(h.immediates.size, 0); assert.equal(h.timers.size, 0);
  }
});

test('copy ownership requires the bounded Into capability and leaves old CPU and GPU behavior explicit', async () => {
  for (const supportsCachedCpuFramesInto of [undefined, false]) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto });
    assert.equal((await h.start()).ok, false); assert.equal(h.children.length, 0);
  }
  const missing = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true, missingReadInto: true });
  assert.equal((await missing.start()).ok, false); assert.equal(missing.childHandles[0].closes, 1); missing.children[0].close();
  for (const cpuOwnership of [undefined, 'final-ack'] as const) {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    h.children[0].emitMessage(cpuFrame());
    assert.equal(h.controller.snapshot().cpuOwnership, 'final-ack');
    assert.equal(h.cpuReads.length, 1); assert.deepEqual(h.children[0].writes, ['imported 0 1\n']);
    h.controller.reset(); h.children[0].close();
  }
  const gpu = harness({ cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: false });
  const pending = gpu.start(); gpu.children[0].emitMessage(ready); await pending; gpu.children[0].emitMessage(frame());
  assert.equal(gpu.controller.snapshot().cpuOwnership, 'final-ack'); assert.equal(gpu.imports.length, 1);
  assert.equal(gpu.immediates.size, 0); assert.equal(gpu.cpuReads.length, 0);
  gpu.transfers[0].resolve(); await flush(); gpu.imports[0].config.allReferencesReleased();
  gpu.controller.reset(); gpu.children[0].close();
});

test('copy ownership reuses one helper slot with three independent main buffers and final ACK never re-releases source', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  assert.equal(h.controller.snapshot().cpuOwnership, 'copy-complete');
  assert.equal(h.controller.snapshot().cpuDeliveryScheduling, 'yield');
  assert.equal(h.children[0].args.some((value: string) => value.includes('ownership')), false);
  for (let serial = 1; serial <= 3; serial++) {
    h.children[0].emitMessage(cpuFrame(serial, 0)); h.runImmediate();
    assert.equal(h.cpuReads[serial - 1].cachedSlot, 0);
    assert.equal(h.cpuReads[serial - 1].source.readBigUInt64LE(), 0xabcdn);
    assert.equal(h.children[0].writes.at(-1), `imported 0 ${serial}\nreleased 0 ${serial}\n`);
    assert.equal(h.children[0].writes.length, serial);
  }
  let snapshot = h.controller.snapshot();
  assert.equal(new Set(h.cpuReads.map(value => value.target)).size, 3);
  assert.equal(snapshot.sourceCopied, 3); assert.equal(snapshot.sourceReleased, 3); assert.equal(snapshot.sourceDiscarded, 0);
  assert.equal(snapshot.mainSent, 3); assert.equal(snapshot.finalAck, 0);
  assert.equal(snapshot.activeNativeLeases, 0); assert.equal(snapshot.mainBuffersInUse, 3);
  assert.equal(snapshot.cpuFramesInFlight, 3); assert.equal(snapshot.cpuFrameBuffers, 3);
  const sent = h.sent.filter(value => value.channel === 'cove:native-screen:cpu-frame');
  const writes = h.children[0].writes.length;
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent[0].data), true);
  assert.equal(h.controller.snapshot().cpuFramesInFlight, 2);
  assert.equal(h.children[0].writes.length, writes);
  h.children[0].emitMessage(cpuFrame(4, 0)); h.runImmediate();
  assert.equal(h.cpuReads[3].target, h.cpuReads[0].target);
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, sent[0].data), false);
  assert.equal(h.controller.snapshot().mainBuffersInUse, 3);
  h.controller.reset(); h.children[0].close();
  snapshot = h.controller.snapshot();
  assert.equal(snapshot.sourceCopied, 4); assert.equal(snapshot.sourceReleased, 4); assert.equal(snapshot.mainSent, 4);
  assert.equal(snapshot.finalAck, 1); assert.equal(snapshot.cpuFrameBuffers, 0); assert.equal(snapshot.cpuFramesInFlight, 0);
  assert.equal(snapshot.activeNativeLeases, 0); assert.equal(snapshot.mainBuffersInUse, 0); assert.equal(snapshot.pendingFrames, 0);
  assert.equal(h.childHandles[0].closes, 1); assert.equal(h.timers.size, 0);
});

for (const count of [2, 3]) {
  test(`copy ownership preserves ${count} frames parsed from one stdout chunk while main capacity is available`, async () => {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    const frames = Array.from({ length: count }, (_, index) => cpuFrame(index + 1, index));
    h.children[0].stdout.emit('data', Buffer.from(frames.map(value => JSON.stringify(value) + '\n').join('')));
    assert.equal(h.cpuReads.length, 0); assert.equal(h.immediates.size, 1);
    assert.equal(h.controller.snapshot().mainBuffersInUse, count);
    assert.equal(h.controller.snapshot().activeNativeLeases, count);
    assert.equal(h.controller.snapshot().pendingSuperseded, 0);
    for (let index = 0; index < count; index++) h.runImmediate();
    const sent = h.sent.filter(value => value.channel === 'cove:native-screen:cpu-frame');
    assert.deepEqual(sent.map(value => value.data.serial), Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(new Set(h.cpuReads.map(value => value.target)).size, count);
    assert.equal(h.controller.snapshot().sourceCopied, count);
    assert.equal(h.controller.snapshot().sourceReleased, count);
    assert.equal(h.controller.snapshot().mainSent, count);
    assert.equal(h.controller.snapshot().sourceDiscarded, 0);
    for (const frame of sent) assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, frame.data), true);
    h.controller.reset(); h.children[0].close();
    assert.equal(h.controller.snapshot().mainBuffersInUse, 0); assert.equal(h.timers.size, 0);
  });
}

test('copy source credit is one write with ordered helper command lines across arbitrary pipe chunk boundaries', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  const send = h.target.mainFrame.send;
  h.target.mainFrame.send = (channel, data, binary) => {
    if (channel === 'cove:native-screen:cpu-frame')
      assert.deepEqual(h.children[0].writes, ['imported 0 1\nreleased 0 1\n']);
    send(channel, data, binary);
  };
  h.children[0].emitMessage(cpuFrame()); h.runImmediate();
  assert.equal(h.children[0].writes.length, 1);
  const batch = h.children[0].writes[0] as string;
  // Model the existing helper Input::pump newline stream contract, not write atomicity.
  const consume = (chunks: string[]) => {
    let pendingBytes = '', imported = false, busy = true;
    const commands: string[] = [];
    for (const chunk of chunks) {
      pendingBytes += chunk;
      while (pendingBytes.includes('\n')) {
        const end = pendingBytes.indexOf('\n');
        const line = pendingBytes.slice(0, end); pendingBytes = pendingBytes.slice(end + 1);
        commands.push(line);
        const [verb, slot, serial] = line.split(' ');
        assert.equal(slot, '0'); assert.equal(serial, '1'); assert.equal(busy, true);
        if (verb === 'imported') { assert.equal(imported, false); imported = true; }
        else { assert.equal(verb, 'released'); assert.equal(imported, true); busy = false; }
      }
    }
    return { busy, imported, commands, pendingBytes };
  };
  for (let split = 0; split <= batch.length; split++) {
    assert.deepEqual(consume([batch.slice(0, split), batch.slice(split)]), {
      busy: false, imported: true, commands: ['imported 0 1', 'released 0 1'], pendingBytes: '',
    });
  }
  assert.equal(consume(['imported 0 1\n']).busy, true, 'an incomplete pipe delivery has not released the section');
  h.controller.reset(); h.children[0].close(); assert.equal(h.timers.size, 0);
});

test('copy ownership discard commands do not become copied, published or renderer-completed frames', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  for (let serial = 1; serial <= 3; serial++) { h.children[0].emitMessage(cpuFrame(serial, 0)); h.runImmediate(); }
  h.children[0].emitMessage(cpuFrame(4, 0)); h.children[0].emitMessage(cpuFrame(5, 1));
  assert.equal(h.controller.snapshot().pendingFrames, 1); assert.equal(h.controller.snapshot().activeNativeLeases, 1);
  assert.equal(h.controller.snapshot().sourceDiscarded, 1); h.advance(17);
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.sourceCopied, 3); assert.equal(snapshot.sourceDiscarded, 2); assert.equal(snapshot.sourceReleased, 5);
  assert.equal(snapshot.mainSent, 3); assert.equal(snapshot.frames, 3); assert.equal(snapshot.finalAck, 0);
  assert.equal(snapshot.releasedFrames, 0); assert.equal(snapshot.transferredFrames, 0);
  assert.equal(snapshot.pendingSuperseded, 1); assert.equal(snapshot.pendingExpired, 1);
  assert.equal(snapshot.pendingFrames, 0); assert.equal(h.cpuReads.length, 3);
  assert.equal(h.immediates.size, 0); assert.equal(h.children[0].writes.length, 5);
  h.controller.reset(); h.children[0].close();
  assert.equal(h.controller.snapshot().sourceDiscarded, 2); assert.equal(h.timers.size, 0);
});

for (const disposition of ['copied', 'discarded'] as const) {
  for (const failure of ['batch write', 'later pipe error'] as const) {
    test(`copy ownership ${disposition} ${failure} retires both pools without assuming atomic pipe delivery`, async () => {
      const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
      const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
      const baseline = disposition === 'discarded' ? 3 : 0;
      for (let serial = 1; serial <= baseline; serial++) { h.children[0].emitMessage(cpuFrame(serial, 0)); h.runImmediate(); }
      const serial = baseline + 1;
      const expectedBatch = `imported 0 ${serial}\nreleased 0 ${serial}\n`;
      const write = h.children[0].stdin.write;
      const submitted: string[] = [];
      h.children[0].stdin.write = (batch: string) => {
        submitted.push(batch);
        assert.equal(batch, expectedBatch);
        if (failure === 'batch write') throw Error('pipe failed');
        return write(batch);
      };
      h.children[0].emitMessage(cpuFrame(serial, 0));
      if (disposition === 'copied') h.runImmediate(); else h.children[0].emitMessage(cpuFrame(serial + 1, 1));
      if (failure === 'later pipe error') {
        // Acceptance only queues bytes. The helper could have received just this prefix.
        assert.equal(submitted[0].slice(0, submitted[0].indexOf('\n') + 1), `imported 0 ${serial}\n`);
        h.children[0].stdin.emit('error', Error('pipe closed after a partial delivery'));
      }
      const snapshot = h.controller.snapshot();
      assert.equal(snapshot.failureCode, 'helper_failed');
      assert.equal(snapshot.sourceReleased, baseline + (failure === 'later pipe error' ? 1 : 0));
      assert.equal(snapshot.sourceCopied, baseline + (disposition === 'copied' ? 1 : 0));
      assert.equal(snapshot.sourceDiscarded, disposition === 'discarded' ? 1 : 0);
      assert.equal(snapshot.mainSent, baseline + (failure === 'later pipe error' && disposition === 'copied' ? 1 : 0));
      assert.equal(snapshot.finalAck, 0);
      assert.equal(snapshot.mainBuffersInUse, 0); assert.equal(snapshot.activeNativeLeases, 0); assert.equal(snapshot.pendingFrames, 0);
      assert.equal(submitted.length, 1);
      assert.equal(h.children[0].writes.includes(expectedBatch), failure === 'later pipe error');
      h.allImmediates.forEach(value => value.callback()); h.children[0].close();
      assert.equal(h.childHandles[0].closes, 1); assert.equal(h.timers.size, 0); assert.equal(h.immediates.size, 0);
    });
  }
}

for (const failure of ['read', 'send'] as const) {
  test(`copy ownership ${failure} failure never reports a published frame or final ACK`, async () => {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    if (failure === 'read') h.failCpuRead(); else h.failTargetSend();
    h.children[0].emitMessage(cpuFrame()); h.runImmediate();
    const snapshot = h.controller.snapshot();
    assert.equal(snapshot.failureCode, 'cpu_frame_failed'); assert.equal(snapshot.mainSent, 0); assert.equal(snapshot.finalAck, 0);
    assert.equal(snapshot.sourceCopied, failure === 'read' ? 0 : 1); assert.equal(snapshot.sourceReleased, failure === 'read' ? 0 : 1);
    assert.equal(snapshot.cpuFrameBuffers, 0); assert.equal(snapshot.cpuFramesInFlight, 0);
    h.children[0].close(); assert.equal(h.childHandles[0].closes, 1); assert.equal(h.timers.size, 0);
  });
}

for (const stage of ['pending', 'read', 'source release', 'send'] as const) {
  test(`copy ownership child close during ${stage} invalidates late read callbacks and retains cumulative counters`, async () => {
    const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
    const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
    if (stage === 'read') {
      const read = h.childHandles[0].readFrameCachedInto;
      h.childHandles[0].readFrameCachedInto = (...args: any[]) => { read(...args); h.children[0].close(); };
    }
    if (stage === 'source release') {
      const write = h.children[0].stdin.write;
      h.children[0].stdin.write = (line: string) => { const result = write(line); if (line.includes('\nreleased ')) h.children[0].close(); return result; };
    }
    if (stage === 'send') {
      const send = h.target.mainFrame.send;
      h.target.mainFrame.send = (channel, data, binary) => { send(channel, data, binary); if (channel === 'cove:native-screen:cpu-frame') h.children[0].close(); };
    }
    h.children[0].emitMessage(cpuFrame());
    if (stage === 'pending') h.children[0].close(); else h.runImmediate();
    const reads = h.cpuReads.length;
    h.allImmediates.forEach(value => value.callback());
    const snapshot = h.controller.snapshot();
    assert.equal(h.cpuReads.length, reads); assert.equal(snapshot.sessions, 0);
    assert.equal(snapshot.mainSent, stage === 'send' ? 1 : 0);
    assert.equal(snapshot.sourceReleased, stage === 'source release' || stage === 'send' ? 1 : 0);
    assert.equal(snapshot.activeNativeLeases, 0); assert.equal(snapshot.mainBuffersInUse, 0);
    assert.equal(snapshot.cpuFramesInFlight, 0); assert.equal(snapshot.cpuFrameBuffers, 0);
    assert.equal(h.childHandles[0].closes, 1); assert.equal(h.timers.size, 0); assert.equal(h.immediates.size, 0);
  });
}

test('copy ownership final ACK deadline includes pre-copy waiting and never releases source a second time', async () => {
  const h = harness({ pixelFormat: 'nv12', storage: 'cpu', cpuOwnership: 'copy-complete', supportsCachedCpuFramesInto: true });
  const pending = h.start(); h.children[0].emitMessage(cpuReady); await pending;
  h.children[0].emitMessage(cpuFrame()); h.advance(10); h.runImmediate();
  assert.equal(h.controller.snapshot().sourceReleased, 1);
  h.advance(1489); assert.equal(h.controller.snapshot().activeSessions, 1);
  h.advance(1); assert.equal(h.controller.snapshot().failureCode, 'cpu_ack_timeout');
  assert.equal(h.controller.snapshot().finalAck, 0);
  assert.equal(h.children[0].writes.join('').split('\n').filter((line: string) => line.startsWith('released ')).length, 1);
  const metadata = h.sent.find(value => value.channel === 'cove:native-screen:cpu-frame').data;
  assert.equal(h.controller.acknowledgeCpuFrame(h.target as any, metadata), false);
  h.children[0].close(); assert.equal(h.timers.size, 0);
});

test('startup timeout is bounded, disables native for this app session, and kills only its own child', async () => {
  const h = harness(); const pending = h.start(); h.advance(1500);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'start_timeout');
  assert.deepEqual(h.children[0].writes, ['stop\n']);
  assert.equal(h.children[0].killed, false);
  h.advance(1500); assert.equal(h.children[0].killed, true);
  h.children[0].close();
  assert.equal(h.controller.snapshot().helpers, 0);
  assert.equal(h.timers.size, 0);
  assert.equal((await h.start('request_02')).ok, false);
  assert.equal(h.children.length, 1);
});

test('failure to acquire the actual child handle retires startup and cleans only that child', async () => {
  const h = harness(); h.failOpen(); const pending = h.start();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'helper_unavailable');
  assert.equal(h.imports.length, 0); assert.equal(h.controller.snapshot().childHandles, 0);
  h.advance(1500); assert.equal(h.children[0].killed, true);
  h.children[0].close(); assert.equal(h.controller.snapshot().sessions, 0); assert.equal(h.timers.size, 0);
});

test('ready rejects repeated, unscaled, wrong source, unsupported format and changed pool metadata', async () => {
  for (const message of [{ ...ready, protocol: 1 }, { ...ready, poolSize: 4 }, { ...ready, cursorSupported: false },
    { ...ready, sourceWidth: 2563 }, { ...ready, width: 1918 }, { ...ready, sourceHeight: 2560 }, { ...ready, width: '1920' }]) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(message);
    assert.equal((await pending).ok, false); assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol');
    h.children[0].close();
  }
  const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
  h.children[0].emitMessage(ready); assert.equal(h.controller.snapshot().activeSessions, 0); h.children[0].close();
});

test('line and total buffers are bounded; split NDJSON and multiple valid lines work', async () => {
  for (const bad of [Buffer.alloc(8193, 65), Buffer.alloc(65537, 65), Buffer.from('{broken}\n'), Buffer.from('[]\n'),
    Buffer.from('{"type":"unknown"}\n')]) {
    const h = harness(); const pending = h.start(); h.children[0].stdout.emit('data', bad);
    assert.equal((await pending).ok, false); h.children[0].close();
  }
  const h = harness(); const pending = h.start(); const line = JSON.stringify(ready) + '\r\n';
  h.children[0].stdout.emit('data', Buffer.from(line.slice(0, 4)));
  h.children[0].stdout.emit('data', Buffer.from(line.slice(4) + JSON.stringify(frame()) + '\n'));
  assert.equal((await pending).ok, true); assert.equal(h.imports.length, 1);
  h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased();
  h.controller.reset(); h.children[0].close();
});

test('frame-before-ready, invalid handles/shape, unsafe or regressing sequence/timestamp and busy slot are rejected', async () => {
  const before = harness(); const pending = before.start(); before.children[0].emitMessage(frame());
  assert.equal((await pending).ok, false); before.children[0].close();
  for (const patch of [{ slot: 3 }, { slot: -1 }, { serial: 0 }, { serial: 9007199254740992 }, { serial: 1.2 },
    { timestamp: 0 }, { timestamp: NaN }, { width: 1922 }, { refresh: 1 }, { handle: '0x0' },
    { handle: '0xffffffffffffffff' }, { handle: '0x10000000000000000' }, { handle: '123' }, { handle: 42 }]) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
    h.children[0].emitMessage({ ...frame(), ...patch });
    assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); assert.equal(h.imports.length, 0); h.children[0].close();
  }
  for (const next of [frame(2, 0), frame(1, 1), { ...frame(2, 1), timestamp: 1000 }]) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
    h.children[0].emitMessage(frame()); h.children[0].emitMessage(next);
    assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol');
    h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased(); h.children[0].close();
  }
});

test('main import receives BGRA NT handle only from helper; temporary byte buffer is scrubbed', async () => {
  const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
  h.children[0].emitMessage(frame()); const imported = h.imports[0];
  assert.equal(imported.config.textureInfo.pixelFormat, 'bgra');
  assert.equal(imported.handle.readBigUInt64LE(), 0xdef0n);
  assert.equal(h.duplicates[0].source.readBigUInt64LE(), 0xabcdn);
  assert.equal(h.duplicates[0].pid, h.children[0].pid);
  assert.equal(h.duplicates[0].closes, 1);
  assert.equal(h.childHandles.length, 1);
  assert.equal(imported.config.textureInfo.handle.ntHandle.readBigUInt64LE(), 0n);
  assert.deepEqual(h.children[0].writes, ['imported 0 1\n']);
  assert.equal('handle' in h.transfers[0].metadata, false);
  h.transfers[0].resolve(); await flush(); imported.config.allReferencesReleased();
  h.controller.reset(); h.children[0].close();
  assert.equal(h.childHandles[0].closes, 1);
});

test('transfer completion and allReferencesReleased are both required, permits carry full metadata, credits are once-only', async () => {
  const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
  h.children[0].emitMessage(frame());
  h.imports[0].config.allReferencesReleased();
  assert.equal(h.children[0].writes.length, 1); assert.equal(h.imports[0].released, 0);
  h.transfers[0].resolve(); await flush();
  assert.equal(h.imports[0].released, 1);
  const permit = h.sent.find(value => value.channel.endsWith('release-permit'));
  assert.equal(permit.data, h.transfers[0].metadata);
  assert.deepEqual(h.children[0].writes, ['imported 0 1\n', 'released 0 1\n']);
  h.imports[0].config.allReferencesReleased(); assert.equal(h.children[0].writes.length, 2);
  h.children[0].emitMessage(frame(2)); h.transfers[1].resolve(); await flush();
  assert.equal(h.children[0].writes.length, 3);
  h.imports[0].config.allReferencesReleased(); assert.equal(h.children[0].writes.length, 3);
  h.imports[1].config.allReferencesReleased(); assert.equal(h.children[0].writes[3], 'released 0 2\n');
  h.controller.reset(); h.children[0].close(); assert.equal(h.controller.snapshot().pendingReferences, 0);
});

test('import, async/sync send, pipe and target failures retire safely with fixed codes', async () => {
  for (const mode of ['duplicate', 'close', 'import', 'send', 'sendSync', 'pipe', 'target']) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
    if (mode === 'import') h.failImport();
    if (mode === 'duplicate') h.failDuplicate();
    if (mode === 'close') h.failHandleClose();
    if (mode === 'send' || mode === 'sendSync') h.failSend(mode === 'sendSync');
    if (mode === 'target') h.failTargetSend();
    h.children[0].emitMessage(frame());
    if (mode === 'pipe') h.children[0].stdin.emit('error', Error('EPIPE sensitive detail'));
    if (mode === 'target' || mode === 'pipe') h.transfers[0].resolve();
    await flush();
    assert.equal(h.controller.snapshot().activeSessions, 0);
    assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
    if (h.imports.length) { assert.equal(h.imports[0].released, 1); h.imports[0].config.allReferencesReleased(); }
    if (h.duplicates.length) assert.equal(h.duplicates[0].closes, 1);
    h.children[0].close();
    assert.equal(JSON.stringify(h.sent).includes('sensitive'), false);
    assert.equal(h.timers.size, 0);
  }
});

test('stop is idempotent and bounded; a pending transfer releases only after settlement, then never credits a slot', async () => {
  const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
  h.children[0].emitMessage(frame());
  const stopping = h.controller.stop(h.target as any, 'request_01');
  const again = h.controller.stop(h.target as any, 'request_01');
  assert.equal(h.imports[0].released, 0);
  h.children[0].emitMessage(frame(2, 1)); assert.equal(h.imports.length, 1);
  h.advance(1500); assert.equal(await stopping, true); assert.equal(await again, true); assert.equal(h.children[0].killed, true);
  h.children[0].close(); assert.equal(h.controller.snapshot().imports, 1);
  h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased();
  assert.equal(h.imports[0].released, 1);
  assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
  assert.equal(h.sent.filter(value => value.channel.endsWith(':ended')).length, 1);
  assert.equal(h.controller.snapshot().imports, 0); assert.equal(h.controller.snapshot().pendingReferences, 0);
  assert.equal(h.controller.snapshot().disabled, false); assert.equal(h.timers.size, 0);
  assert.equal(await h.controller.stop(h.target as any, 'request_01'), false);
});

test('two-session cap includes retiring children; request IDs cannot be reused after close', async () => {
  const h = harness(); const one = h.start(); h.children[0].emitMessage(ready); await one;
  const two = h.start('request_02'); h.children[1].emitMessage(ready); await two;
  assert.equal((await h.start('request_03')).ok, false); assert.equal(h.children.length, 2);
  const stopped = h.controller.stop(h.target as any, 'request_01'); h.advance(1500); await stopped;
  assert.equal((await h.start('request_04')).ok, false);
  h.children[0].close();
  assert.equal((await h.start()).ok, false);
  const three = h.start('request_05'); h.children[2].emitMessage(ready); await three;
  h.controller.reset(); h.children[1].close(); h.children[2].close();
  assert.equal(h.controller.snapshot().sessions, 0); assert.equal(h.timers.size, 0);
});

test('closed helpers with downstream references keep their session quota; duplicate old callbacks cannot erase a newer slot lease', async () => {
  const h = harness(); const one = h.start(); h.children[0].emitMessage(ready); await one;
  h.children[0].emitMessage(frame()); h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased();
  h.children[0].emitMessage(frame(2)); h.transfers[1].resolve(); await flush();
  h.controller.reset(); h.children[0].close();
  assert.equal(h.controller.snapshot().sessions, 1); assert.equal(h.controller.snapshot().helpers, 0);
  assert.equal(h.controller.snapshot().pendingReferences, 1);
  h.imports[0].config.allReferencesReleased();
  assert.equal(h.controller.snapshot().sessions, 1); assert.equal(h.controller.snapshot().busySlots, 1);
  const two = h.start('request_02'); h.children[1].emitMessage(ready); await two;
  h.children[1].emitMessage(frame()); h.transfers[2].resolve(); await flush();
  h.controller.reset(); h.children[1].close();
  assert.equal((await h.start('request_03')).ok, false);
  h.imports[1].config.allReferencesReleased(); h.imports[2].config.allReferencesReleased();
  assert.equal(h.controller.snapshot().sessions, 0); assert.equal(h.controller.snapshot().pendingReferences, 0);
  assert.equal(h.timers.size, 0);
});

test('late release from old session cannot return credits or permits to a new frame/session', async () => {
  const h = harness(); const one = h.start(); h.children[0].emitMessage(ready); await one; h.children[0].emitMessage(frame());
  h.controller.reset(); h.children[0].close();
  const originalFrame = h.target.mainFrame;
  const replacementSent: unknown[] = [];
  h.target.mainFrame = { send(channel, data) { replacementSent.push({ channel, data }); } };
  const two = h.start('request_02'); h.children[1].emitMessage(ready); await two;
  h.children[1].emitMessage(frame());
  h.imports[0].config.allReferencesReleased(); h.transfers[0].resolve(); await flush();
  assert.equal(h.transfers[0].config.frame, originalFrame);
  assert.equal(h.children[1].writes.length, 1);
  assert.equal(replacementSent.length, 0);
  h.transfers[1].resolve(); await flush(); h.imports[1].config.allReferencesReleased();
  h.controller.reset(); h.children[1].close();
});

test('target destruction/navigation/process loss, unexpected helper exit and stream errors are contained', async () => {
  for (const kind of ['destroyed', 'navigation', 'render-process-gone', 'helper-close', 'stdout-end', 'child-error']) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
    if (kind === 'navigation') h.target.emit('did-start-navigation', {}, 'https://invalid', false, true);
    else if (kind === 'helper-close') h.children[0].close();
    else if (kind === 'stdout-end') h.children[0].stdout.emit('end');
    else if (kind === 'child-error') h.children[0].emit('error', Error('spawn failure'));
    else h.target.emit(kind);
    assert.equal(h.controller.snapshot().activeSessions, 0);
    if (kind !== 'helper-close') h.children[0].stdin.emit('error', Error('late EPIPE'));
    h.children[0].close();
    assert.equal(h.target.eventNames().length, 0); assert.equal(h.children[0].eventNames().length, 0);
    assert.equal(h.children[0].stdin.eventNames().length, 0); assert.equal(h.timers.size, 0);
  }
});

test('stalled transfer, encoder-held reference or missing refresh retires without manufacturing credit', async () => {
  for (const kind of ['transfer', 'references', 'idle']) {
    const h = harness(); const pending = h.start(); h.children[0].emitMessage(ready); await pending;
    if (kind !== 'idle') h.children[0].emitMessage(frame());
    if (kind === 'references') { h.transfers[0].resolve(); await flush(); }
    h.advance(kind === 'transfer' ? 1500 : 5000);
    assert.equal(h.controller.snapshot().activeSessions, 0);
    assert.equal(h.controller.snapshot().disabled, true);
    assert.equal(h.children[0].writes.some((line: string) => line.startsWith('released ')), false);
    if (h.imports.length) { h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased(); }
    h.children[0].close(); assert.equal(h.timers.size, 0);
  }
});

test('renderer/receiver fault disables native retries while ordinary stop permits a fresh native session', async () => {
  for (const fault of [undefined, 'renderer_failed', 'receiver_failed'] as const) {
    const h = harness(); const first = h.start(); h.children[0].emitMessage(ready); await first;
    const stopping = h.controller.stop(h.target as any, 'request_01', fault);
    h.children[0].close(); await stopping;
    assert.equal(h.controller.snapshot().disabled, fault !== undefined);
    if (fault) {
      assert.equal(h.controller.snapshot().failureCode, fault);
      assert.equal((await h.start('request_02')).ok, false);
      assert.equal(h.children.length, 1);
    } else {
      const second = h.start('request_02'); h.children[1].emitMessage(ready); assert.equal((await second).ok, true);
      h.controller.reset(); h.children[1].close();
    }
    assert.equal(h.controller.snapshot().sessions, 0);
    assert.equal(h.timers.size, 0);
  }
});
