import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Socket } from 'socket.io-client';
import type { Device, types as MsTypes } from 'mediasoup-client';
import { mediaDevices, type MediaStream } from 'react-native-webrtc';
import {
  canShareMobileScreen,
  canShareScreenAudio,
  createPlaybackAudio,
  getScreenEncoderCapabilities,
  prepareScreenVideo,
  releaseScreenVideo,
  waitForScreenTransportClosed,
  onScreenAudioError,
  onScreenEncoderError,
  onScreenEncoderReady,
  type ScreenEncoderCapabilities,
  type ScreenEncodingDiagnostics,
} from './screenSharing';
import {
  normalizeScreenCaptureScale,
  type ScreenCaptureScale,
} from './screenCaptureSettings';

function request<T>(
  socket: Socket,
  event: string,
  data?: unknown,
  timeout = 15_000,
): Promise<T> {
  if (!socket.connected)
    return Promise.reject(new Error('与服务器的连接已断开'));
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(
        new Error(
          event === 'ms:screen-sharing-capabilities'
            ? '服务器暂不支持手机屏幕共享，请更新服务端'
            : `${event} 请求超时`,
        ),
      );
    }, timeout);
    socket.emit(event, data, (response: T | { error: string }) => {
      clearTimeout(timer);
      if (expired) {
        const late = response as
          | { id?: string; producerId?: string }
          | undefined;
        if (event === 'ms:create-transport' && late?.id)
          socket.emit('ms:close-screen-transport', { transportId: late.id });
        if (event === 'ms:produce' && late?.producerId)
          socket.emit('ms:close-producer', { producerId: late.producerId });
        return;
      }
      if (response && typeof response === 'object' && 'error' in response)
        reject(new Error(String(response.error)));
      else resolve(response as T);
    });
  });
}

type VideoCodec = MsTypes.RtpCodecCapability;
/** SDP support alone does not establish hardware encoding; require a native factory probe. */
export function screenCodecCandidates(
  codecs: VideoCodec[],
  capability: ScreenEncoderCapabilities | null,
) {
  const hardwareProfiles = capability?.h264HardwareProfiles ?? [];
  const h264 =
    capability?.h264Hardware === true
      ? codecs.find(codec => {
          if (codec.mimeType.toLowerCase() !== 'video/h264') return false;
          const profile = String(
            codec.parameters?.['profile-level-id'] ?? '42e01f',
          ).toLowerCase();
          return (
            /^[a-f\d]{6}$/.test(profile) &&
            hardwareProfiles.some(
              value =>
                /^[a-f\d]{6}$/i.test(value) &&
                value.slice(0, 4).toLowerCase() === profile.slice(0, 4),
            )
          );
        })
      : undefined;
  const software = ['vp8', 'av1', 'vp9'].flatMap(name => {
    if (
      capability &&
      !capability.codecs.some(value => value.toLowerCase() === name)
    )
      return [];
    const codec = codecs.find(
      item => item.mimeType.toLowerCase() === `video/${name}`,
    );
    return codec ? [codec] : [];
  });
  return {
    codecs: h264 ? [h264, ...software] : software,
    reason: !capability
      ? ('capability-unavailable' as const)
      : h264
      ? ('hardware-h264' as const)
      : capability.h264Hardware
      ? ('hardware-profile-incompatible' as const)
      : ('hardware-unavailable' as const),
  };
}
class EncoderFailure extends Error {
  constructor(
    readonly reason: 'native-create' | 'native-init' | 'native-encode',
    readonly code?: string,
  ) {
    super(`屏幕编码器失败（${reason}）`);
  }
}
function failureReason(
  error: unknown,
): ScreenEncodingDiagnostics['attempts'][number]['reason'] | undefined {
  if (error instanceof EncoderFailure) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  return /codec|encoder|encoding|unsupported|not supported|sdp|setLocalDescription|setRemoteDescription|编码|协商/i.test(
    message,
  )
    ? 'negotiation'
    : undefined;
}
type Attempt = {
  id: number;
  codec: VideoCodec;
  closed: boolean;
  transport?: MsTypes.Transport;
  transportId?: string;
  serverTransportClosed?: boolean;
  producers: MsTypes.Producer[];
  serverProducers: Set<string>;
  closedServerProducers: Set<string>;
  reject?: (error: Error) => void;
  failure?: EncoderFailure;
  shareSessionId?: string;
  replacing?: boolean;
};
type Publication = {
  sessionId: string;
  running: boolean;
  attempt?: Attempt;
  retry: () => Promise<void>;
};

