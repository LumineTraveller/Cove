/** Owned, loopback-only fixture. Native pipe commands are forcibly rewritten to
 * no-ops. No OS input, screen recording, app launch, production connection or
 * transport-policy change. Timing excludes Electron IPC, SendInput and video. */
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { RemotePointerSender, type RemoteControlInput } from '../apps/desktop/src/features/remote-control/remoteControl';
import { RemoteControlLifecycle } from '../apps/desktop/src/features/remote-control/remoteControlSession';
import { RemoteInputQueue } from '../apps/desktop/electron/remote-input-queue';
import type { Writable } from 'node:stream';
import { RemoteControlRegistry, sanitizeRemoteControlInput } from '../apps/server/src/features/remote-control/remoteControl';

const root = path.resolve(__dirname, '..');
const baselineSource = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`,
  'show', 'checkpoint/published-main-65df169:apps/desktop/src/features/remote-control/remoteControl.ts'],
  { cwd: root, encoding: 'utf8', windowsHide: true });
const baselineModule = { exports: {} as { RemotePointerSender: typeof RemotePointerSender } };
vm.runInNewContext(ts.transpileModule(baselineSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: baselineModule.exports, setTimeout, clearTimeout, performance });
const baselineSessionSource = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`,
  'show', 'checkpoint/published-main-65df169:apps/desktop/src/features/remote-control/remoteControlSession.ts'],
  { cwd: root, encoding: 'utf8', windowsHide: true });
const baselineSessionModule = { exports: {} as { RemoteControlLifecycle: typeof RemoteControlLifecycle } };
vm.runInNewContext(ts.transpileModule(baselineSessionSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: baselineSessionModule.exports, setTimeout, clearTimeout, performance });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const connectedOnce = (socket: { once(event: 'connect', listener: () => void): unknown }) =>
  new Promise<void>(resolve => socket.once('connect', resolve));
const summarize = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { count: sorted.length, meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], maxMs: sorted.at(-1) };
};

