export interface ApplicationAudioSource {
  id: string;
  name: string;
  processId: number;
  processName: string;
  /** Windows app icon encoded as a data URL for renderer-safe display. */
  iconDataUrl?: string;
}

// The Windows loopback helper emits 48 kHz, signed 16-bit, interleaved stereo PCM.
// Small scheduled buffers keep latency around 80 ms while avoiding the long-term
// allocation and timing issues of a ScriptProcessorNode.
export class ApplicationAudioPipeline {
  readonly context: AudioContext;
  readonly gain: GainNode;
  readonly destination: MediaStreamAudioDestinationNode;
  private nextStart = 0;
  private closed = false;

  constructor(initialVolume: number) {
    this.context = new AudioContext({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
    this.gain = this.context.createGain();
    this.gain.gain.value = Math.max(0, Math.min(2, initialVolume));
    this.destination = this.context.createMediaStreamDestination();
    this.gain.connect(this.destination);
  }

  async resume() {
    if (this.context.state !== "running") await this.context.resume();
  }

  /**
   * MediaStreamAudioDestinationNode 在还没有任何输入节点启动时，可能会
   * 暂时产生一条 live 但没有 RTP SSRC 的音轨。先送一小段静音，让 Chromium
   * 建立稳定的音频发送轨道，再交给 mediasoup 协商。
   */
  prime() {
    if (this.closed) return;
    const frames = Math.max(1, Math.floor(this.context.sampleRate * 0.25));
    const buffer = this.context.createBuffer(2, frames, this.context.sampleRate);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start();
  }

  get track(): MediaStreamTrack {
    const track = this.destination.stream.getAudioTracks()[0];
    if (!track) throw new Error("无法创建应用音频轨道。");
    return track;
  }

  setVolume(volume: number) {
    this.gain.gain.value = Math.max(0, Math.min(2, volume));
  }

  pushPcm(chunk: Uint8Array) {
    if (this.closed || chunk.byteLength < 4) return;
    const frames = Math.floor(chunk.byteLength / 4);
    const buffer = this.context.createBuffer(2, frames, 48_000);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const view = new DataView(chunk.buffer, chunk.byteOffset, frames * 4);
    for (let index = 0, offset = 0; index < frames; index += 1, offset += 4) {
      left[index] = view.getInt16(offset, true) / 32768;
      right[index] = view.getInt16(offset + 2, true) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.context.currentTime;
    // Capture callbacks are not clock-perfect. Keep a small lead, but discard a
    // stale schedule after a temporary renderer stall instead of accumulating delay.
    if (this.nextStart < now + 0.04 || this.nextStart > now + 0.35)
      this.nextStart = now + 0.08;
    source.start(this.nextStart);
    this.nextStart += buffer.duration;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.destination.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
  }
}