export function useMobileScreenShare(
  socket: Socket,
  device: RefObject<Device | null>,
  inVoice: RefObject<boolean>,
) {
  const [sharingScreen, setSharingScreen] = useState(false);
  const [screenSharingBusy, setBusy] = useState(false);
  const [sharingScreenAudio, setSharingAudio] = useState(false);
  const [screenSharingError, setError] = useState<string | null>(null);
  const [screenViewerCount, setViewerCount] = useState(0);
  const [screenProducerId, setScreenProducerId] = useState<string | null>(null);
  const [sharedScreenSize, setSharedScreenSize] = useState<{
    width: number;
    height: number;
  }>();
  const operation = useRef(0),
    busy = useRef(false);
  const capture = useRef<MediaStream | null>(null);
  const playback = useRef<Awaited<
    ReturnType<typeof createPlaybackAudio>
  > | null>(null);
  const session = useRef<string | null>(null);
  const publication = useRef<Publication | null>(null);
  const encoding = useRef<ScreenEncodingDiagnostics | null>(null);
  const transport = useRef<MsTypes.Transport | null>(null);
  const video = useRef<MsTypes.Producer | null>(null),
    audio = useRef<MsTypes.Producer | null>(null);
  const demand = useRef(new Map<string, boolean>());
  const pendingCleanup = useRef<Promise<void>>(Promise.resolve());
  const pendingPlayback = useRef<Promise<void>>(Promise.resolve());

  const closeAttempt = useCallback(
    (attempt: Attempt | undefined, replacing?: boolean) => {
      if (!attempt) return;
      if (replacing !== undefined) attempt.replacing = replacing;
      attempt.closed = true;
      attempt.reject?.(new Error('共享已取消'));
      attempt.reject = undefined;
      for (const id of attempt.serverProducers) {
        // Socket.IO buffers these exact IDs across a recoverable disconnect.
        if (!attempt.closedServerProducers.has(id))
          socket.emit('ms:close-producer', {
            producerId: id,
            ...(attempt.replacing && attempt.shareSessionId ? { shareSessionId: attempt.shareSessionId, replacing: true } : {}),
          });
        attempt.closedServerProducers.add(id);
        demand.current.delete(id);
      }
      for (const producer of attempt.producers) {
        if (!producer.closed) producer.close();
        if (video.current === producer) {
          video.current = null;
          setScreenProducerId(null);
        }
        if (audio.current === producer) audio.current = null;
      }
      if (transport.current === attempt.transport) transport.current = null;
      if (!attempt.transport?.closed) attempt.transport?.close();
      if (attempt.transportId && !attempt.serverTransportClosed) {
        socket.emit('ms:close-screen-transport', {
          transportId: attempt.transportId,
        });
        attempt.serverTransportClosed = true;
      }
    },
    [socket],
  );

  const stopScreenShare = useCallback(() => {
    ++operation.current;
    const active = publication.current;
    publication.current = null;
    closeAttempt(active?.attempt);
    video.current = null;
    audio.current = null;
    transport.current = null;
    setScreenProducerId(null);
    setSharedScreenSize(undefined);
    const systemAudio = playback.current;
    playback.current = null;
    systemAudio?.stream.release(false);
    const activeSession = session.current;
    session.current = null;
    if (activeSession)
      pendingCleanup.current = pendingPlayback.current
        .then(() => releaseScreenVideo(activeSession))
        .catch(() => {});
    const screen = capture.current;
    capture.current = null;
    screen?.release(true);
    demand.current.clear();
    setSharingScreen(false);
    setSharingAudio(false);
    setViewerCount(0);
    // Keep the start lock until any outstanding system authorization resolves.
  }, [closeAttempt]);

  const startScreenShare = useCallback(
    async (
      includeAudio: boolean,
      resolutionScale: ScreenCaptureScale = 1,
    ): Promise<boolean> => {
      if (busy.current || video.current) return false;
      if (!inVoice.current || !device.current || !canShareMobileScreen) {
        setError('请先加入语音后再共享手机屏幕');
        return false;
      }
      busy.current = true;
      setBusy(true);
      setError(null);
      const generation = ++operation.current;
      const current = () =>
        generation === operation.current && inVoice.current && socket.connected;
      const ensureCurrent = () => {
        if (!current()) throw new Error('共享已取消');
      };
      const finishFailure = (error: unknown) => {
        if (generation !== operation.current) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!/NotAllowedError|共享已取消/.test(message))
          setError(`无法共享屏幕：${message}`);
        stopScreenShare();
      };
      try {
        await pendingCleanup.current;
        ensureCurrent();
        pendingPlayback.current = Promise.resolve();
        // Old servers replace the microphone on a second send request; probe first.
        const capability = await request<{ dedicatedTransport: boolean; publicationContinuity?: boolean }>(
          socket,
          'ms:screen-sharing-capabilities',
          {},
          4000,
        );
        if (!capability?.dedicatedTransport)
          throw new Error('服务器暂不支持手机屏幕共享，请更新服务端');
        ensureCurrent();
        const nativeCapability = await getScreenEncoderCapabilities().catch(
          () => null,
        );
        ensureCurrent();
        const candidates = screenCodecCandidates(
          device.current!.rtpCapabilities?.codecs ?? [],
          nativeCapability,
        );
        encoding.current = {
          sequence: generation,
          selectionReason: candidates.reason,
          hardwareProbe: nativeCapability?.h264Hardware ?? null,
          attempts: [],
        };
        if (!candidates.codecs.length)
          throw new Error('手机与服务器没有可用的屏幕视频编码');
        const stream = await mediaDevices.getDisplayMedia({
          android: {
            resolutionScale: normalizeScreenCaptureScale(resolutionScale),
          },
        });
        if (!current()) {
          stream.release(true);
          return false;
        }
        capture.current = stream;
        const screenTrack = stream.getVideoTracks()[0];
        if (!screenTrack || screenTrack.readyState === 'ended')
          throw new Error('没有可用的屏幕画面');
        screenTrack.onended = stopScreenShare;
        const prepared = await prepareScreenVideo();
        if (!current()) {
          await releaseScreenVideo(prepared.sessionId);
          return false;
        }
        session.current = prepared.sessionId;
        if (includeAudio && !canShareScreenAudio)
          throw new Error('共享音频需要 Android 10 或更新版本');
        if (includeAudio) {
          const creating = createPlaybackAudio(prepared.sessionId).then(
            systemAudio => {
              if (!current()) systemAudio.stream.release(false);
              else playback.current = systemAudio;
            },
          );
          // Drain a late stream before native disposal so RN can still remove its audio track.
          pendingPlayback.current = creating.catch(() => {});
          await creating;
        }
        ensureCurrent();
        const syncGroup = `screen-${socket.id}-${generation}`;
        let nextIndex = 0;
        const context: Publication = {
          sessionId: prepared.sessionId,
          running: true,
          retry: async () => {},
        };
        publication.current = context;
        const publish = async () => {
          while (nextIndex < candidates.codecs.length) {
            ensureCurrent();
            const codec = candidates.codecs[nextIndex++];
            const attempt: Attempt = {
              id: nextIndex,
              codec,
              closed: false,
              producers: [],
              serverProducers: new Set(),
              closedServerProducers: new Set(),
              shareSessionId: capability.publicationContinuity === true ? prepared.sessionId : undefined,
            };
            context.attempt = attempt;
            const active = () =>
              current() &&
              publication.current === context &&
              context.attempt === attempt &&
              !attempt.closed;
            const ensureActive = () => {
              if (!active()) throw new Error('共享已取消');
            };
            const name = codec.mimeType.slice('video/'.length).toUpperCase();
            const diagnostic: ScreenEncodingDiagnostics['attempts'][number] = {
              codec: name,
              outcome: 'selected',
            };
            encoding.current!.attempts.push(diagnostic);
            encoding.current!.selectedCodec = name;
            delete encoding.current!.ready;
            const failed = new Promise<never>((_, reject) => {
              attempt.reject = reject;
            });
            const registerProducer = (producer: MsTypes.Producer) => {
              attempt.producers.push(producer);
              attempt.serverProducers.add(producer.id);
              if (!active()) {
                closeAttempt(attempt);
                ensureActive();
              }
              return producer;
            };
            let codecPhase = true;
            const build = async () => {
              const params = await request<
                MsTypes.TransportOptions & { purpose: string }
              >(socket, 'ms:create-transport', {
                direction: 'send',
                purpose: 'screen',
              });
              attempt.transportId = params.id;
              if (!active()) {
                closeAttempt(attempt);
                ensureActive();
              }
              if (params.purpose !== 'screen')
                throw new Error('服务器未创建独立共享通道');
              const outgoing = device.current!.createSendTransport({
                ...params,
                additionalSettings: {
                  coveScreenVideo: prepared.sessionId,
                  coveScreenVideoAttempt: attempt.id,
                  ...(playback.current
                    ? { coveScreenAudio: playback.current.sessionId }
                    : {}),
                },
              });
              attempt.transport = outgoing;
              transport.current = outgoing;
              outgoing.on('connect', ({ dtlsParameters }, resolve, reject) => {
                if (!active()) {
                  reject(new Error('共享已取消'));
                  return;
                }
                request(socket, 'ms:connect-transport', {
                  transportId: outgoing.id,
                  dtlsParameters,
                })
                  .then(() => {
                    ensureActive();
                    resolve();
                  })
                  .catch(reject);
              });
              outgoing.on(
                'produce',
                ({ kind, rtpParameters, appData }, resolve, reject) => {
                  if (!active()) {
                    reject(new Error('共享已取消'));
                    return;
                  }
                  request<{ producerId: string }>(socket, 'ms:produce', {
                    transportId: outgoing.id,
                    kind,
                    rtpParameters,
                    appData,
                  })
                    .then(({ producerId }) => {
                      attempt.serverProducers.add(producerId);
                      if (!active()) {
                        closeAttempt(attempt);
                        reject(new Error('共享已取消'));
                        return;
                      }
                      resolve({ id: producerId });
                    })
                    .catch(reject);
                },
              );
              outgoing.on('connectionstatechange', state => {
                if (!active() || state !== 'failed') return;
                setError('共享通道连接失败，语音通话仍保留');
                stopScreenShare();
              });
              const producer = registerProducer(
                await outgoing.produce({
                  track: screenTrack as never,
                  streamId: syncGroup,
                  codec,
                  stopTracks: false,
                  zeroRtpOnPause: true,
                  disableTrackOnPause: false,
                  appData: { type: 'screen', client: 'android', syncGroup,
                    ...(attempt.shareSessionId ? { shareSessionId: attempt.shareSessionId, publicationAttempt: attempt.id } : {}) },
                }),
              );
              video.current = producer;
              setScreenProducerId(producer.id);
              producer.on('trackended', stopScreenShare);
              if (!demand.current.get(producer.id)) producer.pause();
              codecPhase = false;
              const audioTrack = playback.current?.stream.getAudioTracks()[0];
              if (playback.current && !audioTrack)
                throw new Error('没有可用的播放音频');
              if (audioTrack) {
                const audioProducer = registerProducer(
                  await outgoing.produce({
                    track: audioTrack as never,
                    streamId: syncGroup,
                    stopTracks: false,
                    zeroRtpOnPause: true,
                    disableTrackOnPause: false,
                    codecOptions: {
                      opusStereo: true,
                      opusDtx: false,
                      opusFec: true,
                    },
                    appData: {
                      type: 'screen-audio',
                      client: 'android',
                      syncGroup,
                      ...(attempt.shareSessionId ? { shareSessionId: attempt.shareSessionId, publicationAttempt: attempt.id } : {}),
                    },
                  }),
                );
                audio.current = audioProducer;
                if (!demand.current.get(audioProducer.id))
                  audioProducer.pause();
              }
              ensureActive();
            };
            try {
              await Promise.race([build(), failed]);
              if (attempt.failure) throw attempt.failure;
              ensureActive();
              attempt.reject = undefined;
              const dimensions = screenTrack.getSettings?.() ?? {};
              if (dimensions.width && dimensions.height)
                setSharedScreenSize({
                  width: dimensions.width,
                  height: dimensions.height,
                });
              setSharingScreen(true);
              setSharingAudio(!!audio.current);
              if (encoding.current!.selectionReason === 'fallback')
                setError(
                  `屏幕编码器未能继续使用，已切换为 ${name} 继续共享。采集分辨率与目标帧率保持不变。`,
                );
              return;
            } catch (error) {
              const reason =
                error instanceof EncoderFailure || codecPhase
                  ? failureReason(error)
                  : undefined;
              closeAttempt(attempt, !!reason && nextIndex < candidates.codecs.length);
              ensureCurrent();
              if (!reason) throw error;
              diagnostic.outcome = 'failed';
              diagnostic.reason = reason;
              if (error instanceof EncoderFailure && error.code)
                diagnostic.code = error.code;
              if (nextIndex >= candidates.codecs.length) throw error;
              encoding.current!.selectionReason = 'fallback';
              await waitForScreenTransportClosed(prepared.sessionId);
              ensureCurrent();
            }
          }
          throw new Error('没有可用的屏幕视频编码回退');
        };
        context.retry = async () => {
          if (!current() || context.running) return;
          context.running = true;
          busy.current = true;
          setBusy(true);
          try {
            do {
              const old = context.attempt,
                diagnostic =
                  encoding.current?.attempts[
                    encoding.current.attempts.length - 1
                  ];
              if (old?.failure && diagnostic) {
                diagnostic.outcome = 'failed';
                diagnostic.reason = old.failure.reason;
                diagnostic.code = old.failure.code;
              }
              closeAttempt(old, !!old?.failure && nextIndex < candidates.codecs.length);
              ensureCurrent();
              if (nextIndex >= candidates.codecs.length)
                throw old?.failure ?? new Error('没有可用的屏幕视频编码回退');
              encoding.current!.selectionReason = 'fallback';
              await waitForScreenTransportClosed(prepared.sessionId);
              ensureCurrent();
              await publish();
              // Cover an error queued between publish resolving and this continuation.
            } while (context.attempt?.failure);
          } catch (error) {
            finishFailure(error);
          } finally {
            context.running = false;
            busy.current = false;
            setBusy(false);
          }
        };
        await publish();
        context.running = false;
        if (context.attempt?.failure) {
          await context.retry();
          return current() && !!video.current;
        }
        return true;
      } catch (error) {
        finishFailure(error);
        return false;
      } finally {
        busy.current = false;
        setBusy(false);
      }
    },
    [device, inVoice, socket, stopScreenShare, closeAttempt],
  );

  useEffect(() => {
    const onDemand = ({
      producerId,
      active,
      viewerCount,
      sourceType,
    }: {
      producerId: string;
      active: boolean;
      viewerCount: number;
      sourceType: string;
    }) => {
      if (!busy.current && !video.current) return;
      demand.current.set(producerId, active);
      const producer = [video.current, audio.current].find(
        item => item?.id === producerId,
      );
      if (active) producer?.resume();
      else producer?.pause();
      if (sourceType === 'screen') setViewerCount(viewerCount);
    };
    const audioSubscription = onScreenAudioError(event => {
      if (event.sessionId !== playback.current?.sessionId) return;
      setError(
        `共享音频采集失败：${event.message}。共享已停止，语音通话仍保留`,
      );
      stopScreenShare();
    });
    const encoderSubscription = onScreenEncoderError(event => {
      const context = publication.current,
        attempt = context?.attempt;
      if (
        !context ||
        !attempt ||
        attempt.closed ||
        context.sessionId !== event.sessionId ||
        attempt.id !== event.attemptId ||
        attempt.codec.mimeType.toLowerCase() !==
          `video/${event.codec.toLowerCase()}`
      )
        return;
      attempt.failure = new EncoderFailure(`native-${event.stage}`, event.code);
      if (encoding.current) delete encoding.current.ready;
      if (context.running) attempt.reject?.(attempt.failure);
      else void context.retry();
    });
    const readySubscription = onScreenEncoderReady(event => {
      const context = publication.current,
        attempt = context?.attempt;
      if (
        !context ||
        !attempt ||
        attempt.closed ||
        context.sessionId !== event.sessionId ||
        attempt.id !== event.attemptId ||
        attempt.codec.mimeType.toLowerCase() !==
          `video/${event.codec.toLowerCase()}` ||
        !encoding.current
      )
        return;
      encoding.current.ready = {
        codec: event.codec.toUpperCase(),
        implementation: event.implementation,
        hardwareAccelerated: event.hardwareAccelerated,
        width: event.width,
        height: event.height,
        targetFps: event.targetFps,
        ...(event.encoderMaxFramerate !== undefined
          ? { encoderMaxFramerate: event.encoderMaxFramerate }
          : {}),
      };
    });
    const onReconnect = () => {
      const context = publication.current;
      if (context?.attempt?.failure && !context.running) void context.retry();
    };
    socket.on('screen:demand', onDemand);
    socket.on('connect', onReconnect);
    return () => {
      socket.off('screen:demand', onDemand);
      socket.off('connect', onReconnect);
      audioSubscription.remove();
      encoderSubscription.remove();
      readySubscription.remove();
      stopScreenShare();
    };
  }, [socket, stopScreenShare]);
  const collectScreenStats = useCallback(
    async () => transport.current?.getStats() ?? new Map(),
    [],
  );
  const collectScreenEncodingDiagnostics = useCallback(
    () =>
      encoding.current
        ? {
            ...encoding.current,
            attempts: encoding.current.attempts.map(item => ({ ...item })),
            ...(encoding.current.ready
              ? { ready: { ...encoding.current.ready } }
              : {}),
          }
        : null,
    [],
  );
  return {
    sharingScreen,
    sharingScreenAudio,
    screenSharingBusy,
    screenSharingError,
    screenViewerCount,
    screenProducerId,
    sharedScreenSize,
    collectScreenStats,
    collectScreenEncodingDiagnostics,
    canShareScreenAudio,
    canShareScreen: canShareMobileScreen,
    startScreenShare,
    stopScreenShare,
    clearScreenSharingError: () => setError(null),
  };
}