async function run(label: string, Sender: typeof RemotePointerSender, Lifecycle: typeof RemoteControlLifecycle,
  kind: 'still' | 'slow' | 'fast' | 'drag' | 'blocked') {
  const executable = label.startsWith('baseline') ? 'runtime/remote-input-helper-baseline.exe' : 'apps/desktop/build/remote-input-helper.exe';
  const helper = spawn(path.join(root, executable), [String(process.pid)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(helper, 'close');
  const failures: string[] = [];
  const records = new Map<number, { type: string; sampled: number; sent?: number; server?: number; received?: number; pipe?: number; ack?: number }>();
  const consumed: number[] = [];
  let id = 0;
  let sampled = 0;
  let finalSample: RemoteControlInput;
  const samples = new WeakMap<object, number>();
  const sequenceIds = new Map<number, number>();
  const writer = Object.assign(new EventEmitter(), {
    get writableLength() { return helper.stdin.writableLength; },
    write(line: string) {
      const command = JSON.parse(line);
      const record = records.get(command._probeId)!;
      record.pipe = performance.now();
      sequenceIds.set(command.seq, command._probeId);
      // Critical safety boundary: never pass pointer/key/button/wheel to native.
      return helper.stdin.write(JSON.stringify({ type: 'noop', seq: command.seq }) + '\n');
    },
  });
  helper.stdin.on('drain', () => writer.emit('drain'));
  helper.stdin.on('error', error => writer.emit('error', error));
  const queue = new RemoteInputQueue(writer as unknown as Pick<Writable, 'write' | 'on' | 'off' | 'writableLength'>,
    reason => failures.push(reason));
  let nativeOutput = '';
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  helper.stdout.on('data', chunk => {
    nativeOutput += chunk.toString('utf8');
    let newline;
    while ((newline = nativeOutput.indexOf('\n')) >= 0) {
      const message = JSON.parse(nativeOutput.slice(0, newline));
      nativeOutput = nativeOutput.slice(newline + 1);
      if (message.ready) { queue.markReady(); ready(); }
      else if (message.seq) {
        const inputId = sequenceIds.get(message.seq)!;
        records.get(inputId)!.ack = performance.now();
        consumed.push(inputId);
        queue.acknowledge(message.seq);
      } else failures.push('Unexpected native response');
    }
  });
  helper.stderr.resume();

  const http = createServer();
  const relay = new Server(http);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const controller = io(url, { autoConnect: false });
  const sharer = io(url, { autoConnect: false });
  const registry = new RemoteControlRegistry();
  let sessionId: string;
  let admitted = 0;
  let rejected = 0;
  relay.on('connection', socket => socket.on('probe:input', ({ inputId, input }) => {
    const safe = sanitizeRemoteControlInput(input);
    const authorized = safe && registry.authorizeInput(sessionId, socket.id, Date.now(), safe);
    if (!authorized) { rejected++; return; }
    admitted++;
    records.get(inputId)!.server = performance.now();
    relay.to(authorized.sharerSocketId).emit('probe:receive', { inputId, input: safe });
  }));
  sharer.on('probe:receive', ({ inputId, input }) => {
    records.get(inputId)!.received = performance.now();
    queue.enqueue({ ...input, _probeId: inputId });
  });
  const connected = Promise.all([connectedOnce(controller), connectedOnce(sharer), readiness]);
  controller.connect(); sharer.connect();
  const deadline = setTimeout(() => { helper.kill(); controller.disconnect(); sharer.disconnect(); }, 5000);
  await connected;
  const request = registry.createRequest('probe', controller.id!, sharer.id!, Date.now());
  if (!request.ok) throw new Error('Fixture request failed');
  const accepted = registry.respond(request.value.requestId, sharer.id!, true, Date.now());
  if (!accepted.ok || !accepted.value.session) throw new Error('Fixture acceptance failed');
  sessionId = accepted.value.session.sessionId;
  const lifecycle = new Lifecycle({ roomId: 'probe', socket: {
    get connected() { return controller.connected; },
    io: controller.io,
    on: (event, listener) => controller.on(event, listener),
    off: (event, listener) => controller.off(event, listener),
    emit: (event, payload) => {
      if (event !== 'remote-control:input') return controller.emit(event, payload);
      const inputId = ++id;
      records.set(inputId, { type: payload.input.type, sampled: samples.get(payload.input)!, sent: performance.now() });
      return controller.emit('probe:input', { inputId, input: payload.input });
    },
  }, onSession: () => {}, onNotice: reason => failures.push(reason) });
  lifecycle.expectStart('controller');
  const startedSession = new Promise<void>(resolve => controller.once('remote-control:started', () => resolve()));
  relay.to(controller.id!).emit('remote-control:started', { sessionId, roomId: 'probe', role: 'controller' });
  await startedSession;
  const sender = new Sender(input => lifecycle.send(input));
  const engine = controller.io.engine;
  // Isolate input flow from the fixture's initial polling/WebSocket handshake.
  if (engine.transport.name !== 'websocket') await new Promise<void>(resolve => engine.once('upgrade', () => resolve()));
  await sleep(0);
  // Finite artificial upstream backpressure, not a simulated WAN claim. A
  // buffered fixture marker makes the subsequent flush produce a real drain.
  let peakBuffered = 0;
  let unblock: ReturnType<typeof setTimeout> | undefined;
  if (kind === 'blocked') {
    engine.transport.writable = false;
    controller.emit('probe:backpressure');
    unblock = setTimeout(() => {
      peakBuffered = engine.writeBuffer.length;
      engine.transport.writable = true;
      (engine as any).flush();
    }, 200);
  }
  const sample = (input: RemoteControlInput) => {
    sampled++;
    finalSample = input;
    samples.set(input, performance.now());
    sender.send(input);
  };
  const started = performance.now();
  if (kind === 'drag') sample({ type: 'button', button: 'left', down: true, x: 0, y: .5 });
  const rate = kind === 'slow' ? 30 : 144;
  const duration = kind === 'still' ? 240 : 600;
  for (let index = 0; index <= Math.floor(duration * rate / 1000); index++) {
    if (kind === 'still' && index) break;
    const due = started + index * 1000 / rate;
    while (performance.now() + .25 < due) await sleep(Math.max(1, due - performance.now()));
    sample({ type: 'pointer', x: index / 512, y: .5 });
    if (kind === 'drag' && index === 40) {
      sample({ type: 'wheel', deltaX: 0, deltaY: 120, x: index / 512, y: .5 });
      sample({ type: 'key', code: 'ShiftLeft', down: true });
    }
  }
  if (kind === 'drag') {
    sample({ type: 'button', button: 'left', down: false, x: 86 / 512, y: .5 });
    sample({ type: 'key', code: 'ShiftLeft', down: false });
  }
  if (kind === 'still') await sleep(duration);
  const drainDeadline = performance.now() + 500;
  while (performance.now() < drainDeadline) {
    const tail = records.get(id);
    if (tail && tail.sampled === samples.get(finalSample!) && tail.ack !== undefined) break;
    await sleep(5);
  }
  const elapsed = performance.now() - started;
  sender.cancel();
  const lastInput = records.get(id)!;
  const rows = [...records.values()].filter(row => row.ack !== undefined);
  const expectedEdges = [...records].filter(([, row]) => row.type !== 'pointer').map(([inputId]) => inputId);
  const actualEdges = consumed.filter(inputId => records.get(inputId)!.type !== 'pointer');
  const debug = { id, admitted, consumed: consumed.length, lastInput, transport: engine.transport.name,
    buffered: engine.writeBuffer.length, writable: engine.transport.writable };
  queue.close();
  lifecycle.dispose();
  if (unblock) clearTimeout(unblock);
  registry.clearSocket(controller.id!);
  controller.disconnect(); sharer.disconnect();
  await new Promise<void>(resolve => relay.close(() => resolve()));
  helper.stdin.end('{"type":"stop"}\n');
  await exited;
  clearTimeout(deadline);
  if (failures.length || rejected || lastInput.ack === undefined || JSON.stringify(expectedEdges) !== JSON.stringify(actualEdges))
    throw new Error(`Incomplete ${label}/${kind}: ${JSON.stringify({ failures, rejected, expectedEdges, actualEdges, debug })}`);
  return { label, kind, elapsedMs: elapsed, sampled, emitted: id, admitted, consumed: consumed.length, rejected,
    artificialUpstreamPauseMs: kind === 'blocked' ? 200 : 0, peakBufferedPacketsAtUnblock: peakBuffered,
    edgesInOrder: true, finalTailConsumed: true, transport: controller.io.engine.transport.name,
    sampleToSend: summarize(rows.map(row => row.sent! - row.sampled)),
    sendToReceive: summarize(rows.map(row => row.received! - row.sent!)),
    localQueueAge: summarize(rows.map(row => row.pipe! - row.received!)),
    noopPipeRoundTrip: summarize(rows.map(row => row.ack! - row.pipe!)),
    sampleToNoopAck: summarize(rows.map(row => row.ack! - row.sampled)) };
}

async function main() {
  const results = [];
  for (const [label, Sender, Lifecycle] of [['baseline-65df169-16ms', baselineModule.exports.RemotePointerSender, baselineSessionModule.exports.RemoteControlLifecycle],
    ['candidate-8ms', RemotePointerSender, RemoteControlLifecycle]] as const) {
    for (const kind of ['still', 'slow', 'fast', 'drag', 'blocked'] as const) {
      if (!process.argv[2] || kind === process.argv[2]) results.push(await run(label, Sender, Lifecycle, kind));
    }
  }
  const report = { capturedAt: new Date().toISOString(), node: process.version,
    scope: 'same-host generated sampling, Socket.IO loopback relay, production registry and local queue, native no-op ACK',
    excluded: ['real mouse sampling', 'Electron renderer/main IPC', 'WAN', 'SendInput/OS cursor', 'video capture/feedback'], results };
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(path.join(root, 'runtime/remote-input-pipeline-timing.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ capturedAt: report.capturedAt, results: results.map(row => ({
    label: row.label, kind: row.kind, sampled: row.sampled, emitted: row.emitted,
    admitted: row.admitted, consumed: row.consumed, rejected: row.rejected,
    peakBuffered: row.peakBufferedPacketsAtUnblock, p95SampleToSendMs: row.sampleToSend.p95Ms,
    p95LocalQueueMs: row.localQueueAge.p95Ms, p95NoopAckMs: row.noopPipeRoundTrip.p95Ms,
    finalTailConsumed: row.finalTailConsumed, edgesInOrder: row.edgesInOrder,
  })) }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
