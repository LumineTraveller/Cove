import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Device, types as MsTypes } from 'mediasoup-client';

type Transport       = MsTypes.Transport;
type Producer        = MsTypes.Producer;
type Consumer        = MsTypes.Consumer;
type RtpCapabilities = MsTypes.RtpCapabilities;
import { VoiceMember } from '../types';

// 每档自带码率上限（maxBitrate），适配窄带宽隧道。
// 之前固定 5Mbps 会撑爆 SakuraFrp 限速隧道，导致延迟堆到数秒、帧率掉到个位数。
export const SCREEN_PRESETS = {
  '540p':  { label: '540p 流畅',  width: 960,  height: 540,  bitrate30:   600_000, bitrate60: 1_000_000 },
  '720p':  { label: '720p 均衡',  width: 1280, height: 720,  bitrate30: 1_100_000, bitrate60: 1_800_000 },
  '1080p': { label: '1080p 清晰', width: 1920, height: 1080, bitrate30: 2_000_000, bitrate60: 3_200_000 },
} as const;
export type ScreenPreset = keyof typeof SCREEN_PRESETS;
export type Fps = 30 | 60;
export type ScreenContentMode = 'detail' | 'motion';

export interface MediaStats {
  rtt: number | null;
  fps: number | null;
  loss: number | null;
  bitrate: number | null;
  availableBitrate: number | null;
  jitter: number | null;
  width: number | null;
  height: number | null;
  droppedFrames: number | null;
  qualityLimitation: string | null;
  protocol: string | null;
}

const EMPTY_STATS: MediaStats = {
  rtt: null, fps: null, loss: null, bitrate: null, availableBitrate: null,
  jitter: null, width: null, height: null, droppedFrames: null,
  qualityLimitation: null, protocol: null,
};

function screenBitrate(preset: ScreenPreset, fps: Fps): number {
  const profile = SCREEN_PRESETS[preset];
  return fps === 60 ? profile.bitrate60 : profile.bitrate30;
}

