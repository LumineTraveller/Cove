import type { MediaSourceType } from '@cove/contracts';

/** Implementations stay inside each platform; native/DOM track types never leak. */
export interface CaptureSession<TStream> {
  readonly stream: TStream;
  stop(): void | Promise<void>;
}
export interface CaptureAdapter<TStream, TOptions> {
  start(options: TOptions): Promise<CaptureSession<TStream>>;
}
export interface NoiseProcessor<TStream, TMode extends string> {
  process(stream: TStream, mode: TMode): Promise<CaptureSession<TStream>>;
}
export interface AudioRouting<TDevice> {
  list(): Promise<{ inputs: readonly TDevice[]; outputs: readonly TDevice[] }>;
  selectInput(id: string): Promise<void>;
  selectOutput(id: string): Promise<void>;
}
export interface MediaPublication {
  id: string;
  source: MediaSourceType;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  close(): void;
}
/** Used by async capture/transport jobs so teardown invalidates stale results. */
export class OperationEpoch {
  private generation = 0;
  next(): number {
    return ++this.generation;
  }
  current(): number {
    return this.generation;
  }
  matches(value: number): boolean {
    return value === this.generation;
  }
  invalidate(): void {
    this.generation += 1;
  }
}
