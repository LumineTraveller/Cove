import {
  NATIVE_SCREEN_MAX_HEIGHT, NATIVE_SCREEN_MAX_WIDTH,
  type NativeScreenColorSpace, type NativeScreenDisplay,
} from '../../../../electron/native-screen-capture-protocol';
import {
  nativeScreenContentHint, tryNativeScreenCapture,
  type NativeCaptureCandidate, type NativeScreenBridge, type NativeScreenCaptureAttempt,
} from './nativeScreenCapture';
import {
  createScreenEncodingPlan, SCREEN_PRESETS, SCREEN_START_BITRATE_BPS,
  type ScreenEncodingPlan, type ScreenFps, type ScreenPreset,
} from './screenCapture';

export interface NativeScreenSettings {
  preset: ScreenPreset;
  fps: ScreenFps;
  gameMode: boolean;
  nativeResolution: boolean;
  gpuEncoding: boolean;
}

export interface NativeScreenDisplayLease {
  display: NativeScreenDisplay;
  release(): void;
}

export async function selectNativeScreenDisplay(bridge: NativeScreenBridge): Promise<NativeScreenDisplayLease> {
  const display = await bridge.selectDisplay?.();
  if (!display) throw new Error('Windows 主屏幕暂不可用。请确认桌面已经解锁。');
  let released = false;
  return {
    display,
    release() {
      if (released) return;
      released = true;
      try { void bridge.releaseDisplay?.(display.authorizationId).catch(() => {}); }
      catch { /* Window teardown can already have released the display grant. */ }
    },
  };
}

const retryDelaysMs = [0, 250, 850, 1_800];
const terminalFailureReasons = new Set([
  'authorization_expired', 'untrusted_sender', 'target_unavailable', 'invalid_request',
  'native_resolution_unavailable', 'unsupported_display_color', 'unsupported_display_geometry',
  'unsupported_display_connection', 'unsupported_output_api', 'invalid_arguments', 'owner_is_not_parent',
]);
const transientRecoveryReasons = new Set([
  'desktop_unavailable', 'display_changed', 'busy', 'duplication_busy', 'gpu_device_lost',
  'start_timeout', 'capture_stalled', 'helper_failed', 'import_failed', 'transfer_failed',
  'release_failed', 'renderer_failed', 'receiver_failed', 'cpu_frame_failed', 'cpu_ack_timeout',
]);

function waitForNativeRetry(delayMs: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted || delayMs === 0) { resolve(); return; }
    const finished = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finished);
      resolve();
    };
    const timer = setTimeout(finished, delayMs);
    signal.addEventListener('abort', finished, { once: true });
  });
}

function nativeScreenError(reason?: string): Error {
  switch (reason) {
    case 'native_resolution_unavailable':
      return new Error('原生采集无法保持当前显示器的完整分辨率。请选择分辨率档位。');
    case 'unsupported_display_color':
      return new Error('当前显示器的色彩模式不受原生采集支持。请切换到标准动态范围（SDR）后重试。');
    case 'display_query_failed':
      return new Error('无法读取当前显示器的状态。请重新开始屏幕共享。');
    case 'unsupported_display_geometry':
      return new Error('当前显示器的方向无法用于原生采集。');
    case 'desktop_unavailable':
      return new Error('Windows 桌面暂不可用。请解锁或关闭系统提示后重试。');
    case 'display_changed':
      return new Error('本次共享选中的主屏幕已变更。请确认想共享的显示器后重新开始。');
    case 'duplication_busy':
      return new Error('Windows 桌面复制暂被其他采集占用。请关闭其他共享或录屏后重试。');
    case 'helper_unavailable':
    case 'invalid_arguments':
    case 'owner_is_not_parent':
      return new Error('无法启动 Cove 原生采集组件。请检查客户端安装。');
    default:
      return new Error('原生屏幕采集未能恢复，请重新开始共享。');
  }
}

