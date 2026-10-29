/** Fixed codes only: helper text, identifiers, paths and user content stay out of diagnostics. */
const FAILURE_REASONS = [
  'invalid_request', 'unsupported_pixel_format', 'color_space_required', 'unavailable',
  'duplicate_request', 'busy', 'target_unavailable', 'source_ineligible', 'untrusted_sender',
  'helper_unavailable', 'helper_failed', 'invalid_protocol', 'start_timeout', 'import_failed',
  'transfer_failed', 'release_failed', 'capture_stalled', 'stopped', 'renderer_failed',
  'receiver_failed', 'cpu_frame_failed', 'cpu_ack_timeout',
] as const;

export type NativeScreenFailureReason = typeof FAILURE_REASONS[number] | 'unknown_failure';

export function nativeScreenFailureReason(value: unknown): NativeScreenFailureReason {
  return typeof value === 'string' && FAILURE_REASONS.includes(value as typeof FAILURE_REASONS[number])
    ? value as NativeScreenFailureReason : 'unknown_failure';
}

interface StartResult { ok: boolean; reason?: unknown }
interface ControllerSummary {
  disabled: boolean;
  failureCode: unknown;
  started: number;
  stopped: number;
  activeSessions: number;
  frames: number;
  transferredFrames: number;
}

/** Once per start response, never per frame; no source/session/request identifiers. */
export function nativeScreenStartDiagnostic(result: StartResult, summary: ControllerSummary) {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    status: result.ok ? 'ready' : 'rejected',
    reason: result.ok ? null : nativeScreenFailureReason(result.reason),
    disabledAfterFailure: summary.disabled === true,
    controllerFailureReason: summary.failureCode === null ? null : nativeScreenFailureReason(summary.failureCode),
    started: count(summary.started),
    stopped: count(summary.stopped),
    activeSessions: count(summary.activeSessions),
    frames: count(summary.frames),
    transferredFrames: count(summary.transferredFrames),
  } as const;
}
