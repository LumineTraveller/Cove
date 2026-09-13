import wasmLoader from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js?raw';
import processorSource from './rnnoiseProcessor.js?raw';
import { connectMicrophoneGain, type ProcessedMicrophone } from './microphoneProcessing';

// The sync build uses the RNNoise 0.2 model. Do not import the package's main
// entry: its asynchronous build intentionally uses the older detection model.
const workletSource = wasmLoader.replace('export default createRNNWasmModuleSync;', '') + '\n' + processorSource;

export async function createRnnoiseMicrophone(
  rawStream: MediaStream,
  volume: number,
): Promise<ProcessedMicrophone & { processor: AudioWorkletNode }> {
  let context: AudioContext | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let processor: AudioWorkletNode | undefined;
  const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    if (!context.audioWorklet || context.sampleRate !== 48_000) throw new Error('此设备不支持 RNNoise 音频处理');
    const ready = async () => {
      await context!.audioWorklet.addModule(url);
      // The timeout may have closed the context while addModule was pending.
      if (context!.state === 'closed') throw new Error('RNNoise 初始化已取消');
      processor = new AudioWorkletNode(context!, 'cove-rnnoise', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit',
      });
      const initialized = new Promise<void>((resolve, reject) => {
        processor!.port.onmessage = ({ data }) => { if (data?.type === 'ready') resolve(); };
        processor!.onprocessorerror = () => reject(new Error('RNNoise 模型初始化失败'));
      });
      destination = context!.createMediaStreamDestination();
      destination.channelCount = 1;
      const source = context!.createMediaStreamSource(rawStream);
      source.connect(processor);
      const gain = connectMicrophoneGain(context!, processor, destination, volume);
      await Promise.all([initialized, context!.resume()]);
      const track = destination.stream.getAudioTracks()[0];
      if (context!.state !== 'running' || track?.readyState !== 'live') throw new Error('RNNoise 音轨未就绪');
      track.contentHint = 'speech';
      processor.onprocessorerror = null;
      processor.port.onmessage = null;
      return { stream: destination.stream, context: context!, gain, processor };
    };
    return await Promise.race([
      ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RNNoise 初始化超时')), 5_000);
      }),
    ]);
  } catch (error) {
    processor?.port.postMessage({ type: 'dispose' });
    destination?.stream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => {});
    // This capture has native NS disabled. Never silently publish it as a
    // fallback: the caller must reacquire a system-processed microphone.
    throw error;
  } finally {
    URL.revokeObjectURL(url);
    if (timer !== undefined) clearTimeout(timer);
  }
}