function stoppedAttemptReason(attempt?: Readonly<NativeScreenCaptureAttempt>): string | undefined {
  const reported = attempt?.backendEndReason ?? attempt?.startFailureReason;
  if (reported) return reported;
  if (attempt?.stopReason === 'deadline_timeout') return 'start_timeout';
  if (attempt?.stopReason === 'frame_error') return 'renderer_failed';
  if (attempt?.stopReason === 'start_error') return 'helper_failed';
  return undefined;
}

type NativeScreenPreparation = { capture: NativeCaptureCandidate; plan: ScreenEncodingPlan };

/** Retry only the display authorized for this publication, using independent native transports. */
export async function prepareNativeScreen(
  lease: NativeScreenDisplayLease,
  settings: NativeScreenSettings,
  colorSpace: NativeScreenColorSpace | undefined,
  signal: AbortSignal,
  isCurrent: () => boolean,
  recovering = false,
  acquire: typeof tryNativeScreenCapture = tryNativeScreenCapture,
): Promise<NativeScreenPreparation | null> {
  const { preset, fps, gameMode, nativeResolution, gpuEncoding } = settings;
  const bounds = nativeResolution ? { width: NATIVE_SCREEN_MAX_WIDTH, height: NATIVE_SCREEN_MAX_HEIGHT } : SCREEN_PRESETS[preset];
  const mode = gameMode ? 'motion' : 'active';
  const current = () => !signal.aborted && isCurrent();
  let reason: string | undefined;
  for (let index = 0; index < retryDelaysMs.length ||
      (recovering && reason !== undefined && transientRecoveryReasons.has(reason)); ++index) {
    const delay = retryDelaysMs[index] ?? Math.min(8_000, 4_000 + (index - retryDelaysMs.length) * 1_000);
    await waitForNativeRetry(delay, signal);
    if (!current()) return null;
    const failure: { attempt?: Readonly<NativeScreenCaptureAttempt> } = {};
    const conservativeDelivery = recovering || index > 0;
    const cpuNv12 = gpuEncoding || (index % 3 === 2 && colorSpace !== undefined);
    const capture = await acquire(lease.display, {
      maxWidth: bounds.width, maxHeight: bounds.height, fps, nativeResolution,
      colorSpace: gpuEncoding ? 'bt709-limited' : colorSpace,
      ...(gameMode ? { gameMode: true } : {}),
      ...(cpuNv12 ? { cpuNv12: true } : {}),
      ...(conservativeDelivery ? { conservativeDelivery: true, useGenerator: true } : {}),
      contentHint: gameMode ? 'motion' : 'detail',
      isCurrent: current, signal,
      onAttemptStopped: attempt => { failure.attempt = attempt; },
    });
    if (!current()) { capture?.stop(); return null; }
    if (capture) {
      try {
        const track = capture.stream.getVideoTracks()[0];
        const { width, height } = track.getSettings();
        if (track.readyState === 'live' && width && height) {
          if (gpuEncoding) {
            const capability = await navigator.mediaCapabilities?.encodingInfo({
              type: 'webrtc',
              video: { contentType: 'video/AV1', width, height, framerate: fps,
                bitrate: SCREEN_START_BITRATE_BPS, scalabilityMode: 'L1T1' },
            }).catch(() => null);
            if (!current()) { capture.stop(); return null; }
            if (!capability?.supported || !capability.powerEfficient)
              throw new Error('显卡无法按当前分辨率和帧率编码 AV1。请关闭 GPU 编码或调整共享设置。');
          }
          if (track.readyState === 'live') {
            const plan = createScreenEncodingPlan({
              preset, maxFps: fps, activity: mode, sourceWidth: width, sourceHeight: height, nativeResolution, gpuEncoding,
            });
            track.contentHint = nativeScreenContentHint(track, plan.contentHint);
            return { capture, plan };
          }
        }
      } catch (error) { capture.stop(); throw error; }
      capture.stop();
    }
    reason = stoppedAttemptReason(failure.attempt);
    if (reason && terminalFailureReasons.has(reason)) break;
  }
  throw nativeScreenError(reason);
}
