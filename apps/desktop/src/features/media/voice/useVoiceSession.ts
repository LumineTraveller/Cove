import { useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { DisconnectGrace } from '../../connection/disconnectGrace';
import { createVoiceConnectionRecovery } from './voiceConnectionRecovery';

import { syncMicrophoneMute } from '../microphone/microphoneProcessing';
import { type MicrophoneNoiseMode } from '../microphone/microphoneCandidate';

import { VoiceMember } from '../../../types';

import { type RtcVideoCounterSample } from '../diagnostics/mediaDiagnostics';
import { type ScreenEncodingPlan } from '../screen/screenCapture';
import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import {
  Transport,
  Producer,
  Consumer,
  MediaStats,
  EMPTY_STATS,
  emitAsync,
  RemoteScreen,
  AvailableScreen,
  RemoteApplicationAudio,
} from '../desktopMediaSupport';

export interface useVoiceSessionDependencies {
  readonly voiceSessionActiveRef: import('react').MutableRefObject<boolean>;
  readonly joiningRef: import('react').MutableRefObject<boolean>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly mediaGeneration: import('react').MutableRefObject<number>;
  readonly voiceSocketId: import('react').MutableRefObject<string | undefined>;
  readonly setIsJoining: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly setAudioDeviceError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly prepareMicrophone: (
    deviceId: string,
    mode: MicrophoneNoiseMode,
  ) => Promise<import('../microphone/microphoneCandidate').MicrophoneCandidate>;
  readonly selectedAudioInputRef: import('react').MutableRefObject<string>;
  readonly microphoneNoiseModeRef: import('react').MutableRefObject<MicrophoneNoiseMode>;
  readonly setMicrophoneNoiseMode: import('react').Dispatch<
    import('react').SetStateAction<MicrophoneNoiseMode>
  >;
  readonly setMicrophoneNoiseError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly rawAudioRef: import('react').MutableRefObject<MediaStream | null>;
  readonly micProcessingContext: import('react').MutableRefObject<AudioContext | null>;
  readonly micProcessingGain: import('react').MutableRefObject<GainNode | null>;
  readonly localAudioRef: import('react').MutableRefObject<MediaStream | null>;
  readonly refreshAudioDevices: (requestPermission?: boolean) => Promise<void>;
  readonly setupDevice: () => Promise<boolean>;
  readonly selfMutedRef: import('react').MutableRefObject<boolean>;
  readonly forceMutedRef: import('react').MutableRefObject<boolean>;
  readonly microphoneVolumeRef: import('react').MutableRefObject<number>;
  readonly roomId: string;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly audioProducer: import('react').MutableRefObject<Producer | null>;
  readonly attachAnalyser: (
    key: string,
    stream: MediaStream,
    socketId: string,
    type?: 'voice' | 'application',
    playbackGain?: () => number,
  ) => void;
  readonly startMeters: () => void;
  readonly setInVoice: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly pendingScreenAudioByPeer: import('react').MutableRefObject<Map<string, string>>;
  readonly storeAvailableScreen: (value: AvailableScreen) => void;
  readonly consumeProducer: (
    producerId: string,
    peerId: string,
    kind: string,
    appData: Record<string, unknown>,
  ) => Promise<boolean>;
  readonly storeRemoteApplicationAudio: (value: RemoteApplicationAudio) => void;
  readonly resetVoiceRef: import('react').MutableRefObject<
    (notifyServer?: boolean, reason?: string) => void
  >;
  readonly recvTransport: import('react').MutableRefObject<Transport | null>;
  readonly connectionGrace: import('react').MutableRefObject<DisconnectGrace>;
  readonly playPresenceTone: (action: 'join' | 'leave') => void;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly screenAudioProducer: import('react').MutableRefObject<Producer | null>;
  readonly applicationAudioProducer: import('react').MutableRefObject<Producer | null>;
  readonly deviceRef: import('react').MutableRefObject<Device | null>;
  readonly screenAudioUnsubscribe: import('react').MutableRefObject<(() => void) | null>;
  readonly screenAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly applicationAudioUnsubscribe: import('react').MutableRefObject<(() => void) | null>;
  readonly applicationAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly applicationAudioStop: import('react').MutableRefObject<(() => Promise<boolean>) | null>;
  readonly setIsApplicationAudioSharing: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setApplicationAudioLabel: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly localScreenRef: import('react').MutableRefObject<MediaStream | null>;
  readonly setLocalScreen: import('react').Dispatch<
    import('react').SetStateAction<MediaStream | null>
  >;
  readonly screenAnalysisTimer: import('react').MutableRefObject<number | null>;
  readonly screenRampTimer: import('react').MutableRefObject<number | null>;
  readonly screenRampGuardUntil: import('react').MutableRefObject<number>;
  readonly screenAnalysisVideo: import('react').MutableRefObject<HTMLVideoElement | null>;
  readonly screenAnalysisCanvas: import('react').MutableRefObject<HTMLCanvasElement | null>;
  readonly previousScreenSample: import('react').MutableRefObject<Uint8ClampedArray<ArrayBufferLike> | null>;
  readonly consumers: import('react').MutableRefObject<
    Map<
      string,
      {
        consumer: Consumer;
        socketId: string;
        kind: string;
        producerId: string;
        sourceType?: string;
      }
    >
  >;
  readonly consumerByProducer: import('react').MutableRefObject<Map<string, string>>;
  readonly pendingProducers: import('react').MutableRefObject<Set<string>>;
  readonly audioEls: import('react').MutableRefObject<Map<string, HTMLAudioElement>>;
  readonly remoteAudioOutputs: import('react').MutableRefObject<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        gain: GainNode;
        setVolume(value: number): void;
        resume(): Promise<void>;
        close(): void;
      }
    >
  >;
  readonly screenStreams: import('react').MutableRefObject<Map<string, MediaStream>>;
  readonly stopMeters: () => void;
  readonly clearAnalysers: () => void;
  readonly receiveLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly remoteLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly videoCounterPrev: import('react').MutableRefObject<RtcVideoCounterSample | null>;
  readonly setStats: import('react').Dispatch<import('react').SetStateAction<MediaStats>>;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly clearAvailableScreens: () => void;
  readonly clearRemoteApplicationAudios: () => void;
  readonly watchingScreenPeerRef: import('react').MutableRefObject<string | null>;
  readonly setWatchingScreenPeer: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly screenDemandActiveRef: import('react').MutableRefObject<boolean>;
  readonly setScreenViewerCount: import('react').Dispatch<import('react').SetStateAction<number>>;
  readonly setScreenEncodingPlan: import('react').Dispatch<
    import('react').SetStateAction<ScreenEncodingPlan | null>
  >;
  readonly voiceMembersRef: import('react').MutableRefObject<VoiceMember[]>;
  readonly setVoiceMembers: import('react').Dispatch<import('react').SetStateAction<VoiceMember[]>>;
  readonly setIsMuted: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly setIsSharing: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly microphoneNoiseBusyRef: import('react').MutableRefObject<boolean>;
  readonly setAudioInputSwitching: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly replaceMicrophone: (deviceId: string, mode?: MicrophoneNoiseMode) => Promise<void>;
  readonly selectAudioOutput: (deviceId: string) => Promise<void>;
  readonly selectedAudioOutputRef: import('react').MutableRefObject<string>;
}

