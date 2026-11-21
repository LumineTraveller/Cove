// 48 kHz signed 16-bit stereo. Bound pending IPC/MessagePort data independently
// of the AudioWorklet ring: a blocked UI must not accumulate seconds of PCM.
export const PCM_SAMPLE_RATE = 48_000;
export const PCM_FRAME_BYTES = 4;
export const SCREEN_PCM_QUEUE_FRAMES = PCM_SAMPLE_RATE / 2;
export const SCREEN_PCM_QUEUE_MAX_BYTES = SCREEN_PCM_QUEUE_FRAMES * PCM_FRAME_BYTES;

export class PcmChunkQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  droppedFrames = 0;

  constructor(readonly maxBytes = PCM_SAMPLE_RATE * PCM_FRAME_BYTES * 0.12) {}

  get byteLength() { return this.bytes; }

  push(chunk: Uint8Array) {
    const length = chunk.byteLength - chunk.byteLength % PCM_FRAME_BYTES;
    if (!length) return;
    // Own the bytes; neither a native Buffer nor the caller's typed array may
    // be detached or mutated while queued.
    const skip = Math.max(0, length - this.maxBytes);
    this.droppedFrames += skip / PCM_FRAME_BYTES;
    this.append(new Uint8Array(chunk.subarray(skip, length)));
  }

  pushSilence(frames: number) {
    const kept = Math.min(frames, this.maxBytes / PCM_FRAME_BYTES);
    this.droppedFrames += frames - kept;
    if (kept > 0) this.append(new Uint8Array(kept * PCM_FRAME_BYTES));
  }

  private append(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    let excess = this.bytes - this.maxBytes;
    while (excess > 0 && this.chunks.length) {
      const first = this.chunks[0];
      const drop = Math.min(first.byteLength, excess);
      if (drop === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.slice(drop);
      this.bytes -= drop;
      this.droppedFrames += drop / PCM_FRAME_BYTES;
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
