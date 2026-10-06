// No timers, AudioBufferSources, imports or per-render-quantum allocations.
// Capture remains Windows 48 kHz s16 stereo. Only this audio thread advances
// the read cursor; delayed UI callbacks cannot reschedule the playback clock.
class CoveApplicationAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = 48000;
    this.capacity = 5760; // 120 ms, bounded even if MessagePort delivers a burst.
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.count = 0;
    this.phase = 0;
    this.ratio = this.inputRate / sampleRate;
    this.target = 1440; // 30 ms startup, adaptive 20..80 ms after underruns.
    this.playing = false;
    this.closed = false;
    this.lastLeft = 0;
    this.lastRight = 0;
    this.fadeFrames = Math.max(1, Math.round(sampleRate * 0.005));
    this.fadeRemaining = 0;
    this.fadeLeft = 0;
    this.fadeRight = 0;
    this.rendered = 0;
    this.stableFrames = 0;
    this.underflows = 0;
    this.droppedFrames = 0;
    this.nextReport = sampleRate;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'close') { this.closed = true; this.count = 0; return; }
      if (this.closed || data?.type !== 'pcm' || !data.buffer) return;
      this.push(data.buffer);
      this.port.postMessage({ type: 'accepted', sequence: data.sequence });
    };
    this.port.postMessage({ type: 'ready' });
  }

  transition() {
    // Crossfade from the actual last output, not the master volume. Covers
    // underflow and discarded stale frames without a one-sample hard edge.
    this.fadeLeft = this.lastLeft;
    this.fadeRight = this.lastRight;
    this.fadeRemaining = this.fadeFrames;
  }

  push(buffer) {
    const view = new DataView(buffer);
    const total = Math.floor(view.byteLength / 4);
    if (!total) return;
    // A large delayed callback is stale history, not a new steady-state water
    // level. Rejoin near the current target rather than remaining ~120 ms late
    // indefinitely. Ordinary 10..40 ms capture packets are left untouched.
    const staleBurst = total >= this.capacity || this.count + total > this.capacity;
    const keep = staleBurst ? Math.min(this.capacity, this.target + 480) : this.capacity;
    const frames = Math.min(total, keep);
    const skip = total - frames;
    const discard = staleBurst ? this.count : Math.max(0, this.count + frames - this.capacity);
    if (discard || skip) {
      this.droppedFrames += discard + skip;
      this.read = (this.read + discard) % this.capacity;
      this.count -= discard;
      this.phase = 0;
      this.stableFrames = 0;
      this.transition();
    }
    let write = (this.read + this.count) % this.capacity;
    for (let i = skip; i < total; i++) {
      this.left[write] = view.getInt16(i * 4, true) / 32768;
      this.right[write] = view.getInt16(i * 4 + 2, true) / 32768;
      write = (write + 1) % this.capacity;
    }
    this.count += frames;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return !this.closed;
    const left = output[0];
    const right = output[1];
    for (let i = 0; i < left.length; i++) {
      let l = 0, r = 0;
      if (!this.closed && !this.playing && this.fadeRemaining === 0 && this.count >= this.target) {
        this.playing = true;
        this.transition();
      }
      if (!this.closed && this.playing) {
        // Resample ONLY when the hardware context differs from the capture
        // rate. At 48 kHz samples are preserved exactly (apart from fades).
        const required = Math.max(1, Math.ceil(this.phase + this.ratio), this.phase > 0 ? 2 : 1);
        if (this.count >= required) {
          const next = (this.read + 1) % this.capacity;
          l = this.left[this.read] + (this.left[next] - this.left[this.read]) * this.phase;
          r = this.right[this.read] + (this.right[next] - this.right[this.read]) * this.phase;
          this.phase += this.ratio;
          const consumed = Math.floor(this.phase);
          this.phase -= consumed;
          this.read = (this.read + consumed) % this.capacity;
          this.count -= consumed;
          this.stableFrames++;
          if (this.stableFrames >= sampleRate * 10 && this.target > 960) {
            this.target = Math.max(960, this.target - 240);
            this.stableFrames = 0;
          }
        } else {
          this.playing = false;
          this.underflows++;
          this.stableFrames = 0;
          this.target = Math.min(3840, this.target + 480);
          this.phase = 0;
          this.transition();
        }
      }
      if (this.fadeRemaining > 0) {
        const oldWeight = --this.fadeRemaining / this.fadeFrames;
        l = this.fadeLeft * oldWeight + l * (1 - oldWeight);
        r = this.fadeRight * oldWeight + r * (1 - oldWeight);
      }
      left[i] = this.lastLeft = l;
      if (right) right[i] = this.lastRight = r;
      for (let channel = 2; channel < output.length; channel++) output[channel][i] = 0;
    }
    this.rendered += left.length;
    if (!this.closed && this.rendered >= this.nextReport) {
      this.nextReport = this.rendered + sampleRate;
      this.port.postMessage({ type: 'stats', bufferedMs: this.count / 48,
        targetMs: this.target / 48, underflows: this.underflows, droppedFrames: this.droppedFrames });
    }
    return !this.closed;
  }
}
registerProcessor('cove-application-audio', CoveApplicationAudioProcessor);
