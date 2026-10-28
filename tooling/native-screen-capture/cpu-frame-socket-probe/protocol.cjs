'use strict';
const MAGIC = 0x43504631;
const HEADER_BYTES = 32;
const ACK_BYTES = 24;
const POOL_SIZE = 3;
const SOCKET_PATH = '/cpu-frame-probe';
const INLINE_CHUNK_BYTES = 48 * 1024;
const REASSEMBLY_DEADLINE_MS = 1500;
function demand(value, code) { if (!value) throw new Error(code); }
function dimensions(width, height) {
  demand((width === 1728 || width === 1920) && height === 1080, 'invalid_frame_dimensions');
  return width * height * 3 / 2;
}
function configuration(args) {
  const result = { width: 1728, height: 1080, seconds: 8, warmup: 2, modes: ['ipc', 'ws'],
    pacer: 'native', wsFraming: 'fragmented', window: 'hidden', chunkBytes: INLINE_CHUNK_BYTES };
  for (let index = 0; index < args.length; ++index) {
    const name = args[index], value = args[++index];
    if (name === '--width') result.width = Number(value);
    else if (name === '--seconds') result.seconds = Number(value);
    else if (name === '--warmup') result.warmup = Number(value);
    else if (name === '--mode' && ['ipc', 'ipc-inline-chunks', 'ws', 'both', 'ws-first'].includes(value))
      result.modes = value === 'both' ? ['ipc', 'ws'] : value === 'ws-first' ? ['ws', 'ipc'] : [value];
    else if (name === '--pacer' && ['native', 'node'].includes(value)) result.pacer = value;
    else if (name === '--ws-framing' && ['fragmented', 'fragmented-cork', 'single-copy'].includes(value)) result.wsFraming = value;
    else if (name === '--window' && ['hidden', 'shown'].includes(value)) result.window = value;
    else if (name === '--chunk-bytes') result.chunkBytes = value === 'frame' ? 'frame' : Number(value);
    else demand(false, 'invalid_probe_arguments');
  }
  const frameBytes = dimensions(result.width, result.height);
  if (result.chunkBytes === 'frame') result.chunkBytes = frameBytes;
  demand(result.chunkBytes === INLINE_CHUNK_BYTES || result.chunkBytes === frameBytes, 'invalid_chunk_bytes');
  demand(Number.isInteger(result.seconds) && result.seconds >= 2 && result.seconds <= 30, 'invalid_measurement_seconds');
  demand(Number.isInteger(result.warmup) && result.warmup >= 1 && result.warmup <= 5, 'invalid_warmup_seconds');
  return result;
}
function sendIpcChunks(metadata, buffer, chunkBytes, send) {
  const frameBytes = dimensions(metadata.width, metadata.height);
  demand(buffer instanceof ArrayBuffer && buffer.byteLength === frameBytes &&
    (chunkBytes === INLINE_CHUNK_BYTES || chunkBytes === frameBytes) && typeof send === 'function', 'invalid_ipc_chunk_source');
  const partCount = Math.ceil(frameBytes / chunkBytes);
  for (let part = 0; part < partCount; ++part) {
    const offset = part * chunkBytes, partBytes = Math.min(chunkBytes, frameBytes - offset);
    // A view retains the full backing store during Electron serialization. Each
    // send therefore gets its own exact-sized ordinary ArrayBuffer. The caller
    // starts sendCall timing before entering this loop, including every copy.
    const independent = buffer.slice(offset, offset + partBytes);
    send({ ...metadata, part, partCount, offset, partBytes, frameBytes, chunkBytes }, independent);
  }
  return partCount;
}
function fillPattern(buffer, width, height) {
  dimensions(width, height);
  demand(buffer instanceof ArrayBuffer && buffer.byteLength === width * height * 3 / 2, 'invalid_pool_buffer');
  const bytes = new Uint8Array(buffer), yBytes = width * height;
  // Flat quadrants independently checked by the preload, with 32-bit sequence
  // stamps at both ends of Y. The source is synthetic and never read from disk.
  for (let y = 0; y < height; ++y) {
    const base = y < height / 2 ? 36 : 142;
    bytes.fill(base, y * width, y * width + width / 2);
    bytes.fill(base + 48, y * width + width / 2, (y + 1) * width);
  }
  for (let y = 0; y < height / 2; ++y) for (let x = 0; x < width; x += 2) {
    const quadrant = (y >= height / 4 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
    bytes[yBytes + y * width + x] = 80 + quadrant * 24;
    bytes[yBytes + y * width + x + 1] = 176 - quadrant * 20;
  }
}
function stamp(buffer, width, height, serial) {
  const bytes = new DataView(buffer), tail = width * height - 4;
  bytes.setUint32(0, serial, true); bytes.setUint32(tail, serial, true);
}
function writeHeader(buffer, meta) {
  demand(Buffer.isBuffer(buffer) && buffer.length === HEADER_BYTES, 'invalid_header_buffer');
  buffer.writeUInt32LE(MAGIC, 0); buffer.writeUInt16LE(1, 4); buffer.writeUInt16LE(meta.slot, 6);
  buffer.writeUInt32LE(meta.serial, 8); buffer.writeUInt16LE(meta.width, 12); buffer.writeUInt16LE(meta.height, 14);
  buffer.writeUInt32LE(dimensions(meta.width, meta.height), 16);
  buffer.writeUInt32LE(meta.timestamp, 20); buffer.fill(0, 24, 32);
  return buffer;
}
function readAck(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== ACK_BYTES || buffer.readUInt32LE(0) !== MAGIC) return null;
  const result = { slot: buffer.readUInt32LE(4), serial: buffer.readUInt32LE(8), flags: buffer.readUInt32LE(12), constructMs: buffer.readDoubleLE(16) };
  return Number.isFinite(result.constructMs) && result.constructMs >= 0 && result.constructMs < 5000 && result.flags === 7 ? result : null;
}
class Pool {
  constructor(width, height) {
    this.slots = Array.from({ length: POOL_SIZE }, (_, index) => {
      const buffer = new ArrayBuffer(dimensions(width, height)); fillPattern(buffer, width, height);
      return { index, buffer, payload: Buffer.from(buffer), header: Buffer.alloc(HEADER_BYTES), serial: 0, busy: false, flushed: false, acked: false };
    });
    this.active = true; this.inFlight = 0; this.maxInFlight = 0; this.releases = 0;
  }
  take(serial) {
    if (!this.active || !Number.isSafeInteger(serial) || serial <= 0 || serial > 0xffffffff) return null;
    const slot = this.slots.find(value => !value.busy);
    if (!slot) return null;
    Object.assign(slot, { serial, busy: true, flushed: false, acked: false });
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    return slot;
  }
  matches(index, serial) {
    const slot = this.slots[index];
    return this.active && slot?.busy && slot.serial === serial ? slot : null;
  }
  flush(index, serial) { const slot = this.matches(index, serial); if (!slot || slot.flushed) return false; slot.flushed = true; this.release(slot); return true; }
  ack(index, serial) { const slot = this.matches(index, serial); if (!slot || slot.acked) return false; slot.acked = true; this.release(slot); return true; }
  release(slot) { if (slot.acked && slot.flushed) { slot.busy = false; this.inFlight--; this.releases++; } }
  stop() { this.active = false; for (const slot of this.slots) { slot.buffer = null; slot.payload = null; slot.header = null; slot.busy = false; } this.inFlight = 0; }
}
function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
}
module.exports = { MAGIC, HEADER_BYTES, ACK_BYTES, POOL_SIZE, SOCKET_PATH, INLINE_CHUNK_BYTES, REASSEMBLY_DEADLINE_MS,
  demand, dimensions, configuration, sendIpcChunks, fillPattern, stamp, writeHeader, readAck, Pool, summary };
