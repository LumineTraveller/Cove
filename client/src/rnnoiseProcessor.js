// Appended to the locally bundled @jitsi/rnnoise-wasm sync loader. RNNoise
// owns the DSP; this adapter only bridges Web Audio quanta to 480-sample PCM.
class CoveRnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    if (sampleRate !== 48000) throw new Error('RNNoise requires 48 kHz');
    this.module = createRNNWasmModuleSync();
    this.state = this.module._rnnoise_create(0);
    this.pcm = this.module._malloc(480 * 4);
    if (!this.state || !this.pcm) throw new Error('RNNoise allocation failed');
    this.input = new Float32Array(480);
    this.inputCount = 0;
    // Fixed 10 ms bridge latency, irrespective of quantum boundaries (128
    // does not divide 480). Never repeat/drop samples or alternate latency.
    this.output = new Float32Array(2048);
    this.readIndex = 0;
    this.writeIndex = 480;
    this.disposed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'dispose' && !this.disposed) {
        this.module._rnnoise_destroy(this.state);
        this.module._free(this.pcm);
        this.disposed = true;
      }
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (this.disposed || !output) return false;
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
