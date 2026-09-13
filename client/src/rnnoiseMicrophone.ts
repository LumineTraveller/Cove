import wasmLoader from './rnnoiseWasmLoader.js?raw';
import wasmUrl from './rnnoise-v2.wasm?url';
import processorSource from './rnnoiseProcessor.js?raw';
import { connectMicrophoneGain, type ProcessedMicrophone } from './microphoneProcessing';

// The generated loader keeps the RNNoise 0.2 model's WASM separate from the
// glue code. The binary is fetched by the renderer and transferred to the
// AudioWorklet, which avoids the multi-megabyte base64 installer overhead.
const workletSource = wasmLoader + '\n' + processorSource;

async function loadRnnoiseWasm(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`RNNoise WASM 加载失败（HTTP ${response.status}）`);
  return response.arrayBuffer();
}

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
      const wasmBinary = await loadRnnoiseWasm();
      processor = new AudioWorkletNode(context!, 'cove-rnnoise', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit',
      });
      const initialized = new Promise<void>((resolve, reject) => {
        processor!.port.onmessage = ({ data }) => {
          if (data?.type === 'ready') resolve();
          else if (data?.type === 'error') reject(new Error(data.message || 'RNNoise 模型初始化失败'));
        };
        processor!.onprocessorerror = () => reject(new Error('RNNoise 模型初始化失败'));
      });
      processor.port.postMessage({ type: 'wasm', wasmBinary }, [wasmBinary]);
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
