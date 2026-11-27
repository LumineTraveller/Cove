import {
  createAv1SequenceHeaderRepeater,
  isAv1StartupKeyFrame,
  type Av1KeyFrameObservation,
  type Av1SequenceConfiguration,
} from './av1SequenceHeader';

export type Av1SenderWorkerOptions = { configuration?: Av1SequenceConfiguration; recovering: boolean };
export type Av1SenderWorkerMessage =
  'ready' | 'attached' | 'failed' | 'inspection-error' | 'keyframe-with-sequence'
  | { type: 'configuration'; value?: Av1SequenceConfiguration }
  | { type: 'keyframe'; value: Av1KeyFrameObservation };

// The renderer uses the DOM lib. Declare only the worker-side WebRTC members.
interface WorkerScope {
  onrtctransform: ((event: { transformer: {
    readable: ReadableStream<RTCEncodedVideoFrame>;
    writable: WritableStream<RTCEncodedVideoFrame>;
    options?: Av1SenderWorkerOptions;
    generateKeyFrame?(): Promise<unknown>;
  } }) => void) | null;
  postMessage(message: Av1SenderWorkerMessage): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onrtctransform = ({ transformer }) => {
  const repeatHeader = createAv1SequenceHeaderRepeater(transformer.options?.configuration,
    value => scope.postMessage({ type: 'configuration', value }));
  scope.postMessage('attached');
  let sentFirstKeyFrame = false;
  let requestedMissingHeader = false;
  let requestedAfterConfiguration = false;
  const forwarding = transformer.readable.pipeThrough(new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
    transform(frame, output) {
      let observation: Av1KeyFrameObservation | undefined;
      try {
        observation = repeatHeader(frame);
      } catch {
        scope.postMessage('inspection-error');
      }
      output.enqueue(frame);
      if (!observation) return;
      if (frame.type === 'key') scope.postMessage({ type: 'keyframe', value: observation });
      if (sentFirstKeyFrame) return;
      if (isAv1StartupKeyFrame(observation)) {
        sentFirstKeyFrame = true;
        scope.postMessage('keyframe-with-sequence');
      } else if (observation.action === 'missing-sequence' && !requestedMissingHeader) {
        requestedMissingHeader = true;
        void transformer.generateKeyFrame?.().catch(() => {});
      } else if (observation.action === 'configuration-only' && !requestedAfterConfiguration) {
        requestedAfterConfiguration = true;
        void transformer.generateKeyFrame?.().catch(() => {});
      }
    },
  })).pipeTo(transformer.writable);
  const ended = () => scope.postMessage('failed');
  void forwarding.then(ended, ended);
  if (transformer.options?.recovering) void transformer.generateKeyFrame?.().catch(() => {});
};
scope.postMessage('ready');
