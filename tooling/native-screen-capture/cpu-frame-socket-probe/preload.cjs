'use strict';
// Sandboxed preload: Electron's restricted require only. No bridge or credentials
// are exposed to page JS. The data URL has no page scripts.
const { ipcRenderer } = require('electron');
const PREFIX = 'cove:cpu-frame-probe:';
const MAGIC = 0x43504631;
let initialized = false, stopped = false, socket = null, config = null;
let socketAuthenticated = false, expectedProof = null, bootstrapToken = null, helloTimer = null;
let stopPromise = null;
let chunkReceiver = null;
const active = new Set(), pending = new Set(), lastSerial = [0, 0, 0];
const counters = { received: 0, constructed: 0, detached: 0, closed: 0, validated: 0, acked: 0,
  rejected: 0, pixelErrors: 0, sequenceErrors: 0, maxPending: 0 };
let actualFrame = null;
let lastArrivalAt = null, initialVisibility = null;
const timingSamples = { receiveGap: [], processing: [], readback: [], postAckBuffered: [] };
function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), count = sorted.length;
  if (!count) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  const at = fraction => sorted[Math.floor((count - 1) * fraction)];
  return { count, mean: sorted.reduce((sum, value) => sum + value, 0) / count, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted[count - 1] };
}
function requireCondition(value, code) { if (!value) throw new Error(code); }
function errorCode(error) { return /^[a-z0-9_]{1,80}$/.test(error?.message) ? error.message : 'renderer_operation_failed'; }
function send(type, value) { if (!stopped) ipcRenderer.send(PREFIX + type, value); }
function zero(bytes) { if (bytes?.byteLength) new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength).fill(0); }
function detach(buffer) { if (buffer?.byteLength) { try { structuredClone(buffer, { transfer: [buffer] }); } catch { zero(buffer); } } }
// Self-contained for the restricted sandbox: no relative require, shared memory
// or page bridge. The Node protocol tests evaluate this exact class in a VM.
class ChunkReceiver {
  constructor(width, height, chunkBytes, deadlineMs, onTimeout) {
    this.width = width; this.height = height; this.frameBytes = width * height * 3 / 2;
    requireCondition((width === 1728 || width === 1920) && height === 1080 &&
      (chunkBytes === 49152 || chunkBytes === this.frameBytes) && deadlineMs === 1500, 'invalid_chunk_bootstrap');
    this.chunkBytes = chunkBytes; this.deadlineMs = deadlineMs; this.onTimeout = onTimeout;
    this.partCount = Math.ceil(this.frameBytes / chunkBytes);
    this.slots = [null, null, null]; this.lastStartedSerial = [0, 0, 0]; this.stopped = false;
    this.parts = 0; this.payloadBytes = 0; this.frames = 0; this.maxSlots = 0; this.maxRetainedBytes = 0; this.reassemblyMs = [];
  }
  state() {
    return { parts: this.parts, payloadBytes: this.payloadBytes, frames: this.frames, maxSlots: this.maxSlots,
      maxRetainedBytes: this.maxRetainedBytes, partials: this.slots.filter(slot => slot?.buffer).length,
      processingSlots: this.slots.filter(slot => slot?.processing).length,
      timers: this.slots.filter(slot => slot?.timer !== null && slot?.timer !== undefined).length,
      retainedBytes: this.slots.reduce((total, slot) => total + (slot?.buffer?.byteLength || 0), 0),
      reassemblyMs: summarize(this.reassemblyMs) };
  }
  push(meta, input) {
    requireCondition(!this.stopped && meta && Number.isInteger(meta.slot) && meta.slot >= 0 && meta.slot < 3 &&
      Number.isSafeInteger(meta.serial) && meta.serial > 0 && meta.serial <= 0xffffffff &&
      meta.width === this.width && meta.height === this.height && Number.isInteger(meta.timestamp) && meta.timestamp > 0 && meta.timestamp <= 0xffffffff &&
      meta.chunkBytes === this.chunkBytes && meta.frameBytes === this.frameBytes && meta.partCount === this.partCount &&
      Number.isInteger(meta.part) && meta.part >= 0 && meta.part < this.partCount && meta.offset === meta.part * this.chunkBytes &&
      meta.partBytes === Math.min(this.chunkBytes, this.frameBytes - meta.offset) &&
      input instanceof ArrayBuffer && input.byteLength === meta.partBytes, 'invalid_ipc_chunk_metadata');
    let slot = this.slots[meta.slot];
    if (!slot) {
      requireCondition(meta.part === 0 && meta.serial > this.lastStartedSerial[meta.slot], 'ipc_chunk_replay_or_order');
      const startedAt = performance.now();
      slot = { metadata: { slot: meta.slot, serial: meta.serial, width: meta.width, height: meta.height, timestamp: meta.timestamp },
        nextPart: 0, buffer: new ArrayBuffer(this.frameBytes), startedAt, deadlineAt: startedAt + this.deadlineMs,
        processing: false, timer: null };
      this.slots[meta.slot] = slot; this.lastStartedSerial[meta.slot] = meta.serial;
      // This fixed deadline is never extended by incoming parts.
      slot.timer = setTimeout(() => { if (!this.stopped && this.slots[meta.slot] === slot && !slot.processing) this.onTimeout('ipc_chunk_deadline'); }, this.deadlineMs);
      this.maxSlots = Math.max(this.maxSlots, this.slots.filter(Boolean).length);
      this.maxRetainedBytes = Math.max(this.maxRetainedBytes,
        this.slots.reduce((total, value) => total + (value?.buffer?.byteLength || 0), 0));
    }
    requireCondition(!slot.processing && slot.metadata.serial === meta.serial && slot.metadata.timestamp === meta.timestamp &&
      slot.nextPart === meta.part, 'ipc_chunk_replay_or_order');
    requireCondition(performance.now() < slot.deadlineAt, 'ipc_chunk_deadline');
    new Uint8Array(slot.buffer, meta.offset, meta.partBytes).set(new Uint8Array(input));
    this.parts++; this.payloadBytes += meta.partBytes; slot.nextPart++;
    if (slot.nextPart !== this.partCount) return null;
    clearTimeout(slot.timer); slot.timer = null; slot.processing = true;
    this.frames++; this.reassemblyMs.push(performance.now() - slot.startedAt);
    const buffer = slot.buffer; slot.buffer = null;
    return { metadata: slot.metadata, buffer };
  }
  release(index, serial) {
    const slot = this.slots[index];
    if (slot?.processing && slot.metadata.serial === serial) this.slots[index] = null;
  }
  stop() {
    this.stopped = true;
    for (const slot of this.slots) if (slot) { clearTimeout(slot.timer); slot.timer = null; detach(slot.buffer); slot.buffer = null; }
    this.slots.fill(null); this.onTimeout = null;
  }
}
function closeFrame(operation) {
  if (!operation.frame) return;
  try { operation.frame.close(); counters.closed++; } catch {}
  active.delete(operation); operation.frame = null;
}
async function stop() {
  if (stopPromise) return stopPromise;
  stopped = true; clearTimeout(helloTimer); helloTimer = null;
  chunkReceiver?.stop();
  zero(expectedProof); expectedProof = null; zero(bootstrapToken); bootstrapToken = null;
  ipcRenderer.removeListener(PREFIX + 'frame', onIpcFrame);
  ipcRenderer.removeListener(PREFIX + 'chunk', onIpcChunk);
  if (socket) {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(1000); } catch {}
    socket = null;
  }
  for (const operation of active) closeFrame(operation);
  stopPromise = (async () => {
    let timer;
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
    clearTimeout(timer);
    const report = { ...counters, actualFrame, pendingAfterCleanup: pending.size, framesAfterCleanup: active.size,
      ipcChunks: chunkReceiver?.state() || null,
      scheduling: { initialVisibility, finalVisibility: document.visibilityState, focusedAtStop: document.hasFocus(),
        localReceiveGapMs: summarize(timingSamples.receiveGap), localProcessingMs: summarize(timingSamples.processing),
        localReadbackMs: summarize(timingSamples.readback), postAckBufferedBytes: summarize(timingSamples.postAckBuffered) },
      socketReferenceRetained: !!socket, helloTimerActive: !!helloTimer, resourcesDisposed: pending.size === 0 && active.size === 0 };
    ipcRenderer.send(PREFIX + 'stopped', report);
  })();
  return stopPromise;
}
function fault(code) { send('fault', { code }); void stop(); }
function decodeSecret(value) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value), 'invalid_bootstrap_secret');
  const decoded = atob(value); requireCondition(decoded.length === 32, 'invalid_bootstrap_secret');
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
function inspect(metadata, buffer, offset) {
  const { width, height } = config, bytes = width * height * 3 / 2;
  requireCondition(metadata && Number.isInteger(metadata.slot) && metadata.slot >= 0 && metadata.slot < 3 &&
    Number.isSafeInteger(metadata.serial) && metadata.serial > lastSerial[metadata.slot] && metadata.serial <= 0xffffffff &&
    metadata.width === width && metadata.height === height && Number.isInteger(metadata.timestamp) && metadata.timestamp > 0 &&
    buffer instanceof ArrayBuffer && buffer.byteLength === bytes + offset && pending.size < 3, 'invalid_frame_metadata');
  lastSerial[metadata.slot] = metadata.serial;
  const view = new DataView(buffer), ySize = width * height;
  if (view.getUint32(offset, true) !== metadata.serial || view.getUint32(offset + ySize - 4, true) !== metadata.serial) {
    counters.sequenceErrors++; throw new Error('frame_sequence_mismatch');
  }
  const source = new Uint8Array(buffer);
  // Independent hardcoded expected quadrants, including each NV12 plane and
  // both halves of the frame. No expected values travel alongside the pixels.
  const expected = [[36, 80, 176], [84, 104, 156], [142, 128, 136], [190, 152, 116]];
  let errors = 0;
  for (let quadrant = 0; quadrant < 4; ++quadrant) {
    const x = quadrant % 2 ? width * 3 / 4 : width / 4;
    const y = quadrant >= 2 ? height * 3 / 4 : height / 4;
    const uv = offset + ySize + Math.floor(y / 2) * width + x;
    for (let dy = 0; dy < 2; ++dy) for (let dx = 0; dx < 2; ++dx)
      errors += source[offset + (y + dy) * width + x + dx] !== expected[quadrant][0] ? 1 : 0;
    errors += source[uv] !== expected[quadrant][1] ? 1 : 0;
    errors += source[uv + 1] !== expected[quadrant][2] ? 1 : 0;
  }
  counters.pixelErrors += errors; requireCondition(errors === 0, 'frame_pixel_mismatch');
}
async function consume(metadata, buffer, offset) {
  const operation = { frame: null, copied: null };
  const processingStarted = performance.now();
  try {
    requireCondition(!stopped, 'renderer_stopped');
    inspect(metadata, buffer, offset); counters.received++;
    const started = performance.now(), ySize = config.width * config.height;
    operation.frame = new VideoFrame(buffer, { format: 'NV12', codedWidth: config.width, codedHeight: config.height,
      displayWidth: config.width, displayHeight: config.height, timestamp: metadata.timestamp,
      layout: [{ offset, stride: config.width }, { offset: offset + ySize, stride: config.width }],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }, transfer: [buffer] });
    const constructMs = performance.now() - started;
    active.add(operation); counters.constructed++;
    requireCondition(buffer.byteLength === 0, 'videoframe_transfer_not_detached'); counters.detached++;
    const frame = operation.frame;
    requireCondition(frame.format === 'NV12' && frame.codedWidth === config.width && frame.codedHeight === config.height &&
      frame.timestamp === metadata.timestamp && frame.colorSpace.matrix === 'bt709' && frame.colorSpace.primaries === 'bt709' &&
      frame.colorSpace.transfer === 'bt709' && frame.colorSpace.fullRange === false, 'actual_frame_format_mismatch');
    actualFrame ||= { format: frame.format, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
      colorSpace: { primaries: frame.colorSpace.primaries, transfer: frame.colorSpace.transfer,
        matrix: frame.colorSpace.matrix, fullRange: frame.colorSpace.fullRange } };
    // An actual frame read verifies the transferred ownership and sequence. A
    // small rectangle keeps validation bounded and identical for both routes.
    const readbackStarted = performance.now();
    const options = { rect: { x: 0, y: 0, width: 4, height: 2 } };
    const allocated = frame.allocationSize(options);
    requireCondition(allocated >= 12 && allocated <= 128, 'frame_readback_size_invalid');
    operation.copied = new Uint8Array(allocated);
    const layout = await frame.copyTo(operation.copied, options);
    requireCondition(!stopped && operation.frame, 'renderer_stopped');
    requireCondition(Array.isArray(layout) && layout.length === 2 && layout[0].stride >= 4 && layout[1].stride >= 4 &&
      layout[0].offset >= 0 && layout[0].offset + layout[0].stride + 4 <= allocated &&
      layout[1].offset >= 0 && layout[1].offset + 4 <= allocated, 'frame_readback_layout_invalid');
    const copiedView = new DataView(operation.copied.buffer);
    requireCondition(copiedView.getUint32(layout[0].offset, true) === metadata.serial &&
      operation.copied[layout[0].offset + layout[0].stride] === 36 &&
      operation.copied[layout[1].offset] === 80 && operation.copied[layout[1].offset + 1] === 176,
    'constructed_frame_pixel_mismatch');
    counters.validated++; closeFrame(operation);
    timingSamples.readback.push(performance.now() - readbackStarted);
    timingSamples.processing.push(performance.now() - processingStarted);
    if (stopped) return;
    if (config.mode === 'ws') {
      requireCondition(socketAuthenticated && socket?.readyState === WebSocket.OPEN, 'renderer_ack_socket_closed');
      const ack = new ArrayBuffer(24), view = new DataView(ack);
      view.setUint32(0, MAGIC, true); view.setUint32(4, metadata.slot, true); view.setUint32(8, metadata.serial, true);
      view.setUint32(12, 7, true); view.setFloat64(16, constructMs, true); socket.send(ack);
      timingSamples.postAckBuffered.push(socket.bufferedAmount);
    } else send('ack', { slot: metadata.slot, serial: metadata.serial, flags: 7, constructMs });
    counters.acked++;
  } catch (error) { counters.rejected++; if (!stopped) fault(errorCode(error)); }
  finally { closeFrame(operation); zero(operation.copied); operation.copied = null; detach(buffer); }
}
function receive(metadata, buffer, offset) {
  if (stopped) { detach(buffer); return Promise.resolve(); }
  const arrivalAt = performance.now();
  if (lastArrivalAt !== null) timingSamples.receiveGap.push(arrivalAt - lastArrivalAt);
  lastArrivalAt = arrivalAt;
  const task = consume(metadata, buffer, offset); pending.add(task);
  counters.maxPending = Math.max(counters.maxPending, pending.size);
  task.finally(() => pending.delete(task)).catch(() => {});
  return task;
}
function onIpcFrame(_event, metadata, buffer) { if (config?.mode === 'ipc') receive(metadata, buffer, 0); else detach(buffer); }
function onIpcChunk(_event, metadata, buffer) {
  try {
    requireCondition(!stopped && config?.mode === 'ipc-inline-chunks' && chunkReceiver, 'unexpected_ipc_chunk');
    const complete = chunkReceiver.push(metadata, buffer);
    if (complete) receive(complete.metadata, complete.buffer, 0)
      .finally(() => chunkReceiver.release(complete.metadata.slot, complete.metadata.serial)).catch(() => {});
  } catch (error) { counters.rejected++; if (!stopped) fault(errorCode(error)); }
  finally { detach(buffer); }
}
ipcRenderer.on(PREFIX + 'frame', onIpcFrame);
ipcRenderer.on(PREFIX + 'chunk', onIpcChunk);
ipcRenderer.once(PREFIX + 'stop', () => { void stop(); });
ipcRenderer.once(PREFIX + 'init', (_event, value) => {
  if (initialized || stopped) { fault('renderer_duplicate_init'); return; }
  initialized = true;
  try {
    requireCondition(value && ['ipc', 'ipc-inline-chunks', 'ws'].includes(value.mode) && (value.width === 1728 || value.width === 1920) &&
      value.height === 1080 && typeof VideoFrame === 'function', 'invalid_probe_bootstrap');
    config = { mode: value.mode, width: value.width, height: value.height };
    if (value.mode === 'ipc-inline-chunks') chunkReceiver = new ChunkReceiver(value.width, value.height, value.chunkBytes, value.reassemblyDeadlineMs, fault);
    initialVisibility = document.visibilityState;
    if (value.mode !== 'ws') { send('connected'); return; }
    requireCondition(value.path === '/cpu-frame-probe' && Number.isInteger(value.port) && value.port > 0 && value.port < 65536,
      'invalid_loopback_endpoint');
    bootstrapToken = decodeSecret(value.token); expectedProof = decodeSecret(value.proof);
    value.token = value.proof = null;
    socket = new WebSocket('ws://127.0.0.1:' + value.port + value.path); socket.binaryType = 'arraybuffer';
    helloTimer = setTimeout(() => fault('renderer_hello_timeout'), 1500);
    socket.onopen = () => {
      const auth = new Uint8Array(33); auth[0] = 1; auth.set(bootstrapToken, 1); zero(bootstrapToken); bootstrapToken = null;
      socket.send(auth); zero(auth);
    };
    socket.onerror = () => fault('renderer_socket_failed');
    socket.onclose = () => { if (!stopped) fault('renderer_socket_closed'); };
    socket.onmessage = event => {
      const buffer = event.data;
      try {
        requireCondition(buffer instanceof ArrayBuffer, 'renderer_binary_message_required');
        if (!socketAuthenticated) {
          requireCondition(buffer.byteLength === 33, 'renderer_server_proof_invalid');
          const bytes = new Uint8Array(buffer); let difference = bytes[0] ^ 2;
          for (let index = 0; index < 32; ++index) difference |= bytes[index + 1] ^ expectedProof[index];
          requireCondition(difference === 0, 'renderer_server_proof_invalid');
          zero(expectedProof); expectedProof = null; detach(buffer);
          socketAuthenticated = true; clearTimeout(helloTimer); helloTimer = null; send('connected'); return;
        }
        requireCondition(buffer.byteLength === 32 + config.width * config.height * 3 / 2, 'renderer_frame_size_invalid');
        const view = new DataView(buffer);
        requireCondition(view.getUint32(0, true) === MAGIC && view.getUint16(4, true) === 1 &&
          view.getUint32(16, true) === config.width * config.height * 3 / 2, 'renderer_frame_header_invalid');
        receive({ slot: view.getUint16(6, true), serial: view.getUint32(8, true), width: view.getUint16(12, true),
          height: view.getUint16(14, true), timestamp: view.getUint32(20, true) }, buffer, 32);
      } catch (error) { detach(buffer); fault(errorCode(error)); }
    };
  } catch (error) { fault(errorCode(error)); }
});
ipcRenderer.send(PREFIX + 'ready');
