// 48 kHz signed 16-bit stereo. Bound pending IPC/MessagePort data independently
// of the AudioWorklet ring: a blocked UI must not accumulate seconds of PCM.
export class PcmChunkQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  droppedFrames = 0;

  constructor(readonly maxBytes = 48_000 * 4 * 0.12) {}

  get byteLength() { return this.bytes; }

  push(chunk: Uint8Array) {
    const length = chunk.byteLength - chunk.byteLength % 4;
    if (!length) return;
    // Own the bytes; neither a native Buffer nor the caller's typed array may
    // be detached or mutated while queued.
    this.chunks.push(chunk.slice(0, length));
    this.bytes += length;
    let excess = this.bytes - this.maxBytes;
    while (excess > 0 && this.chunks.length) {
      const first = this.chunks[0];
      const drop = Math.min(first.byteLength, excess);
      if (drop === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.slice(drop);
      this.bytes -= drop;
      this.droppedFrames += drop / 4;
      excess -= drop;
    }
  }

  drain(): Uint8Array | null {
    if (!this.bytes) return null;
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    this.chunks = [];
    this.bytes = 0;
    return output;
  }

  clear() { this.chunks = []; this.bytes = 0; this.droppedFrames = 0; }
}
