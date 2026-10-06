// Appended to the locally bundled @jitsi/rnnoise-wasm loader. RNNoise owns the
// DSP; this adapter only bridges Web Audio quanta to 480-sample PCM.
class CoveRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    if (sampleRate !== 48000) throw new Error('RNNoise requires 48 kHz');
    this.module = null;
    this.state = 0;
    this.pcm = 0;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.wasmResolve = null;
    this.wasmReject = null;
    this.input = new Float32Array(480);
    this.inputCount = 0;
    // Fixed 10 ms bridge latency, irrespective of quantum boundaries (128
    // does not divide 480). Never repeat/drop samples or alternate latency.
    this.output = new Float32Array(2048);
    this.readIndex = 0;
    this.writeIndex = 480;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'dispose') this.dispose();
      else if (data?.type === 'wasm' && this.wasmResolve) {
        const resolve = this.wasmResolve;
        this.wasmResolve = null;
        this.wasmReject = null;
        resolve(data.wasmBinary);
      }
    };
    void this.initialize();
  }

  async initialize() {
    let module = null;
    let state = 0;
    let pcm = 0;
    try {
      const wasmBinary = await new Promise((resolve, reject) => {
        this.wasmResolve = resolve;
        this.wasmReject = reject;
      });
      if (this.disposed) return;
      module = createRNNWasmModuleSync({ wasmBinary });
      if (this.disposed) return;
      state = module._rnnoise_create(0);
      pcm = module._malloc(480 * 4);
      if (!state || !pcm) throw new Error('RNNoise allocation failed');
      if (this.disposed) {
        module._rnnoise_destroy(state);
        module._free(pcm);
        return;
      }
      this.module = module;
      this.state = state;
      this.pcm = pcm;
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (error) {
      if (module) {
        if (state) module._rnnoise_destroy(state);
        if (pcm) module._free(pcm);
      }
      if (!this.disposed) {
        this.failed = true;
        this.port.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.wasmReject?.(new Error('RNNoise 初始化已取消'));
    this.wasmResolve = null;
    this.wasmReject = null;
    if (this.module) {
      if (this.state) this.module._rnnoise_destroy(this.state);
      if (this.pcm) this.module._free(this.pcm);
    }
    this.module = null;
    this.state = 0;
    this.pcm = 0;
    this.ready = false;
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (this.disposed) return false;
    if (!output) return !this.failed;
    if (!this.ready) {
      output.fill(0);
      for (let channel = 1; channel < outputs[0].length; channel++) outputs[0][channel].fill(0);
      return !this.failed;
    }
    const input = inputs[0]?.[0];
    for (let i = 0; i < output.length; i++) {
      this.input[this.inputCount++] = input?.[i] ?? 0;
      if (this.inputCount === 480) {
        const offset = this.pcm >>> 2;
        // RNNoise expects floats in signed 16-bit PCM scale, not [-1, 1].
        for (let j = 0; j < 480; j++) this.module.HEAPF32[offset + j] = this.input[j] * 32768;
        this.module._rnnoise_process_frame(this.state, this.pcm, this.pcm);
        for (let j = 0; j < 480; j++) {
          this.output[this.writeIndex] = this.module.HEAPF32[offset + j] / 32768;
          this.writeIndex = (this.writeIndex + 1) % this.output.length;
        }
        this.inputCount = 0;
      }
      output[i] = this.output[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.output.length;
    }
    for (let channel = 1; channel < outputs[0].length; channel++) outputs[0][channel].set(output);
    return true;
  }
}
registerProcessor('cove-rnnoise', CoveRnnoiseProcessor);
