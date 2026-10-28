import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import * as protocol from '../electron/native-screen-capture-protocol';
import * as cpuDelivery from '../electron/native-screen-cpu-delivery';
import type { NativeScreenCaptureController } from '../electron/native-screen-capture';

// Exercise the production broker, fake only Electron/GPU and the owned child pipes.
// These tests never import Electron, spawn a process or inspect the desktop.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../electron/native-screen-capture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const options = { maxWidth: 1920, maxHeight: 1080, fps: 120 as const };
const ready = { type: 'ready', protocol: 2, width: 1920, height: 1080, sourceWidth: 2560,
  sourceHeight: 1440, poolSize: 3, cursorSupported: true };
const frame = (serial = 1, slot = 0) => ({ type: 'frame', serial, slot, width: 1920, height: 1080,
  timestamp: serial * 1000, handle: '0xabcd', refresh: false });
const flush = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };

function harness(overrides: { enabled?: boolean; platform?: string; electron?: string; missingBridge?: boolean; timing?: boolean; pixelFormat?: 'bgra' | 'nv12'; storage?: 'gpu' | 'cpu'; completion?: 'query' | 'fence'; supportsCpuFrames?: boolean; supportsCachedCpuFrames?: boolean; supportsCachedCpuFramesInto?: boolean } = {}) {
  let now = 100_000, uuid = 0, importError = false, sendError = false, sendThrows = false, sendFrameError = false;
  let duplicateError = false, closeError = false, openError = false;
  let cpuReadError = false;
  const timers = new Map<any, { due: number; callback: () => void }>();
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
      cpuReads.push({ source: Buffer.from(source), expectedBytes: target.byteLength, cachedSlot: slot, target });
    }, duplicate(source: Buffer) {
    if (duplicateError) throw Error('duplicate failed');
    const owned = { pid, source: Buffer.from(source), handle: Buffer.alloc(8), closes: 0,
      close() { owned.closes++; if (closeError) throw Error('close failed'); } };
    owned.handle.writeBigUInt64LE(0xdef0n); duplicates.push(owned); return owned;
    } }; childHandles.push(owner); return owner;
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
        if (overrides.missingBridge) throw Error('missing');
        return handles;
      }
      if (name === './native-screen-capture-protocol') return protocol;
      if (name === './native-screen-cpu-delivery') return cpuDelivery;
      throw Error(`Unexpected import ${name}`);
    },
  });
  const controller = new module.exports.NativeScreenCaptureController({ enabled: overrides.enabled ?? true, helperPath: 'owned-helper.exe', timing: overrides.timing, pixelFormat: overrides.pixelFormat, storage: overrides.storage, completion: overrides.completion });
  const choose = (patch: Partial<protocol.NativeScreenSourceSelection> = {}) => controller.noteStockSelection({ sourceId: 'screen:0:0',
    displayId: '123', primaryDisplayId: '123', displayCount: 1, sourceWidth: 2560, sourceHeight: 1440, selectedAt: now, ...patch });
  const start = (requestId = 'request_01') => { choose(); return controller.start(target as any, requestId, options); };
  return { controller, target, start, choose, children, imports, transfers, sent, duplicates, childHandles, cpuReads, timers, advance,
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

test('NV12 is explicitly negotiated with protocol 3 and fixed limited BT709, while protocol 2 remains BGRA', async () => {
  const nv12Ready = { ...ready, protocol: 3, pixelFormat: 'nv12', colorSpace: 'bt709-limited' };
  for (const requested of ['bgra', 'nv12'] as const) {
    const h = harness({ pixelFormat: requested }); const pending = h.start();
    h.children[0].emitMessage(requested === 'nv12' ? nv12Ready : ready);
    const started = await pending; assert.equal(started.ok, true);
    assert.equal(h.children[0].args.includes('--pixel-format'), requested === 'nv12');
    h.children[0].emitMessage({ ...frame(), ...(requested === 'nv12' ? { pixelFormat: 'nv12' } : {}) });
    assert.equal(h.imports[0].config.textureInfo.pixelFormat, requested);
    if (requested === 'nv12') assert.equal(JSON.stringify(h.imports[0].config.textureInfo.colorSpace),
      JSON.stringify({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' }));
    else assert.equal(h.imports[0].config.textureInfo.colorSpace, undefined);
    assert.equal(h.controller.snapshot().pixelFormat, requested);
    h.transfers[0].resolve(); await flush(); h.imports[0].config.allReferencesReleased();
    h.controller.reset(); h.children[0].close();
  }
  for (const [requested, announcement] of [
    ['bgra', nv12Ready], ['nv12', ready], ['nv12', { ...nv12Ready, colorSpace: 'bt601-limited' }],
    ['nv12', { ...nv12Ready, colorSpace: undefined }], ['nv12', { ...nv12Ready, protocol: 2 }],
    ['nv12', { ...nv12Ready, pixelFormat: 'bgra' }],
  ] as const) {
    const h = harness({ pixelFormat: requested }); const pending = h.start(); h.children[0].emitMessage(announcement);
    assert.equal((await pending).ok, false); assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); h.children[0].close();
  }
});

test('a session cannot change frame pixel format or omit the negotiated NV12 format', async () => {
  for (const requested of ['bgra', 'nv12'] as const) {
    for (const format of requested === 'nv12' ? [undefined, 'bgra', 'invalid'] : ['nv12', 'invalid']) {
      const h = harness({ pixelFormat: requested }); const pending = h.start();
      h.children[0].emitMessage(requested === 'nv12' ? { ...ready, protocol: 3, pixelFormat: 'nv12', colorSpace: 'bt709-limited' } : ready);
      await pending; h.children[0].emitMessage({ ...frame(), pixelFormat: format });
      assert.equal(h.controller.snapshot().failureCode, 'invalid_protocol'); assert.equal(h.imports.length, 0); h.children[0].close();
    }
  }
});

const cpuReady = { ...ready, protocol: 4, pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt709-limited' };
const cpuFrame = (serial = 1, slot = 0) => ({ ...frame(serial, slot), pixelFormat: 'nv12', storage: 'cpu', byteLength: 1920 * 1080 * 3 / 2 });

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
  assert.deepEqual(Array.from(h.children[0].args.slice(-4)), ['--pixel-format', 'nv12', '--frame-storage', 'cpu']);
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