// ── 工具：把 socket.emit 包装成 Promise ────────────────────────────────────────
function emitAsync<T = void>(socket: Socket, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 超时`)), 15_000);
    socket.emit(event, data, (res: T | { error: string }) => {
      clearTimeout(timer);
      if (res && typeof res === 'object' && 'error' in (res as object))
        reject(new Error((res as { error: string }).error));
      else
        resolve(res as T);
    });
  });
}

interface RemoteScreen { socketId: string; stream: MediaStream }

export function useWebRTC(socket: Socket, roomId: string) {
  const [inVoice,      setInVoice]      = useState(false);
  const [isMuted,      setIsMuted]      = useState(false);
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [isSharing,    setIsSharing]    = useState(false);
  const [screenPreset, setScreenPreset] = useState<ScreenPreset>('720p');
  const [fps,          setFps]          = useState<Fps>(30);
  const [screenMode,   setScreenMode]   = useState<ScreenContentMode>('detail');
  const [shareAudio,   setShareAudio]   = useState(false);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [localScreen,  setLocalScreen]  = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);

  // 实时统计（帧率 / 延迟 / 丢包），开关控制是否采集
  const [statsEnabled, setStatsEnabled] = useState(false);
  const [stats, setStats] = useState<MediaStats>(EMPTY_STATS);
  // 每个人说话音量 0~1（key = socketId）
  const [speakingLevels, setSpeakingLevels] = useState<Record<string, number>>({});

  // mediasoup-client 实例
  const deviceRef       = useRef<Device | null>(null);
  const sendTransport   = useRef<Transport | null>(null);
  const recvTransport   = useRef<Transport | null>(null);
  const audioProducer   = useRef<Producer | null>(null);
  const screenProducer  = useRef<Producer | null>(null);
  const screenAudioProducer = useRef<Producer | null>(null); // 共享屏幕时的系统音频
  const selfMutedRef    = useRef(false);
  const forceMutedRef   = useRef(false);
  // consumerId → { consumer, socketId, kind }
  const consumers       = useRef<Map<string, { consumer: Consumer; socketId: string; kind: string; producerId: string }>>(new Map());
  // 同一个 producer 只允许创建一个 consumer；同时记录进行中的请求以避免信令竞态。
  const consumerByProducer = useRef<Map<string, string>>(new Map());
  const pendingProducers    = useRef<Set<string>>(new Set());
  // 音频播放元素，按 consumerId 存储（一个人可能同时有麦克风+系统音频两路）
  const audioEls        = useRef<Map<string, HTMLAudioElement>>(new Map());
  const screenStreams    = useRef<Map<string, MediaStream>>(new Map());
  const localAudioRef   = useRef<MediaStream | null>(null);
  const localScreenRef  = useRef<MediaStream | null>(null);

  // 音量分析（Web Audio）
  const audioCtxRef     = useRef<AudioContext | null>(null);
  // key = consumerId 或 'local'；value = { analyser, data, socketId }
  const analysers       = useRef<Map<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer>; socketId: string }>>(new Map());
  const volumeTimer     = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsEnabledRef = useRef(false);
  const lossPrev        = useRef<{ lost: number; recv: number } | null>(null);
  const videoBytesPrev  = useRef<{ bytes: number; timestamp: number } | null>(null);

  // ── 音量分析工具 ──────────────────────────────────────────────────────────────
  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  };

  const attachAnalyser = (key: string, stream: MediaStream, socketId: string) => {
    try {
      const ctx = ensureAudioCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser); // 不连到 destination，避免重复播放
      analysers.current.set(key, { analyser, data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)), socketId });
    } catch { /* ignore */ }
  };

  const detachAnalyser = (key: string) => { analysers.current.delete(key); };

  // 音量计：每 100ms 计算每路音频的 RMS，聚合到 socketId → 0~1
  const startMeters = useCallback(() => {
    if (volumeTimer.current) return;
    volumeTimer.current = setInterval(() => {
      if (analysers.current.size === 0) { setSpeakingLevels({}); return; }
      const levels: Record<string, number> = {};
      analysers.current.forEach(({ analyser, data, socketId }) => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(1, rms * 3); // 放大便于观察
        levels[socketId] = Math.max(levels[socketId] ?? 0, level);
      });
      setSpeakingLevels(levels);
    }, 100);
  }, []);

  const stopMeters = useCallback(() => {
    if (volumeTimer.current) { clearInterval(volumeTimer.current); volumeTimer.current = null; }
    setSpeakingLevels({});
  }, []);

  // 采集帧率 / 延迟 / 丢包（仅在开关打开时调用）
  type AnyStat = Record<string, unknown>;
  const collectStats = useCallback(async () => {
    const next: MediaStats = { ...EMPTY_STATS };

    try {
      const st = sendTransport.current;
      if (st) {
        const report = await st.getStats();
        report.forEach((s: AnyStat) => {
          if (s.type !== 'candidate-pair' || s.currentRoundTripTime == null) return;
          if (s.state && s.state !== 'succeeded') return;
          next.rtt = Math.round((s.currentRoundTripTime as number) * 1000);
          if (s.availableOutgoingBitrate != null)
            next.availableBitrate = Math.round((s.availableOutgoingBitrate as number) / 1000);
          const candidate = report.get(s.localCandidateId as string) as AnyStat | undefined;
          if (candidate?.protocol) next.protocol = String(candidate.protocol).toUpperCase();
        });
      }
    } catch { /* ignore */ }

    try {
      let framesSrc: RTCStatsReport | null = null;
      if (screenProducer.current) framesSrc = await screenProducer.current.getStats();
      else {
        for (const { consumer, kind } of consumers.current.values()) {
          if (kind === 'video') { framesSrc = await consumer.getStats(); break; }
        }
      }
      framesSrc?.forEach((s: AnyStat) => {
        if (s.type !== 'outbound-rtp' && s.type !== 'inbound-rtp') return;
        if (s.kind && s.kind !== 'video' && s.mediaType !== 'video') return;
        if (s.framesPerSecond != null) next.fps = Math.round(s.framesPerSecond as number);
        if (s.frameWidth != null) next.width = Number(s.frameWidth);
        if (s.frameHeight != null) next.height = Number(s.frameHeight);
        if (s.framesDropped != null) next.droppedFrames = Number(s.framesDropped);
        if (s.qualityLimitationReason) next.qualityLimitation = String(s.qualityLimitationReason);

        const bytes = Number(s.bytesSent ?? s.bytesReceived ?? 0);
        const timestamp = Number(s.timestamp ?? 0);
        const prev = videoBytesPrev.current;
        if (bytes > 0 && timestamp > 0 && prev && bytes >= prev.bytes && timestamp > prev.timestamp) {
          next.bitrate = Math.round(((bytes - prev.bytes) * 8) / (timestamp - prev.timestamp));
        }
        if (bytes > 0 && timestamp > 0) videoBytesPrev.current = { bytes, timestamp };
      });
    } catch { /* ignore */ }

    try {
      let lost = 0, recv = 0, maxJitter = 0;
      for (const { consumer } of consumers.current.values()) {
        const report = await consumer.getStats();
        report.forEach((s: AnyStat) => {
          if (s.type === 'inbound-rtp') {
            lost += (s.packetsLost as number) ?? 0;
            recv += (s.packetsReceived as number) ?? 0;
            if (s.jitter != null) maxJitter = Math.max(maxJitter, Number(s.jitter));
          }
        });
      }
      if (maxJitter > 0) next.jitter = Math.round(maxJitter * 1000);
      if (lossPrev.current) {
        const dLost = lost - lossPrev.current.lost;
        const dRecv = recv - lossPrev.current.recv;
        const total = dLost + dRecv;
        next.loss = total > 0 ? Math.max(0, Math.round((dLost / total) * 1000) / 10) : 0;
      }
      lossPrev.current = { lost, recv };
    } catch { /* ignore */ }

    setStats(next);
  }, []);

  // stats 开关：打开时每秒采集一次
  const toggleStats = useCallback(() => {
    setStatsEnabled(prev => {
      const next = !prev;
      statsEnabledRef.current = next;
      if (next) {
        if (!statsTimer.current) statsTimer.current = setInterval(() => { collectStats(); }, 1000);
      } else {
        if (statsTimer.current) { clearInterval(statsTimer.current); statsTimer.current = null; }
        lossPrev.current = null;
        videoBytesPrev.current = null;
        setStats(EMPTY_STATS);
      }
      return next;
    });
  }, [collectStats]);

  // 卸载时清理所有定时器和音频上下文
  useEffect(() => () => {
    if (volumeTimer.current) clearInterval(volumeTimer.current);
    if (statsTimer.current) clearInterval(statsTimer.current);
    audioCtxRef.current?.close().catch(() => {});
  }, []);

  // ── 初始化 mediasoup Device + 两条 transport ────────────────────────────────

  const setupDevice = useCallback(async (): Promise<boolean> => {
    if (deviceRef.current) return true;
    try {
      const caps = await emitAsync<RtpCapabilities>(socket, 'ms:capabilities');
      const device = new Device();
      await device.load({ routerRtpCapabilities: caps });
      deviceRef.current = device;

      // ── 发送 transport ───────────────────────────────────────────────────
      const sendParams = await emitAsync<Record<string, unknown>>(socket, 'ms:create-transport', { direction: 'send' });
      const st = device.createSendTransport(sendParams as never);

      st.on('connect', ({ dtlsParameters }, ok, err) => {
        emitAsync(socket, 'ms:connect-transport', { transportId: st.id, dtlsParameters })
          .then(ok).catch(err);
      });

      st.on('produce', ({ kind, rtpParameters, appData }, ok, err) => {
        emitAsync<{ producerId: string }>(socket, 'ms:produce', {
          transportId: st.id, kind, rtpParameters, appData,
        }).then(({ producerId }) => ok({ id: producerId })).catch(err);
      });

      st.on('connectionstatechange', (state) => {
        console.log(`%c[ms-client] 发送通道(send): ${state}`, 'color:#3b82f6;font-weight:bold');
        if (state === 'connected')    console.log('%c[ms-client] [OK] 发送通道已连通，麦克风/屏幕可以上行', 'color:#22c55e');
        if (state === 'failed')       console.error('[ms-client] [ERROR] 发送通道连接失败 - 连接层问题，检查 frp 端口/公网IP 配置');
        if (state === 'disconnected') console.warn('[ms-client] [WARN] 发送通道断开（网络抖动？）');
      });

      sendTransport.current = st;

      // ── 接收 transport ───────────────────────────────────────────────────
      const recvParams = await emitAsync<Record<string, unknown>>(socket, 'ms:create-transport', { direction: 'recv' });
      const rt = device.createRecvTransport(recvParams as never);

      rt.on('connect', ({ dtlsParameters }, ok, err) => {
        emitAsync(socket, 'ms:connect-transport', { transportId: rt.id, dtlsParameters })
          .then(ok).catch(err);
      });

      rt.on('connectionstatechange', (state) => {
        console.log(`%c[ms-client] 接收通道(recv): ${state}`, 'color:#a855f7;font-weight:bold');
        if (state === 'connected')    console.log('%c[ms-client] [OK] 接收通道已连通，可以收到别人的音视频', 'color:#22c55e');
        if (state === 'failed')       console.error('[ms-client] [ERROR] 接收通道连接失败 - 连接层问题，检查 frp 端口/公网IP 配置');
        if (state === 'disconnected') console.warn('[ms-client] [WARN] 接收通道断开（网络抖动？）');
      });

      recvTransport.current = rt;
      return true;
    } catch (e) {
      console.error('[mediasoup] 初始化失败:', e);
      return false;
    }
  }, [socket]);

  // ── 消费一个 producer（接收对方音频/视频）──────────────────────────────────

  const consumeProducer = useCallback(async (
    producerId: string,
    peerId: string,
    kind: string,
    appData: Record<string, unknown>,
  ) => {
    const device = deviceRef.current;
    const rt     = recvTransport.current;
    if (!device || !rt) return;
    if (consumerByProducer.current.has(producerId) || pendingProducers.current.has(producerId)) return;
    pendingProducers.current.add(producerId);

    try {
      const params = await emitAsync<Record<string, unknown>>(socket, 'ms:consume', {
        producerId, rtpCapabilities: device.rtpCapabilities,
      });

      const consumer = await rt.consume(params as never);
      consumers.current.set(consumer.id, { consumer, socketId: peerId, kind, producerId });
      consumerByProducer.current.set(producerId, consumer.id);
      console.log(`%c[ms-client] 开始接收 ${kind} 流，来自 ${peerId}`, 'color:#06b6d4');

      // 给 FRP UDP 的轻微抖动留出约 80ms 缓冲。0 会过度追求延迟，容易产生爆音。
      if (kind === 'audio') {
        try {
          const receiver = consumer.rtpReceiver as (RTCRtpReceiver & { playoutDelayHint?: number }) | undefined;
          if (receiver && 'playoutDelayHint' in receiver) receiver.playoutDelayHint = 0.08;
        } catch { /* ignore */ }
      }

      // 恢复（服务端 produce 后 paused=true，必须 resume）
      await emitAsync(socket, 'ms:resume-consumer', { consumerId: consumer.id });

      const stream = new MediaStream([consumer.track]);

      if (kind === 'audio') {
        // 按 consumerId 存音频元素，麦克风和系统音频两路并存不互相覆盖
        const el = new Audio();
        el.autoplay = true;
        el.srcObject = stream;
        audioEls.current.set(consumer.id, el);
        el.play().catch(() => {
          const resume = () => { el.play(); document.removeEventListener('click', resume); };
          document.addEventListener('click', resume);
        });
        // 只对麦克风音频做音量分析（系统音频不计入"说话"）
        if (appData?.type !== 'screen-audio') {
          attachAnalyser(consumer.id, stream, peerId);
          startMeters();
        }
      } else if (kind === 'video') {
        // appData.type === 'screen'
        screenStreams.current.set(peerId, stream);
        setRemoteScreen({ socketId: peerId, stream });
      }

      consumer.on('trackended', () => {
        if (kind === 'video')
          setRemoteScreen(p => p?.socketId === peerId ? null : p);
      });
    } catch (e) {
      console.error('[mediasoup] consume 失败:', e);
    } finally {
      pendingProducers.current.delete(producerId);
    }
  }, [socket]);

  // ── Socket 事件 ────────────────────────────────────────────────────────────

  useEffect(() => {
    const onVoiceMembers = (list: VoiceMember[]) => setVoiceMembers(list);

    // 服务端通知：有新的 producer（有人加入语音或开始共享）
    const onNewProducer = async ({
      producerId, peerId, kind, appData,
    }: { producerId: string; peerId: string; kind: string; appData: Record<string, unknown> }) => {
      if (!inVoice) return; // 自己不在语音就不消费
      await consumeProducer(producerId, peerId, kind, appData);
    };

    // 服务端通知：某个 consumer 对应的 producer 已关闭
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) => {
      const entry = consumers.current.get(consumerId);
      if (!entry) return;
      const { socketId, kind, producerId } = entry;
      consumers.current.delete(consumerId);
      consumerByProducer.current.delete(producerId);
      entry.consumer.close();
      // 清理这一路的音频元素和音量分析（key 都是 consumerId）
      const el = audioEls.current.get(consumerId);
      if (el) { el.pause(); el.srcObject = null; audioEls.current.delete(consumerId); }
      detachAnalyser(consumerId);
      if (kind === 'video') {
        screenStreams.current.delete(socketId);
        setRemoteScreen(p => p?.socketId === socketId ? null : p);
      }
    };

    const onUserLeft = ({ socketId }: { socketId: string }) => {
      // 清理该用户所有相关的 consumer / 音频元素 / 音量分析
      for (const [cid, entry] of consumers.current) {
        if (entry.socketId !== socketId) continue;
        const el = audioEls.current.get(cid);
        if (el) { el.pause(); el.srcObject = null; audioEls.current.delete(cid); }
        detachAnalyser(cid);
        entry.consumer.close();
        consumerByProducer.current.delete(entry.producerId);
        consumers.current.delete(cid);
      }
      screenStreams.current.delete(socketId);
      setRemoteScreen(p => p?.socketId === socketId ? null : p);
    };

    socket.on('voice:members-updated', onVoiceMembers);
    socket.on('ms:new-producer',       onNewProducer);
    socket.on('ms:consumer-closed',    onConsumerClosed);
    socket.on('voice:user-left',       onUserLeft);

    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('ms:new-producer',       onNewProducer);
      socket.off('ms:consumer-closed',    onConsumerClosed);
      socket.off('voice:user-left',       onUserLeft);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, inVoice, consumeProducer]);

  // 房主禁言与成员自己静音是两层独立状态。解除房主禁言时，只在成员原本没有
  // 自己静音的情况下恢复麦克风，避免意外打开用户主动关闭的音频。
  useEffect(() => {
    const onForcedMute = ({ roomId: targetRoomId, muted }: { roomId: string; muted: boolean }) => {
      if (targetRoomId !== roomId) return;
      forceMutedRef.current = muted;
      setIsForceMuted(muted);
      if (muted) {
        audioProducer.current?.pause();
        screenAudioProducer.current?.pause();
      } else {
        if (!selfMutedRef.current) audioProducer.current?.resume();
        screenAudioProducer.current?.resume();
      }
      setIsMuted(muted || selfMutedRef.current);
    };
    socket.on('room:force-muted', onForcedMute);
    return () => { socket.off('room:force-muted', onForcedMute); };
  }, [socket, roomId]);

  // ── 加入语音 ───────────────────────────────────────────────────────────────

  const joinVoice = useCallback(async () => {
    if (inVoice) return;
    console.log('%c[joinVoice] 开始加入语音…', 'color:#3b82f6;font-weight:bold');
    try {
      console.log('[joinVoice] 请求麦克风权限 getUserMedia…');
      // 超时保护：Electron 权限挂起时 getUserMedia 会永不返回，加 10s 超时把问题暴露出来
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 48_000,
          },
        }),
        new Promise<MediaStream>((_, rej) =>
          setTimeout(() => rej(new Error('getUserMedia 超时（10s）——很可能是麦克风权限被系统/应用挡住')), 10_000)),
      ]);
      console.log('%c[joinVoice] [OK] 已获取麦克风', 'color:#22c55e');
      localAudioRef.current = stream;

      console.log('[joinVoice] 初始化 mediasoup Device 和传输通道…');
      const ok = await setupDevice();
      if (!ok) { stream.getTracks().forEach(t => t.stop()); return; }
      console.log('%c[joinVoice] [OK] Device 就绪，开始发布音频', 'color:#22c55e');

      // 发布音频（标记 type:mic 以区分系统音频）
      const producer = await sendTransport.current!.produce({
        track:   stream.getAudioTracks()[0],
        codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
        encodings: [{ maxBitrate: 32_000 }],
        appData: { type: 'mic' },
      });
      audioProducer.current = producer;
      if (forceMutedRef.current) producer.pause();
      producer.on('trackended', () => { /* 麦克风被拔 */ });

      // 本地麦克风音量分析（显示在自己名字旁）
      attachAnalyser('local', stream, socket.id ?? 'local');
      startMeters();

      setInVoice(true);
      socket.emit('voice:join', roomId);

      // 消费已经在频道里的人的 producer
      const existing = await emitAsync<
        { producerId: string; peerId: string; kind: string; appData: Record<string, unknown> }[]
      >(socket, 'ms:get-producers');

      for (const { producerId, peerId, kind, appData } of existing) {
        await consumeProducer(producerId, peerId, kind, appData);
      }
      console.log('%c[joinVoice] [OK] 加入语音完成', 'color:#22c55e;font-weight:bold');
    } catch (e) {
      console.error('[joinVoice] [ERROR] 失败:', e);
      alert(`加入语音失败：\n${e instanceof Error ? e.message : String(e)}\n\n请检查麦克风权限（Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问）。`);
    }
  }, [socket, roomId, inVoice, setupDevice, consumeProducer]);

  // ── 离开语音 ───────────────────────────────────────────────────────────────

  const leaveVoice = useCallback(() => {
    audioProducer.current?.close();       audioProducer.current       = null;
    screenProducer.current?.close();      screenProducer.current      = null;
    screenAudioProducer.current?.close(); screenAudioProducer.current = null;
    sendTransport.current?.close();       sendTransport.current       = null;
    recvTransport.current?.close();       recvTransport.current       = null;
    deviceRef.current = null;

    localAudioRef.current?.getTracks().forEach(t => t.stop());
    localAudioRef.current = null;
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    localScreenRef.current = null;
    setLocalScreen(null);

    consumers.current.forEach(({ consumer }) => consumer.close());
    consumers.current.clear();
    consumerByProducer.current.clear();
    pendingProducers.current.clear();

    audioEls.current.forEach(el => { el.pause(); el.srcObject = null; });
    audioEls.current.clear();
    screenStreams.current.clear();

    // 停止音量计和统计
    stopMeters();
    analysers.current.clear();
    lossPrev.current = null;
    videoBytesPrev.current = null;
    setStats(EMPTY_STATS);

    setRemoteScreen(null);
    setInVoice(false);
    selfMutedRef.current = false;
    setIsMuted(forceMutedRef.current);
    setIsSharing(false);
    socket.emit('voice:leave', roomId);
  }, [socket, roomId, stopMeters]);

  // ── 麦克风静音 ─────────────────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const producer = audioProducer.current;
    if (!producer || forceMutedRef.current) return;
    selfMutedRef.current = !selfMutedRef.current;
    if (selfMutedRef.current) producer.pause();
    else producer.resume();
    setIsMuted(selfMutedRef.current);
  }, []);

  // ── 屏幕共享 ───────────────────────────────────────────────────────────────

  const applyScreenEncoding = useCallback((preset: ScreenPreset, targetFps: Fps, mode: ScreenContentMode) => {
    const producer = screenProducer.current;
    if (!producer) return;
    try {
      const params = producer.rtpSender?.getParameters();
      if (!params) return;
      if (params.encodings?.[0]) params.encodings[0].maxBitrate = screenBitrate(preset, targetFps);
      params.degradationPreference = mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      producer.rtpSender?.setParameters(params).catch(() => {});
    } catch { /* ignore */ }
  }, []);

  const startScreenShare = useCallback(async (
    initPreset?: ScreenPreset, initFps?: Fps, initAudio?: boolean, initMode?: ScreenContentMode,
  ) => {
    if (!inVoice || isSharing) return;
    const preset     = initPreset  ?? screenPreset;
    const currentFps = initFps     ?? fps;
    const audio      = initAudio   ?? shareAudio;
    const mode       = initMode    ?? screenMode;
    if (initPreset  !== undefined) setScreenPreset(initPreset);
    if (initFps     !== undefined) setFps(initFps);
    if (initAudio   !== undefined) setShareAudio(initAudio);
    if (initMode    !== undefined) setScreenMode(initMode);

    const { width, height } = SCREEN_PRESETS[preset];
    const maxBitrate = screenBitrate(preset, currentFps);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: currentFps } },
        audio,
      });
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.contentHint = mode === 'detail' ? 'detail' : 'motion';
      await videoTrack.applyConstraints({
        width: { max: width },
        height: { max: height },
        frameRate: { max: currentFps },
      }).catch(() => {});
      console.log('[screen share] 实际采集参数:', videoTrack.getSettings());
      localScreenRef.current = stream;
      setLocalScreen(stream);
      videoBytesPrev.current = null;

      const producer = await sendTransport.current!.produce({
        track:   videoTrack,
        appData: { type: 'screen', mode, preset, fps: currentFps },
        // 按所选档位限制码率，避免撑爆窄带宽隧道（startBitrate 取上限的一半，缓启动）
        encodings: [{ maxBitrate }],
        codecOptions: { videoGoogleStartBitrate: Math.round(maxBitrate / 2000) },
      });
      screenProducer.current = producer;
      applyScreenEncoding(preset, currentFps, mode);

      // 系统音频：getDisplayMedia 勾选了"共享音频"时会带 audio track，单独 produce
      const sysAudioTrack = stream.getAudioTracks()[0];
      if (audio && sysAudioTrack) {
        try {
          const ap = await sendTransport.current!.produce({
            track: sysAudioTrack,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
            encodings: [{ maxBitrate: 96_000 }],
            appData: { type: 'screen-audio' },
          });
          screenAudioProducer.current = ap;
          if (forceMutedRef.current) ap.pause();
        } catch (e) {
          console.warn('[screen share] 系统音频发布失败:', e);
        }
      }

      setIsSharing(true);

      // 用户在浏览器 UI 点"停止共享"
      stream.getVideoTracks()[0].onended = () => stopScreenShare();
    } catch (e) {
      console.error('[screen share]', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId, inVoice, isSharing, screenPreset, fps, shareAudio, screenMode, applyScreenEncoding]);

  const stopScreenShare = useCallback(() => {
    if (screenProducer.current) {
      socket.emit('ms:close-producer', { producerId: screenProducer.current.id });
      screenProducer.current.close();
      screenProducer.current = null;
    }
    if (screenAudioProducer.current) {
      socket.emit('ms:close-producer', { producerId: screenAudioProducer.current.id });
      screenAudioProducer.current.close();
      screenAudioProducer.current = null;
    }
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    localScreenRef.current = null;
    setLocalScreen(null);
    setIsSharing(false);
    videoBytesPrev.current = null;
  }, [socket]);

  // 画质/帧率调整：同时更新分辨率约束 + 编码码率上限
  const changeScreenPreset = useCallback((preset: ScreenPreset) => {
    setScreenPreset(preset);
    const { width, height } = SCREEN_PRESETS[preset];
    localScreenRef.current?.getVideoTracks()[0]
      ?.applyConstraints({ width: { max: width }, height: { max: height } }).catch(() => {});
    applyScreenEncoding(preset, fps, screenMode);
  }, [fps, screenMode, applyScreenEncoding]);

  const changeFps = useCallback((newFps: Fps) => {
    setFps(newFps);
    localScreenRef.current?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { max: newFps } }).catch(() => {});
    applyScreenEncoding(screenPreset, newFps, screenMode);
  }, [screenPreset, screenMode, applyScreenEncoding]);

  const changeScreenMode = useCallback((mode: ScreenContentMode) => {
    setScreenMode(mode);
    const track = localScreenRef.current?.getVideoTracks()[0];
    if (track) track.contentHint = mode === 'detail' ? 'detail' : 'motion';
    applyScreenEncoding(screenPreset, fps, mode);
  }, [screenPreset, fps, applyScreenEncoding]);

  const toggleShareAudio = useCallback(() => setShareAudio(p => !p), []);

  return {
    inVoice, isMuted, isForceMuted, isSharing,
    screenPreset, fps, screenMode, shareAudio,
    voiceMembers,
    localScreen,
    remoteScreen,        // { socketId, stream: MediaStream } | null
    joinVoice, leaveVoice, toggleMute,
    startScreenShare, stopScreenShare,
    changeScreenPreset, changeFps, changeScreenMode, toggleShareAudio,
    // 新增：实时统计 + 音量
    stats, statsEnabled, toggleStats,
    speakingLevels,      // socketId → 0~1
    localSocketId: socket.id,
  };
}
