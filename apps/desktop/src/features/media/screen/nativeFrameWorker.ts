import { createNativeFrameWorkerRuntime } from './nativeFrameWorkerRuntime';
import type { NativeFrameWorkerEvent } from './nativeFrameWorkerProtocol';

// Keep this entry compatible with the application's DOM lib; importing WebWorker
// globals as a second TypeScript lib would conflict with the Window declarations.
interface WorkerScope {
  VideoFrame?: typeof VideoFrame;
  performance: { now(): number };
  postMessage(value: NativeFrameWorkerEvent): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
const runtime = createNativeFrameWorkerRuntime<VideoFrame>({
  now: () => scope.performance.now(),
  isFrame: (value): value is VideoFrame => typeof scope.VideoFrame === 'function' && value instanceof scope.VideoFrame,
  post: event => scope.postMessage(event),
});
scope.onmessage = event => runtime.handleMessage(event.data);
scope.onmessageerror = () => runtime.handleMessageError();
