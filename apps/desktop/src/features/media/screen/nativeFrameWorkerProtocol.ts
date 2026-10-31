import type { NativeFrameWriteResult } from './nativeFrameWriteQueue';

/** Renderer message bound is the existing imported GPU texture pool, not extra credit. */
export const NATIVE_WORKER_MAX_PENDING = 3;
export const NATIVE_WORKER_ACK_TIMEOUT_MS = 1_500;
export const NATIVE_WORKER_STOP_TIMEOUT_MS = 250;

export type NativeFrameWorkerFailure = 'init' | 'protocol' | 'write' | 'message' | 'timeout';
export interface NativeFrameWorkerTiming {
  writeMs: number;
  queueAgeMs: number;
  idleMs: number;
}
export type NativeFrameWorkerCommand =
  | { type: 'init'; generation: string; writable: WritableStream<VideoFrame>; width: number; height: number; fps: number }
  | { type: 'frame'; generation: string; sequence: number; frame: VideoFrame }
  | { type: 'stop'; generation: string };
export type NativeFrameWorkerEvent =
  | { type: 'ready'; generation: string }
  | { type: 'ack'; generation: string; sequence: number; result: NativeFrameWriteResult; timing?: NativeFrameWorkerTiming }
  | { type: 'failed'; generation: string; reason: NativeFrameWorkerFailure }
  | { type: 'stopped'; generation: string };

export function isNativeWorkerGeneration(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 96;
}
export function isNativeWorkerSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
export function isNativeWorkerTiming(value: unknown): value is NativeFrameWorkerTiming {
  if (!value || typeof value !== 'object') return false;
  const timing = value as NativeFrameWorkerTiming;
  return [timing.writeMs, timing.queueAgeMs, timing.idleMs].every(n => Number.isFinite(n) && n >= 0);
}
export function isNativeWorkerResult(value: unknown): value is NativeFrameWriteResult {
  return value === 'written' || value === 'superseded' || value === 'expired' || value === 'stopped';
}