export function useVoiceSession(deps: useVoiceSessionDependencies) {
  // ── 加入语音 ───────────────────────────────────────────────────────────────

  const joinVoice = useCallback(async () => {
    if (deps.voiceSessionActiveRef.current || deps.joiningRef.current || !deps.socket.connected)
      return;
    const generation = ++deps.mediaGeneration.current;
    const ensureCurrent = () => {
      if (generation !== deps.mediaGeneration.current) throw new Error('语音加入已取消');
    };
    deps.voiceSocketId.current = deps.socket.id;
    deps.joiningRef.current = true;
    deps.setIsJoining(true);
    deps.setAudioDeviceError(null);
    console.log('%c[joinVoice] 开始加入语音…', 'color:#3b82f6;font-weight:bold');
    let rawStream: MediaStream | null = null;
    let stream: MediaStream | null = null;
    try {
      console.log('[joinVoice] 请求麦克风权限 getUserMedia…');
      // 超时保护：Electron 权限挂起时 getUserMedia 会永不返回，加 10s 超时把问题暴露出来
      const candidate = await deps.prepareMicrophone(
        deps.selectedAudioInputRef.current,
        deps.microphoneNoiseModeRef.current,
      );
      rawStream = candidate.raw;
      const processed = candidate.processed;
      stream = processed.stream;
      if (generation !== deps.mediaGeneration.current)
        void processed.context?.close().catch(() => {});
      ensureCurrent();
      deps.microphoneNoiseModeRef.current = candidate.mode;
      deps.setMicrophoneNoiseMode(candidate.mode);
      deps.setMicrophoneNoiseError(candidate.warning);
      console.log('%c[joinVoice] [OK] 已获取麦克风', 'color:#22c55e');
      const rawTrack = rawStream.getAudioTracks()[0];
      if (rawTrack) {
        rawTrack.contentHint = 'speech';
        const settings = rawTrack.getSettings();
        console.info('[mic] 实际采集处理', {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          channelCount: settings.channelCount,
          sampleRate: settings.sampleRate,
        });
      }
      deps.rawAudioRef.current = rawStream;
      deps.micProcessingContext.current = processed.context;
      deps.micProcessingGain.current = processed.gain;
      deps.localAudioRef.current = stream;
      deps.refreshAudioDevices(false);

      console.log('[joinVoice] 初始化 mediasoup Device 和传输通道…');
      const ok = await deps.setupDevice();
      ensureCurrent();
      if (!ok) {
        throw new Error('媒体通道初始化失败，请重试加入语音');
      }
      console.log('%c[joinVoice] [OK] Device 就绪，开始发布音频', 'color:#22c55e');

      // candidate 已完成安全回退。系统音量处理不可用时 stream 本身就是
      // 系统降噪采集流；RNNoise 输出中途结束时不能改发未处理的 rawTrack。
      const processedTrack = stream?.getAudioTracks()[0];
      const microphoneTrack = processedTrack;
      if (!microphoneTrack || microphoneTrack.readyState !== 'live') {
        throw new Error('麦克风音轨未就绪，请检查输入设备');
      }
      // Honor mute before the first packet, including the raw-track fallback.
      microphoneTrack.enabled =
        !deps.selfMutedRef.current &&
        !deps.forceMutedRef.current &&
        deps.microphoneVolumeRef.current > 0;
      console.info('[mic] 上行轨道', {
        processed: microphoneTrack !== rawTrack,
        label: microphoneTrack.label,
        readyState: microphoneTrack.readyState,
      });

      // 先登记为语音成员，再发布麦克风。
      // 服务端只会把新 Producer 广播给当前已在 voiceRooms 中的成员；
      // 如果先 produce、后 voice:join，其他成员就永远收不到这一路麦克风。
      // 新服务端会返回 ACK，但已部署的旧服务端只处理事件、不调用回调。
      // Socket.IO 会保持同一连接上的事件顺序，因此先发送 voice:join 再
      // produce 即可消除广播竞态，同时不能等待 ACK，否则旧服务端会在
      // 15 秒后被误判为加入失败并触发整套语音清理。
      deps.socket.emit('voice:join', deps.roomId);

      // 发布音频（标记 type:mic 以区分系统音频）
      const producer = await deps.sendTransport.current!.produce({
        track: microphoneTrack,
        streamId: `mic-${deps.socket.id}`,
        codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
        appData: { type: 'mic' },
      });
      if (generation !== deps.mediaGeneration.current) {
        producer.close();
        ensureCurrent();
      }
      deps.audioProducer.current = producer;
      syncMicrophoneMute(
        producer,
        deps.selfMutedRef.current,
        deps.forceMutedRef.current,
        deps.microphoneVolumeRef.current,
      );

      // 输出一组可直接从启动终端读取的上行统计，后续无需再猜测音轨
      // 是否真正进入 WebRTC sender。
      setTimeout(async () => {
        if (deps.audioProducer.current !== producer || producer.closed) return;
        try {
          const report = await producer.getStats();
          const outbound = [...report.values()]
            .filter((stat) => stat.type === 'outbound-rtp')
            .map((stat) => ({
              kind: stat.kind ?? stat.mediaType,
              bytesSent: stat.bytesSent ?? null,
              packetsSent: stat.packetsSent ?? null,
              totalAudioEnergy: stat.totalAudioEnergy ?? null,
            }));
          const sources = [...report.values()]
            .filter((stat) => stat.type === 'media-source')
            .map((stat) => ({
              audioLevel: stat.audioLevel ?? null,
              totalAudioEnergy: stat.totalAudioEnergy ?? null,
              totalSamplesDuration: stat.totalSamplesDuration ?? null,
            }));
          console.info(
            `[mic-uplink] ${JSON.stringify({
              paused: producer.paused,
              trackLabel: microphoneTrack.label,
              trackSettings: microphoneTrack.getSettings(),
              trackEnabled: microphoneTrack.enabled,
              trackState: microphoneTrack.readyState,
              outbound,
              sources,
            })}`,
          );
        } catch (error) {
          console.warn('[mic-uplink] 无法读取发送统计', error);
        }
      }, 3_000);
      producer.on('trackended', () => {
        /* 麦克风被拔 */
      });

      // 本地麦克风音量分析（显示在自己名字旁）
      deps.attachAnalyser('local', stream, deps.socket.id ?? 'local');
      deps.startMeters();

      deps.voiceSessionActiveRef.current = true;
      deps.setInVoice(true);

      // 消费已经在频道里的人的 producer
      const existing = await emitAsync<
        {
          producerId: string;
          peerId: string;
          kind: string;
          appData: Record<string, unknown>;
        }[]
      >(deps.socket, 'ms:get-producers');
      ensureCurrent();

      for (const source of existing) {
        if (source.appData?.type === 'screen-audio')
          deps.pendingScreenAudioByPeer.current.set(source.peerId, source.producerId);
      }
      for (const { producerId, peerId, kind, appData } of existing) {
        ensureCurrent();
        if (appData?.type === 'screen') {
          deps.storeAvailableScreen({
            socketId: peerId,
            videoProducerId: producerId,
            audioProducerId: deps.pendingScreenAudioByPeer.current.get(peerId),
          });
          continue;
        }
        if (appData?.type === 'screen-audio') continue;
        if (appData?.type === 'application-audio') {
          const consumed = await deps.consumeProducer(producerId, peerId, kind, appData);
          if (consumed) {
            deps.storeRemoteApplicationAudio({
              socketId: peerId,
              producerId,
              label:
                typeof appData.label === 'string' && appData.label.trim() ? appData.label : '应用',
            });
          }
          continue;
        }
        await deps.consumeProducer(producerId, peerId, kind, appData);
      }
      console.log('%c[joinVoice] [OK] 加入语音完成', 'color:#22c55e;font-weight:bold');
    } catch (e) {
      stream?.getTracks().forEach((track) => track.stop());
      if (rawStream !== stream) rawStream?.getTracks().forEach((track) => track.stop());
      if (generation !== deps.mediaGeneration.current) return;
      deps.resetVoiceRef.current(true, 'join-failed');
      if (deps.localAudioRef.current === stream) deps.localAudioRef.current = null;
      deps.rawAudioRef.current = null;
      deps.micProcessingContext.current?.close().catch(() => {});
      deps.micProcessingContext.current = null;
      deps.micProcessingGain.current = null;
      console.error('[joinVoice] [ERROR] 失败:', e);
      deps.setAudioDeviceError(
        `加入语音失败：${e instanceof Error ? e.message : String(e)}，可直接重试。`,
      );
    } finally {
      if (generation === deps.mediaGeneration.current) {
        deps.joiningRef.current = false;
        deps.setIsJoining(false);
      }
    }
  }, [
    deps.socket,
    deps.roomId,
    deps.setupDevice,
    deps.consumeProducer,
    deps.storeAvailableScreen,
    deps.storeRemoteApplicationAudio,
    deps.prepareMicrophone,
    deps.refreshAudioDevices,
  ]);

  // ── 离开语音 ───────────────────────────────────────────────────────────────

  const resetVoice = useCallback(
    (notifyServer = true, reason = 'leave-voice') => {
      if (deps.voiceSessionActiveRef.current || deps.joiningRef.current) {
        console.warn(
          `[voice-recovery] ${JSON.stringify({
            at: new Date().toISOString(),
            event: 'voice-reset',
            reason,
            roomId: deps.roomId,
            socketId: deps.socket.id ?? null,
            voiceSocketId: deps.voiceSocketId.current ?? null,
            connected: deps.socket.connected,
            recovered: deps.socket.recovered,
            active: deps.voiceSessionActiveRef.current,
            joining: deps.joiningRef.current,
            sendState: deps.sendTransport.current?.connectionState ?? null,
            recvState: deps.recvTransport.current?.connectionState ?? null,
          })}`,
        );
      }
      deps.mediaGeneration.current += 1;
      deps.connectionGrace.current.clear();
      const shouldPlayLeaveTone = deps.voiceSessionActiveRef.current;
      deps.voiceSessionActiveRef.current = false;
      if (shouldPlayLeaveTone) deps.playPresenceTone('leave');
      deps.joiningRef.current = false;
      deps.setIsJoining(false);
      deps.audioProducer.current?.close();
      deps.audioProducer.current = null;
      deps.screenProducer.current?.close();
      deps.screenProducer.current = null;
      deps.screenAudioProducer.current?.close();
      deps.screenAudioProducer.current = null;
      deps.applicationAudioProducer.current?.close();
      deps.applicationAudioProducer.current = null;
      deps.sendTransport.current?.close();
      deps.sendTransport.current = null;
      deps.recvTransport.current?.close();
      deps.recvTransport.current = null;
      deps.deviceRef.current = null;

      deps.localAudioRef.current?.getTracks().forEach((t) => t.stop());
      deps.localAudioRef.current = null;
      deps.rawAudioRef.current?.getTracks().forEach((t) => t.stop());
      deps.rawAudioRef.current = null;
      deps.micProcessingContext.current?.close().catch(() => {});
      deps.micProcessingContext.current = null;
      deps.micProcessingGain.current = null;
      deps.screenAudioUnsubscribe.current?.();
      deps.screenAudioUnsubscribe.current = null;
      deps.screenAudioPipeline.current?.close();
      deps.screenAudioPipeline.current = null;
      void window.coveScreenAudio?.stop();
      deps.applicationAudioUnsubscribe.current?.();
      deps.applicationAudioUnsubscribe.current = null;
      deps.applicationAudioPipeline.current?.close();
      deps.applicationAudioPipeline.current = null;
      void deps.applicationAudioStop.current?.();
      deps.applicationAudioStop.current = null;
      void window.coveApplicationAudio?.stop();
      void window.coveSystemAudio?.stop();
      deps.setIsApplicationAudioSharing(false);
      deps.setApplicationAudioLabel(null);
      deps.localScreenRef.current?.getTracks().forEach((t) => t.stop());
      deps.localScreenRef.current = null;
      deps.setLocalScreen(null);
      if (deps.screenAnalysisTimer.current) clearInterval(deps.screenAnalysisTimer.current);
      deps.screenAnalysisTimer.current = null;
      if (deps.screenRampTimer.current) clearTimeout(deps.screenRampTimer.current);
      deps.screenRampTimer.current = null;
      deps.screenRampGuardUntil.current = 0;
      if (deps.screenAnalysisVideo.current) deps.screenAnalysisVideo.current.srcObject = null;
      deps.screenAnalysisVideo.current = null;
      deps.screenAnalysisCanvas.current = null;
      deps.previousScreenSample.current = null;

      deps.consumers.current.forEach(({ consumer }) => consumer.close());
      deps.consumers.current.clear();
      deps.consumerByProducer.current.clear();
      deps.pendingProducers.current.clear();

      deps.audioEls.current.forEach((el) => {
        el.pause();
        el.srcObject = null;
      });
      deps.audioEls.current.clear();
      deps.remoteAudioOutputs.current.forEach((output) => output.close());
      deps.remoteAudioOutputs.current.clear();
      deps.screenStreams.current.clear();

      // 停止音量计和统计
      deps.stopMeters();
      deps.clearAnalysers();
      deps.receiveLossPrev.current = null;
      deps.remoteLossPrev.current = null;
      deps.videoCounterPrev.current = null;
      deps.setStats(EMPTY_STATS);

      deps.setRemoteScreen(null);
      deps.clearAvailableScreens();
      deps.clearRemoteApplicationAudios();
      deps.pendingScreenAudioByPeer.current.clear();
      deps.watchingScreenPeerRef.current = null;
      deps.setWatchingScreenPeer(null);
      deps.screenDemandActiveRef.current = false;
      deps.setScreenViewerCount(0);
      deps.setScreenEncodingPlan(null);
      deps.setInVoice(false);
      deps.voiceMembersRef.current = [];
      deps.setVoiceMembers([]);
      deps.selfMutedRef.current = false;
      deps.setIsMuted(deps.forceMutedRef.current);
      deps.setIsSharing(false);
      if (notifyServer && deps.socket.connected) deps.socket.emit('voice:leave', deps.roomId);
    },
    [deps.socket, deps.roomId, deps.stopMeters, deps.clearAvailableScreens, deps.playPresenceTone],
  );
  deps.resetVoiceRef.current = resetVoice;
  const leaveVoice = useCallback(() => resetVoice(), [resetVoice]);
  const refreshAudioConnection = useCallback(async () => {
    if (deps.microphoneNoiseBusyRef.current) return;
    if (!deps.socket.connected) {
      deps.setAudioDeviceError('当前服务器连接已断开，暂时无法刷新语音连接。');
      return;
    }

    deps.setAudioDeviceError(null);
    // 只重建当前麦克风采集链路，不销毁语音传输和屏幕共享，避免刷新设备
    // 时意外结束正在进行的共享或让观看方重新点击观看。
    if (deps.voiceSessionActiveRef.current && deps.audioProducer.current) {
      deps.setAudioInputSwitching(true);
      try {
        await deps.replaceMicrophone(deps.selectedAudioInputRef.current);
      } catch (error) {
        deps.setAudioDeviceError(
          `刷新麦克风失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        deps.setAudioInputSwitching(false);
      }
    }

    // 重新给当前所有播放节点应用输出端点，等效于重连扬声器播放链路。
    await deps.selectAudioOutput(deps.selectedAudioOutputRef.current);
  }, [deps.replaceMicrophone, deps.selectAudioOutput, deps.socket]);

  useEffect(() => {
    const readState = () => ({
      socketId: deps.socket.id,
      voiceSocketId: deps.voiceSocketId.current,
      connected: deps.socket.connected,
      recovered: deps.socket.recovered,
      active: deps.voiceSessionActiveRef.current,
      joining: deps.joiningRef.current,
      sendState: deps.sendTransport.current?.connectionState ?? null,
      recvState: deps.recvTransport.current?.connectionState ?? null,
    });
    const recovery = createVoiceConnectionRecovery({
      grace: deps.connectionGrace.current,
      readState,
      resetVoice: (reason) => deps.resetVoiceRef.current(false, reason),
      leaveRecoveredVoice: () => deps.socket.emit('voice:leave', deps.roomId),
      onError: deps.setAudioDeviceError,
      onEvent: (event, reason) =>
        console.info(
          `[voice-recovery] ${JSON.stringify({
            at: new Date().toISOString(),
            event,
            reason,
            roomId: deps.roomId,
            ...readState(),
          })}`,
        ),
    });
    deps.socket.on('disconnect', recovery.onDisconnect);
    deps.socket.on('connect', recovery.onConnect);
    return () => {
      deps.socket.off('disconnect', recovery.onDisconnect);
      deps.socket.off('connect', recovery.onConnect);
      recovery.dispose();
      deps.connectionGrace.current.clear();
    };
  }, [deps.socket, deps.roomId]);

  // ── 麦克风静音 ─────────────────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const producer = deps.audioProducer.current;
    if (!producer || deps.forceMutedRef.current) return;
    deps.selfMutedRef.current = !deps.selfMutedRef.current;
    syncMicrophoneMute(
      producer,
      deps.selfMutedRef.current,
      deps.forceMutedRef.current,
      deps.microphoneVolumeRef.current,
    );
    deps.setIsMuted(deps.selfMutedRef.current);
    deps.socket.emit('voice:mute-state', { roomId: deps.roomId, muted: deps.selfMutedRef.current });
  }, [deps.socket, deps.roomId]);
  return { joinVoice, resetVoice, leaveVoice, refreshAudioConnection, toggleMute };
}
