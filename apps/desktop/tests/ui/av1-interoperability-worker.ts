import '../../src/features/media/screen/av1ScreenSenderWorker';
import type { Av1SenderWorkerOptions } from '../../src/features/media/screen/av1ScreenSenderWorker';
import { createAv1SequenceHeaderRepeater } from '../../src/features/media/screen/av1SequenceHeader';

type Transformer = {
  readable: ReadableStream<RTCEncodedVideoFrame>;
  writable: WritableStream<RTCEncodedVideoFrame>;
  options?: Av1SenderWorkerOptions;
  generateKeyFrame?(): Promise<unknown>;
};

const scope = globalThis as unknown as {
  onrtctransform(event: { transformer: Transformer }): void;
  postMessage(message: { type: 'av1-interop-prefix'; hasSequence: boolean; stripped: boolean }): void;
};
const runSender = scope.onrtctransform;
const contentLightMetadata = Uint8Array.of(0x2a, 0x06, 0x01, 0x00, 0x64, 0x00, 0x32, 0x80);
const stripSequence = new URLSearchParams(location.search).has('stripSequence');

scope.onrtctransform = ({ transformer }) => {
  let headerLength = 0;
  const supplyHeader = createAv1SequenceHeaderRepeater(undefined, config => { headerLength = config?.bytes.length ?? 0; });
  const withLeadingMetadata = transformer.readable.pipeThrough(new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
    transform(frame, output) {
      if (frame.type === 'key') {
        supplyHeader(frame);
        const bytes = new Uint8Array(frame.data);
        const offset = bytes[0] === 0x12 && bytes[1] === 0 ? 2 : 0;
        const hasSequence = headerLength > 0 && ((bytes[offset] ?? 0) & 0x78) === 0x08;
        const removed = stripSequence && hasSequence ? headerLength : 0;
        const added = stripSequence ? 0 : contentLightMetadata.length;
        const augmented = new Uint8Array(bytes.length + added - removed);
        augmented.set(bytes.subarray(0, offset));
        if (added) augmented.set(contentLightMetadata, offset);
        augmented.set(bytes.subarray(offset + removed), offset + added);
        frame.data = augmented.buffer;
        scope.postMessage({ type: 'av1-interop-prefix', hasSequence, stripped: removed > 0 });
      }
      output.enqueue(frame);
    },
  }));
  runSender({ transformer: {
    readable: withLeadingMetadata,
    writable: transformer.writable,
    options: transformer.options,
    generateKeyFrame: transformer.generateKeyFrame?.bind(transformer),
  } });
};
