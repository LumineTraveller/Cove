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
const SAMPLE_RATE = 48_000;
const MIN_LEAD = 0.04;
const TARGET_LEAD = 0.08;
const MAX_HORIZON = 0.35;

export class ApplicationAudioPipeline {
  readonly context: AudioContext;
  readonly gain: GainNode;
  readonly destination: MediaStreamAudioDestinationNode;
  private nextStart = 0;
  private closed = false;
  private scheduled = new Map<AudioBufferSourceNode, {
    start: number;
    end: number;
    gain: GainNode;
    warmup: boolean;
    cancelled: boolean;
    cleanup: () => void;
  }>();

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
    this.schedule(buffer, this.context.currentTime, true);
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
    const now = this.context.currentTime;
    for (const entry of this.scheduled.values()) {
      if (entry.end <= now) entry.cleanup();
    }
    // A delayed capture/IPC callback can deliver seconds of old PCM at once.
    // Keep the newest complete frames inside the existing 350ms horizon.
    const totalFrames = Math.floor(chunk.byteLength / 4);
    const frames = Math.min(totalFrames, Math.floor(SAMPLE_RATE * (MAX_HORIZON - TARGET_LEAD)));
    const duration = frames / SAMPLE_RATE;
    if (this.nextStart < now + MIN_LEAD || this.nextStart + duration > now + MAX_HORIZON) {
      this.discardScheduledPcm(now);
      this.nextStart = now + TARGET_LEAD;
    }
    const buffer = this.context.createBuffer(2, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const view = new DataView(chunk.buffer, chunk.byteOffset + (totalFrames - frames) * 4, frames * 4);
    for (let index = 0, offset = 0; index < frames; index += 1, offset += 4) {
      left[index] = view.getInt16(offset, true) / 32768;
      right[index] = view.getInt16(offset + 2, true) / 32768;
    }
    this.schedule(buffer, this.nextStart);
    this.nextStart += buffer.duration;
  }

  private schedule(buffer: AudioBuffer, start: number, warmup = false) {
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.gain);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.scheduled.delete(source);
      source.onended = null;
      source.disconnect();
      gain.disconnect();
    };
    this.scheduled.set(source, { start, end: start + buffer.duration, gain, warmup, cancelled: false, cleanup });
    source.onended = cleanup;
    source.start(start);
  }

  private discardScheduledPcm(now: number) {
    for (const [source, entry] of this.scheduled) {
      if (entry.warmup || entry.cancelled) continue;
      entry.cancelled = true;
      if (entry.start < now && entry.end > now) {
        // Fade only the interrupted chunk, not the user's master volume.
        entry.gain.gain.setValueAtTime(1, now);
        entry.gain.gain.linearRampToValueAtTime(0, now + 0.005);
        source.stop(now + 0.005);
      } else {
        source.stop();
        entry.cleanup();
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [source, entry] of this.scheduled) {
      source.stop();
      entry.cleanup();
    }
    this.destination.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
  }
}
