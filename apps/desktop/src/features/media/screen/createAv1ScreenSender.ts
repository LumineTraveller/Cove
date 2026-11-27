import type { Av1SenderWorkerMessage, Av1SenderWorkerOptions } from './av1ScreenSenderWorker';
import type { Av1KeyFrameObservation, Av1SequenceConfiguration } from './av1SequenceHeader';

type SenderWorker = { worker: Worker; transform: RTCRtpScriptTransform; release(): void };
type SenderDiagnostics = {
  attachments: number;
  inspectionErrors: number;
  keyFrames: Partial<Record<Av1KeyFrameObservation['action'], {
    count: number;
    first: Av1KeyFrameObservation;
    latest: Av1KeyFrameObservation;
  }>>;
};

const av1SenderDiagnostics = new WeakMap<RTCRtpSender, SenderDiagnostics>();
const av1PublicationChecks = new WeakMap<object, () => Promise<void>>();
const ENCODER_CHECK_INTERVAL_MS = 1_000;
const AV1_STARTUP_TIMEOUT_MS = 3_500;

export class Av1ScreenInitializationError extends Error {
  constructor() { super('GPU 编码器未能生成可解码的 AV1 起始帧。请重新开始共享。'); }
}

export function checkAv1ScreenPublication(appData: object) {
  return av1PublicationChecks.get(appData)?.();
}

export function getAv1ScreenSenderDiagnostics(sender: RTCRtpSender | null | undefined) {
  return sender ? av1SenderDiagnostics.get(sender) ?? null : null;
}

export function createAv1ScreenSender(signal: AbortSignal, onFailure: (error: Error) => void) {
  const setupError = () => new Error('无法初始化 GPU 编码的 AV1 视频发送。');
  if (signal.aborted || typeof RTCRtpScriptTransform !== 'function') throw setupError();

  let active: SenderWorker | undefined;
  let sender: RTCRtpSender | undefined;
  let configuration: Av1SequenceConfiguration | undefined;
  let failure: Error | undefined;
  let disposed = false;
  let encoderCheck: ReturnType<typeof setTimeout> | undefined;
  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  const diagnostics: SenderDiagnostics = { attachments: 0, inspectionErrors: 0, keyFrames: {} };
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let keyFrameReady = false;
  let resolveKeyFrame!: () => void;
  let rejectKeyFrame!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const keyFrame = new Promise<void>((resolve, reject) => { resolveKeyFrame = resolve; rejectKeyFrame = reject; });
  // Construction or binding can fail before the caller awaits readiness.
  void ready.catch(() => {});
  void keyFrame.catch(() => {});

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(encoderCheck);
    clearTimeout(startupTimeout);
    signal.removeEventListener('abort', dispose);
    if (sender && av1SenderDiagnostics.get(sender) === diagnostics) av1SenderDiagnostics.delete(sender);
    active?.release();
    active = undefined;
    rejectReady(failure ?? setupError());
    rejectKeyFrame(failure ?? setupError());
  }

  function fail(error: Error) {
    failure = error;
    dispose();
    onFailure(error);
  }

  async function stopOnSoftwareEncoder(current: RTCRtpSender) {
    // The capability query checks whether hardware can encode the requested
    // format. Only the active sender reports a runtime WebRTC fallback.
    let report: RTCStatsReport | undefined;
    try { report = await current.getStats(); } catch { /* Retry transient stats errors. */ }
    if (disposed || current !== sender) return;
    for (const stat of report?.values() ?? []) {
      if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video' ||
          !(stat.framesEncoded > 0)) continue;
      const implementation = typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation : '';
      if (stat.powerEfficientEncoder !== false && !/\blibaom\b/i.test(implementation)) continue;
      console.warn('[screen share] AV1 hardware encoder fell back', { implementation });
      fail(new Error('GPU 编码已中断。本次共享已停止，请重新开始共享，或关闭「采用 GPU 编码」后使用 CPU。'));
      return;
    }
  }

  async function verifyEncoder() {
    if (!sender || disposed) return;
    await stopOnSoftwareEncoder(sender);
    if (!disposed) encoderCheck = setTimeout(verifyEncoder, ENCODER_CHECK_INTERVAL_MS);
  }

  function startWorker(recovering: boolean): SenderWorker {
    const worker = new Worker(new URL('./av1ScreenSenderWorker.ts', import.meta.url), {
      type: 'module', name: 'cove-av1-screen-sender',
    });
    const options: Av1SenderWorkerOptions = { configuration, recovering };
    let transform: RTCRtpScriptTransform;
    try { transform = new RTCRtpScriptTransform(worker, options); }
    catch (error) { worker.terminate(); throw error; }
    let started = false;
    const onFault = () => {
      const current = active;
      if (disposed || !current || current.worker !== worker) return;
      if (!recovering && started && sender) {
        current.release();
        active = undefined;
        try {
          active = startWorker(true);
          sender.transform = active.transform;
          return;
        } catch { /* The failed replacement is released below. */ }
      }
      fail(started || recovering ? new Error('AV1 视频发送恢复失败。请重新开始共享。') : setupError());
    };
    const onMessage = (event: MessageEvent<Av1SenderWorkerMessage>) => {
      if (disposed || active?.worker !== worker) return;
      if (event.data === 'ready') {
        started = true;
        clearTimeout(timeout);
        if (!recovering) resolveReady();
      } else if (event.data === 'failed') onFault();
      else if (event.data === 'attached') diagnostics.attachments++;
      else if (event.data === 'inspection-error') diagnostics.inspectionErrors++;
      else if (event.data === 'keyframe-with-sequence') {
        keyFrameReady = true;
        clearTimeout(startupTimeout);
        resolveKeyFrame();
      } else if (event.data?.type === 'configuration') configuration = event.data.value;
      else if (event.data?.type === 'keyframe') {
        const observation = event.data.value;
        const current = diagnostics.keyFrames[observation.action];
        if (current) {
          current.count++;
          current.latest = observation;
        } else {
          diagnostics.keyFrames[observation.action] = { count: 1, first: observation, latest: observation };
        }
      }
    };
    const timeout = setTimeout(onFault, 5_000);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onFault);
    worker.addEventListener('messageerror', onFault);
    return {
      worker, transform,
      release() {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onFault);
        worker.removeEventListener('messageerror', onFault);
        worker.terminate();
      },
    };
  }

  try { active = startWorker(false); }
  catch { dispose(); throw setupError(); }
  signal.addEventListener('abort', dispose, { once: true });

  const requireActive = () => {
    if (!active) throw failure ?? setupError();
    return active;
  };
  return {
    ready, dispose,
    bind(value: RTCRtpSender, appData: object) {
      const current = requireActive();
      sender = value;
      sender.transform = current.transform;
      av1SenderDiagnostics.set(sender, diagnostics);
      av1PublicationChecks.set(appData, async () => {
        requireActive();
        if (!keyFrameReady) {
          startupTimeout ??= setTimeout(() => rejectKeyFrame(new Av1ScreenInitializationError()), AV1_STARTUP_TIMEOUT_MS);
        }
        await keyFrame;
        await stopOnSoftwareEncoder(value);
        requireActive();
      });
      clearTimeout(encoderCheck);
      encoderCheck = setTimeout(verifyEncoder, ENCODER_CHECK_INTERVAL_MS);
    },
    assertHealthy() { requireActive(); },
  };
}
