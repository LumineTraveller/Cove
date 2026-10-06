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
  releasePlaybackAudio,
  onScreenAudioError,
} from './screenSharing';

function request<T>(
  socket: Socket,
  event: string,
  data?: unknown,
  timeout = 15_000,
): Promise<T> {
  if (!socket.connected) return Promise.reject(new Error('服务器连接已断开'));
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
        if (socket.connected && event === 'ms:create-transport' && late?.id)
          socket.emit('ms:close-screen-transport', { transportId: late.id });
        if (socket.connected && event === 'ms:produce' && late?.producerId)
          socket.emit('ms:close-producer', { producerId: late.producerId });
        return;
      }
      if (response && typeof response === 'object' && 'error' in response)
        reject(new Error(String(response.error)));
      else resolve(response as T);
    });
  });
}

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
  const operation = useRef(0);
  const busy = useRef(false);
  const capture = useRef<MediaStream | null>(null);
  const playback = useRef<Awaited<
    ReturnType<typeof createPlaybackAudio>
  > | null>(null);
  const transport = useRef<MsTypes.Transport | null>(null);
  const video = useRef<MsTypes.Producer | null>(null);
  const audio = useRef<MsTypes.Producer | null>(null);
  const demand = useRef(new Map<string, boolean>());
  const pendingCleanup = useRef<Promise<void>>(Promise.resolve());

  const stopScreenShare = useCallback(() => {
    ++operation.current;
    for (const producer of [video.current, audio.current]) {
      if (!producer) continue;
      if (socket.connected)
        socket.emit('ms:close-producer', { producerId: producer.id });
      producer.close();
    }
    video.current = null;
    audio.current = null;
    const outgoing = transport.current;
    transport.current = null;
    outgoing?.close();
    if (outgoing && socket.connected)
      socket.emit('ms:close-screen-transport', { transportId: outgoing.id });
    const systemAudio = playback.current;
    playback.current = null;
    if (systemAudio) {
      systemAudio.stream.release(false);
      pendingCleanup.current = releasePlaybackAudio(
        systemAudio.sessionId,
      ).catch(() => {});
    }
    const screen = capture.current;
    capture.current = null;
    screen?.release(true);
    demand.current.clear();
    setSharingScreen(false);
    setSharingAudio(false);
    setViewerCount(0);
    // Keep the start lock until an outstanding system authorization resolves.
    // Otherwise a late authorization could stop a newer capture's projection.
  }, [socket]);

  const startScreenShare = useCallback(
    async (includeAudio: boolean): Promise<boolean> => {
      if (busy.current || video.current) return false;
      if (!inVoice.current || !device.current || !canShareMobileScreen) {
        setError('请先加入语音，再共享手机屏幕');
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
      let pendingTransportId: string | undefined;
      try {
        await pendingCleanup.current;
        ensureCurrent();
        // Old servers replace the microphone transport on another send request.
        // Probe support first, never send that request to an old server.
        const capability = await request<{ dedicatedTransport: boolean }>(
          socket,
          'ms:screen-sharing-capabilities',
          {},
          4000,
        );
        if (!capability?.dedicatedTransport)
          throw new Error('服务器暂不支持手机屏幕共享，请更新服务端');
        ensureCurrent();
        // Screen sharing is AV1-only on mobile. Device.rtpCapabilities is the
        // intersection with the loaded server router, so this also fails early
        // when either side cannot negotiate AV1.
        const av1Codec = device.current!.rtpCapabilities?.codecs?.find(
          item => item.mimeType.toLowerCase() === 'video/av1',
        );
        if (!av1Codec) throw new Error('手机或服务器不支持 AV1 屏幕共享');
        const stream = await mediaDevices.getDisplayMedia({});
        if (!current()) {
          stream.release(true);
          return false;
        }
        capture.current = stream;
        const screenTrack = stream.getVideoTracks()[0];
        if (!screenTrack || screenTrack.readyState === 'ended')
          throw new Error('没有可用的屏幕画面');
        screenTrack.onended = stopScreenShare;
        if (includeAudio && !canShareScreenAudio)
          throw new Error('共享音频需要 Android 10 或更新版本');
        if (includeAudio) {
          const systemAudio = await createPlaybackAudio();
          if (!current()) {
            systemAudio.stream.release(false);
            await releasePlaybackAudio(systemAudio.sessionId);
            return false;
          }
          playback.current = systemAudio;
        }
        ensureCurrent();
        const params = await request<
          MsTypes.TransportOptions & { purpose: string }
        >(socket, 'ms:create-transport', {
          direction: 'send',
          purpose: 'screen',
        });
        pendingTransportId = params.id;
        ensureCurrent();
        if (params.purpose !== 'screen')
          throw new Error('服务器未建立独立共享通道');
        const outgoing = device.current!.createSendTransport({
          ...params,
          additionalSettings: playback.current
            ? { coveScreenAudio: playback.current.sessionId }
            : undefined,
        });
        transport.current = outgoing;
        outgoing.on('connect', ({ dtlsParameters }, resolve, reject) => {
          request(socket, 'ms:connect-transport', {
            transportId: outgoing.id,
            dtlsParameters,
          })
            .then(() => resolve())
            .catch(reject);
        });
        outgoing.on(
          'produce',
          ({ kind, rtpParameters, appData }, resolve, reject) => {
            request<{ producerId: string }>(socket, 'ms:produce', {
              transportId: outgoing.id,
              kind,
              rtpParameters,
              appData,
            })
              .then(({ producerId }) => {
                if (!current()) {
                  if (socket.connected)
                    socket.emit('ms:close-producer', { producerId });
                  reject(new Error('共享已取消'));
                  return;
                }
                resolve({ id: producerId });
              })
              .catch(reject);
          },
        );
        outgoing.on('connectionstatechange', state => {
          if (transport.current !== outgoing || state !== 'failed') return;
          setError('共享通道连接失败，语音通话仍保留');
          stopScreenShare();
        });
        // Both producers share one transport and stream ID for RTP A/V sync.
        const syncGroup = `screen-${socket.id}-${generation}`;
        const producer = await outgoing.produce({
          track: screenTrack as never,
          streamId: syncGroup,
          codec: av1Codec,
          stopTracks: false,
          zeroRtpOnPause: true,
          disableTrackOnPause: false,
          appData: { type: 'screen', client: 'android', syncGroup },
        });
        if (!current()) {
          producer.close();
          ensureCurrent();
        }
        video.current = producer;
        producer.on('trackended', stopScreenShare);
        if (!demand.current.get(producer.id)) producer.pause();
        const audioTrack = playback.current?.stream.getAudioTracks()[0];
        if (playback.current && !audioTrack)
          throw new Error('没有可用的播放音频');
        if (audioTrack) {
          const audioProducer = await outgoing.produce({
            track: audioTrack as never,
            streamId: syncGroup,
            stopTracks: false,
            zeroRtpOnPause: true,
            disableTrackOnPause: false,
            codecOptions: { opusStereo: true, opusDtx: false, opusFec: true },
            appData: { type: 'screen-audio', client: 'android', syncGroup },
          });
          if (!current()) {
            audioProducer.close();
            ensureCurrent();
          }
          audio.current = audioProducer;
          if (!demand.current.get(audioProducer.id)) audioProducer.pause();
        }
        ensureCurrent();
        setSharingScreen(true);
        setSharingAudio(!!audio.current);
        return true;
      } catch (error) {
        if (generation === operation.current) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!/NotAllowedError|共享已取消/.test(message))
            setError(`无法共享屏幕：${message}`);
          stopScreenShare();
        }
        return false;
      } finally {
        // Covers cancellation while waiting for transport allocation.
        if (
          pendingTransportId &&
          transport.current?.id !== pendingTransportId &&
          socket.connected
        ) {
          socket.emit('ms:close-screen-transport', {
            transportId: pendingTransportId,
          });
        }
        busy.current = false;
        setBusy(false);
      }
    },
    [device, inVoice, socket, stopScreenShare],
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
    const subscription = onScreenAudioError(event => {
      if (event.sessionId !== playback.current?.sessionId) return;
      setError(
        `共享音频采集失败：${event.message}。共享已停止，语音通话仍保留`,
      );
      stopScreenShare();
    });
    socket.on('screen:demand', onDemand);
    return () => {
      socket.off('screen:demand', onDemand);
      subscription.remove();
      stopScreenShare();
    };
  }, [socket, stopScreenShare]);

  return {
    sharingScreen,
    sharingScreenAudio,
    screenSharingBusy,
    screenSharingError,
    screenViewerCount,
    canShareScreenAudio,
    canShareScreen: canShareMobileScreen,
    startScreenShare,
    stopScreenShare,
    clearScreenSharingError: () => setError(null),
  };
}
