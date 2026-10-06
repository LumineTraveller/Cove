import { PcmChunkQueue } from '../../../../electron/pcmChunkQueue';

export interface ApplicationAudioSource {
  id: string;
  name: string;
  processId: number;
  processName: string;
  /** Windows app icon encoded as a data URL for renderer-safe display. */
  iconDataUrl?: string;
}

// The Windows loopback helper emits 48 kHz, signed 16-bit, interleaved stereo PCM.
// Scheduled 80 ms buffers are retained ONLY for legacy A/B and worklet fallback.
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
  private worklet: AudioWorkletNode | null = null;
  private initializingNode: AudioWorkletNode | null = null;
  private abortInitialization: (() => void) | null = null;
  private disposedNodes = new WeakSet<AudioWorkletNode>();
  private initialization: Promise<void> | null = null;
  private pendingPcm = new PcmChunkQueue();
  private sequence = 0;
  private inFlightSequence: number | null = null;
  private workletFailed = false;
  private readonly legacy: boolean;
  private workletStats: { bufferedMs: number; targetMs: number; underflows: number; droppedFrames: number } | null = null;
  private scheduled = new Map<
    AudioBufferSourceNode,
    {
      start: number;
      end: number;
      gain: GainNode;
      warmup: boolean;
      cancelled: boolean;
      cleanup: () => void;
    }
  >();

  constructor(initialVolume: number) {
    let legacy = false;
    try {
      legacy = window.coveAudioLatencyProfile === 'legacy'
        || localStorage.getItem('cove:legacy-shared-audio-pipeline') === '1';
    } catch { /* Node tests and locked-down storage use capability detection. */ }
    this.legacy = legacy;
    this.context = new AudioContext({
      sampleRate: 48_000,
      latencyHint: 'interactive',
    });
    this.gain = this.context.createGain();
    this.gain.gain.value = Math.max(0, Math.min(2, initialVolume));
    this.destination = this.context.createMediaStreamDestination();
    this.gain.connect(this.destination);
  }

  async resume() {
    if (this.closed) return;
    if (this.context.state !== 'running') await this.context.resume();
    if (this.closed || this.legacy || !this.context.audioWorklet || this.workletFailed) return;
    this.initialization ??= this.initializeWorklet();
    await this.initialization;
  }

  get diagnostics() {
    return { mode: this.worklet ? 'worklet' : 'legacy', ...this.workletStats,
      pendingMs: this.pendingPcm.byteLength / 192, ipcDroppedFrames: this.pendingPcm.droppedFrames };
  }

  private async initializeWorklet() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let node: AudioWorkletNode | null = null;
    try {
      // Vite emits this standalone script as an asset; no raw import is needed
      // and the same module is executable in real Electron verification.
      const moduleUrl = new URL('./applicationAudioProcessor.js', import.meta.url).href;
      await Promise.race([
        (async () => {
          await this.context.audioWorklet.addModule(moduleUrl);
          if (this.closed || this.workletFailed) return;
          node = new AudioWorkletNode(this.context, 'cove-application-audio', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          });
          const currentNode = node;
          this.initializingNode = currentNode;
          await new Promise<void>((resolve, reject) => {
            this.abortInitialization = () => reject(new Error('共享音频管线已关闭。'));
            currentNode.onprocessorerror = () => reject(new Error('共享音频处理器启动失败。'));
            currentNode.port.onmessage = ({ data }) => {
              if (this.closed) return;
              if (data?.type === 'ready') resolve();
              else if (data?.type === 'accepted' && data.sequence === this.inFlightSequence) {
                this.inFlightSequence = null;
                this.flushWorkletPcm();
              } else if (data?.type === 'stats') this.workletStats = data;
            };
            // Connect before waiting: the audio rendering thread must be active
            // to instantiate the processor and emit its ready message.
            currentNode.connect(this.gain);
          });
          if (this.closed || this.workletFailed) return;
          this.worklet = currentNode;
          currentNode.onprocessorerror = () => {
            if (this.closed || this.worklet !== currentNode) return;
            this.workletFailed = true;
            this.disposeWorklet(currentNode);
            this.worklet = null;
            this.inFlightSequence = null;
            this.prime();
            const pending = this.pendingPcm.drain();
            if (pending) this.pushPcm(pending);
            console.warn('[application-audio] 处理器停止，使用兼容缓冲路径。');
          };
          this.flushWorkletPcm();
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('共享音频处理器启动超时。')), 5000);
        }),
      ]);
    } catch (error) {
      this.workletFailed = true;
      this.disposeWorklet(node);
      if (!this.closed) console.warn('[application-audio] 使用兼容缓冲路径:', error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.initializingNode = null;
      this.abortInitialization = null;
      if (this.closed || this.workletFailed) this.disposeWorklet(node);
    }
  }

  private disposeWorklet(node: AudioWorkletNode | null) {
    if (!node || this.disposedNodes.has(node)) return;
    this.disposedNodes.add(node);
    node.port.onmessage = null;
    node.onprocessorerror = null;
    node.port.postMessage({ type: 'close' });
    node.disconnect();
    node.port.close();
  }

  private flushWorkletPcm() {
    if (this.closed || !this.worklet || this.inFlightSequence !== null) return;
    const chunk = this.pendingPcm.drain();
    if (!chunk) return;
    this.inFlightSequence = ++this.sequence;
    this.worklet.port.postMessage({ type: 'pcm', buffer: chunk.buffer, sequence: this.inFlightSequence }, [chunk.buffer]);
  }

  /**
   * MediaStreamAudioDestinationNode 在还没有任何输入节点启动时，可能会
   * 暂时产生一条 live 但没有 RTP SSRC 的音轨。先送一小段静音，让 Chromium
   * 建立稳定的音频发送轨道，再交给 mediasoup 协商。
   */
  prime() {
    if (this.closed) return;
    // The zero-input processor continuously emits stereo silence even before
    // capture starts, preserving the existing live-track/SSRC warmup contract.
    if (this.worklet) return;
    const frames = Math.max(1, Math.floor(this.context.sampleRate * 0.25));
    const buffer = this.context.createBuffer(2, frames, this.context.sampleRate);
    this.schedule(buffer, this.context.currentTime, true);
  }

  get track(): MediaStreamTrack {
    const track = this.destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('无法创建应用音频轨道。');
    return track;
  }

  setVolume(volume: number) {
    this.gain.gain.value = Math.max(0, Math.min(2, volume));
  }

  pushPcm(chunk: Uint8Array) {
    if (this.closed || chunk.byteLength < 4) return;
    if (this.worklet) {
      this.pendingPcm.push(chunk);
      this.flushWorkletPcm();
      return;
    }
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
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset + (totalFrames - frames) * 4,
      frames * 4,
    );
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
    this.scheduled.set(source, {
      start,
      end: start + buffer.duration,
      gain,
      warmup,
      cancelled: false,
      cleanup,
    });
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
    this.abortInitialization?.();
    this.disposeWorklet(this.initializingNode);
    this.pendingPcm.clear();
    this.inFlightSequence = null;
    this.disposeWorklet(this.worklet);
    this.worklet = null;
    for (const [source, entry] of this.scheduled) {
      source.stop();
      entry.cleanup();
    }
    this.destination.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
  }
}
