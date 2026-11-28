/** Native helper wire data. No credentials, content bytes or arbitrary handles from renderers. */
export type NativeScreenColorSpace = 'bt601-limited' | 'bt709-limited';
export type NativeScreenRegion = readonly [x: number, y: number, width: number, height: number];

export interface NativeScreenOptions {
  maxWidth: number;
  maxHeight: number;
  fps: 30 | 60 | 120;
  /** Required by CPU NV12 delivery; chosen from the video codec. */
  colorSpace?: NativeScreenColorSpace;
  /** Require a CPU-backed NV12 frame source for the selected AV1 encoder. */
  cpuNv12?: true;
  /** Require the output to match the physical source dimensions. */
  nativeResolution?: boolean;
  /** Use the base transfer path after a failure in texture reuse or CPU delivery. */
  conservativeDelivery?: true;
  /** Rearm desktop duplication if an active game's new foreground stops updating. */
  gameMode?: true;
}

export interface NativeScreenDisplay {
  authorizationId: string;
  width: number;
  height: number;
}

export interface NativeScreenFrame {
  requestId: string;
  sessionId: string;
  slot: number;
  serial: number;
  width: number;
  height: number;
  timestamp: number;
  refresh: boolean;
  /** Omitted by protocol-2 BGRA peers. Protocol 3 declares NV12 explicitly. */
  pixelFormat?: 'bgra' | 'nv12';
  /** Protocol 4 carries independent CPU bytes rather than a shared GPU import. */
  storage?: 'cpu';
  /** CPU NV12 sessions carry their immutable conversion contract on every frame. */
  colorSpace?: NativeScreenColorSpace;
  /** Aligned subset of the CPU frame changed since the previous helper serial. */
  update?: NativeScreenRegion;
}

export type NativeScreenStartResult =
  | { ok: true; sessionId: string; width: number; height: number; pixelFormat?: 'bgra' | 'nv12'; storage?: 'cpu'; colorSpace?: NativeScreenColorSpace; preferredContentHint?: 'detail' }
  | { ok: false; reason: string };

export interface NativeScreenSourceSelection {
  sourceId: string;
  displayId: string;
  primaryDisplayId: string;
  displayCount: number;
  selectedAt: number;
  /** Physical pixels observed by main when the stock display source was chosen. */
  sourceWidth?: number;
  sourceHeight?: number;
}

export const NATIVE_SCREEN_POOL_SIZE = 3;
export const NATIVE_SCREEN_MAX_WIDTH = 4096;
export const NATIVE_SCREEN_MAX_HEIGHT = 2560;
export const NATIVE_SCREEN_START_TIMEOUT_MS = 1_500;
export const NATIVE_SCREEN_GPU_ENCODING_START_TIMEOUT_MS = 3_000;
export const NATIVE_SCREEN_DIRECT_HELPER_TIMEOUT_MS = 5_000;
export const NATIVE_SCREEN_DIRECT_TRACK_TIMEOUT_MS = 7_000;
export const NATIVE_SCREEN_STOP_TIMEOUT_MS = 1_500;

/** Fixed helper codes safe to retain in startup and recovery diagnostics. */
export const NATIVE_SCREEN_HELPER_FAILURES = [
  'display_changed', 'display_query_failed', 'unsupported_display_topology', 'unsupported_display_color',
  'unsupported_display_connection',
  'unsupported_display_geometry', 'unsupported_output_api', 'duplication_busy', 'gpu_device_lost',
  'invalid_arguments', 'owner_is_not_parent', 'owner_unavailable', 'dpi_context_unavailable',
  'factory_failed', 'hardware_device_failed', 'duplication_failed', 'unsupported_duplication_geometry',
  'desktop_acquire_failed', 'slot_release_timeout', 'shared_mutex_unavailable',
] as const;

export function validNativeScreenRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

export function validNativeScreenOptions(value: unknown): value is NativeScreenOptions {
  if (!value || typeof value !== 'object') return false;
  const options = value as NativeScreenOptions;
  return Number.isInteger(options.maxWidth) && Number.isInteger(options.maxHeight) &&
    options.maxWidth >= 2 && options.maxWidth <= NATIVE_SCREEN_MAX_WIDTH &&
    options.maxHeight >= 2 && options.maxHeight <= NATIVE_SCREEN_MAX_HEIGHT &&
    [30, 60, 120].includes(options.fps) &&
    (options.cpuNv12 === undefined || (options.cpuNv12 === true && options.colorSpace !== undefined)) &&
    (options.nativeResolution === undefined || typeof options.nativeResolution === 'boolean') &&
    (options.conservativeDelivery === undefined || options.conservativeDelivery === true) &&
    (options.gameMode === undefined || options.gameMode === true) &&
    (options.colorSpace === undefined || options.colorSpace === 'bt601-limited' || options.colorSpace === 'bt709-limited');
}
