import { useVolumeControls } from './audio/useVolumeControls';
import { useAudioDevices } from './audio/useAudioDevices';
import { useAudioMeters } from './audio/useAudioMeters';
import { useMediaDiagnostics } from './diagnostics/useMediaDiagnostics';
import { useMediaTransports } from './transport/useMediaTransports';
import { useScreenViewing } from './screen/useScreenViewing';
import { useMicrophoneControls } from './microphone/useMicrophoneControls';
import { useVoiceSession } from './voice/useVoiceSession';
import { useScreenAnalysis } from './screen/useScreenAnalysis';
import { useScreenAudio } from './screen/useScreenAudio';
import { useScreenPublishing } from './screen/useScreenPublishing';
import { useApplicationAudioPublishing } from './application-audio/useApplicationAudioPublishing';
import {
  Transport,
  Producer,
  Consumer,
  Fps,
  MediaStats,
  EMPTY_STATS,
  RemoteScreen,
  AvailableScreen,
  RemoteApplicationAudio,
  SCREEN_RECEIVE_VOLUME_KEY,
  SCREEN_SHARE_VOLUME_KEY,
  APPLICATION_AUDIO_SHARE_VOLUME_KEY,
  APPLICATION_AUDIO_RECEIVE_VOLUME_KEY,
  MICROPHONE_VOLUME_KEY,
  MASTER_OUTPUT_VOLUME_KEY,
  loadNumber,
  loadMemberVolumes,
  loadVolumeMap,
} from './desktopMediaSupport';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { DisconnectGrace } from '../connection/disconnectGrace';

import { shouldResetVoiceForTransportState } from './voice/voiceTransportPolicy';
import { syncMicrophoneMute } from './microphone/microphoneProcessing';
import { type MicrophoneNoiseMode } from './microphone/microphoneCandidate';

import { VoiceMember } from '../../types';
import {
  AUDIO_INPUT_DEVICE_KEY,
  AUDIO_OUTPUT_DEVICE_KEY,
  AudioDeviceOption,
  createRemoteAudioOutput,
  isMemberVoiceAudio,
  loadAudioDeviceId,
  normalizeMicrophoneDeviceId,
} from './audio/audioDevices';
import { type RtcVideoCounterSample } from './diagnostics/mediaDiagnostics';
import {
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from './screen/screenCapture';
import { ApplicationAudioPipeline } from './application-audio/applicationAudio';

export { SCREEN_PRESETS } from './screen/screenCapture';
export type { ScreenPreset } from './screen/screenCapture';

export function useWebRTC(socket: Socket, roomId: string) {
  const [inVoice, setInVoice] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isApplicationAudioSharing, setIsApplicationAudioSharing] = useState(false);
  const [applicationAudioLabel, setApplicationAudioLabel] = useState<string | null>(null);
  const [screenPreset, setScreenPreset] = useState<ScreenPreset>('720p');
  const [fps, setFps] = useState<Fps>(30);
  const [shareAudio, setShareAudio] = useState(false);
  const [screenGameMode, setScreenGameMode] = useState(false);
  const [screenNativeResolution, setScreenNativeResolution] = useState(false);
  const [screenActivity, setScreenActivity] = useState<ScreenActivity>('active');
  const [screenEncodingPlan, setScreenEncodingPlan] = useState<ScreenEncodingPlan | null>(null);
  const [screenViewerCount, setScreenViewerCount] = useState(0);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [availableScreens, setAvailableScreens] = useState<AvailableScreen[]>([]);
  const [remoteApplicationAudios, setRemoteApplicationAudios] = useState<RemoteApplicationAudio[]>(
    [],
  );
  const [watchingScreenPeer, setWatchingScreenPeer] = useState<string | null>(null);
  const [screenReceiveVolume, setScreenReceiveVolumeState] = useState(() =>
    loadNumber(SCREEN_RECEIVE_VOLUME_KEY, 1, 2),
  );
  const screenReceiveVolumeRef = useRef(screenReceiveVolume);
  // 观看中的屏幕共享是否附带音频：决定观看端是否显示共享音频音量条。
  const [screenReceiveHasAudio, setScreenReceiveHasAudio] = useState(false);
  const [screenShareVolume, setScreenShareVolumeState] = useState(() =>
    loadNumber(SCREEN_SHARE_VOLUME_KEY, 1, 2),
  );
  const [applicationAudioShareVolume, setApplicationAudioShareVolumeState] = useState(() =>
    loadNumber(APPLICATION_AUDIO_SHARE_VOLUME_KEY, 1, 2),
  );
  const [applicationAudioReceiveVolumes, setApplicationAudioReceiveVolumes] = useState<
    Record<string, number>
  >(() => loadVolumeMap(APPLICATION_AUDIO_RECEIVE_VOLUME_KEY, 2));
  const [microphoneVolume, setMicrophoneVolumeState] = useState(() =>
    loadNumber(MICROPHONE_VOLUME_KEY, 1, 2),
  );
  const [masterOutputVolume, setMasterOutputVolumeState] = useState(() =>
    loadNumber(MASTER_OUTPUT_VOLUME_KEY, 1, 2),
  );
  const [audioInputDevices, setAudioInputDevices] = useState<AudioDeviceOption[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() =>
    normalizeMicrophoneDeviceId(loadAudioDeviceId(AUDIO_INPUT_DEVICE_KEY)),
  );
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState(() =>
    loadAudioDeviceId(AUDIO_OUTPUT_DEVICE_KEY),
  );
  const [audioDevicesRefreshing, setAudioDevicesRefreshing] = useState(false);
  const [audioInputSwitching, setAudioInputSwitching] = useState(false);
  const [audioDeviceError, setAudioDeviceError] = useState<string | null>(null);
  // RNNoise is the default and is deliberately not persisted. Restarting the
  // app starts with RNNoise again; an unavailable model falls back to system
  // processing through acquireMicrophoneCandidate.
  const [microphoneNoiseMode, setMicrophoneNoiseMode] = useState<MicrophoneNoiseMode>('rnnoise');
  const [microphoneNoiseSwitching, setMicrophoneNoiseSwitching] = useState(false);
  const [microphoneNoiseError, setMicrophoneNoiseError] = useState<string | null>(null);

  // 实时统计（帧率 / 延迟 / 丢包），开关控制是否采集
  const [statsEnabled, setStatsEnabled] = useState(false);
  const [stats, setStats] = useState<MediaStats>(EMPTY_STATS);
  // 每个人说话音量 0~1（key = socketId）
  const [speakingLevels, setSpeakingLevels] = useState<Record<string, number>>({});
  const [sharedAudioLevels, setSharedAudioLevels] = useState<Record<string, number>>({});
  // 本机针对每位远端成员的麦克风播放增益，1 = 100% 原始音量，2 = 200%。
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});

  // mediasoup-client 实例
  const deviceRef = useRef<Device | null>(null);
  const sendTransport = useRef<Transport | null>(null);
  const recvTransport = useRef<Transport | null>(null);
  const audioProducer = useRef<Producer | null>(null);
  const screenProducer = useRef<Producer | null>(null);
  const screenAudioProducer = useRef<Producer | null>(null); // 共享屏幕时的系统音频
  const applicationAudioProducer = useRef<Producer | null>(null);
  const selfMutedRef = useRef(false);
  const forceMutedRef = useRef(false);
  const joiningRef = useRef(false);
  const mediaGeneration = useRef(0);
  const connectionGrace = useRef(new DisconnectGrace());
  const resetVoiceRef = useRef<(notifyServer?: boolean, reason?: string) => void>(() => {});
  const voiceSocketId = useRef<string>();

  const checkTransport = useCallback((key: string, state: string) => {
    if (state === 'connected') connectionGrace.current.recover(key);
    if (shouldResetVoiceForTransportState(state)) {
      connectionGrace.current.fail(key, () => {
        resetVoiceRef.current(true, `media-${key}-timeout`);
        setAudioDeviceError('语音连接中断超过 5 秒，可直接重新加入语音，无需重连服务器');
      });
    } else {
      // A disconnected ICE/DTLS path may recover by itself. Cancel any stale
      // failure timer instead of ejecting the user after a brief network flap.
      connectionGrace.current.recover(key);
    }
  }, []);
  // 仅在已经建立语音会话后播放本地“离开”提示，避免组件卸载/重复清理时误播。
  const voiceSessionActiveRef = useRef(false);
  const memberVolumesRef = useRef<Record<string, number>>({});
  const rememberedMemberVolumes = useRef<Record<string, number>>(loadMemberVolumes());
  // 点击远端扬声器静音后，记住静音前的音量，恢复时不把用户调好的音量重置为 100%。
  const memberMuteRestoreVolumes = useRef<Record<string, number>>({});
  const voiceMembersRef = useRef<VoiceMember[]>([]);
  const seenVoicePresenceEvents = useRef<string[]>([]);
  const screenShareVolumeRef = useRef(screenShareVolume);
  const applicationAudioShareVolumeRef = useRef(applicationAudioShareVolume);
  const applicationAudioReceiveVolumesRef = useRef(applicationAudioReceiveVolumes);
  const remoteApplicationAudiosRef = useRef<RemoteApplicationAudio[]>([]);
  const selectedAudioInputRef = useRef(selectedAudioInputId);
  const selectedAudioOutputRef = useRef(selectedAudioOutputId);
  // consumerId → { consumer, socketId, kind, sourceType }
  const consumers = useRef<
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
  >(new Map());
  // 同一个 producer 只允许创建一个 consumer；同时记录进行中的请求以避免信令竞态。
  const consumerByProducer = useRef<Map<string, string>>(new Map());
  const pendingProducers = useRef<Set<string>>(new Set());
  // 音频播放元素，按 consumerId 存储（一个人可能同时有麦克风+系统音频两路）
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());
  // 所有远端音轨（麦克风、屏幕、应用音频）均通过各自的 Web Audio 增益播放。
  // 激活 WebRTC 的媒体元素必须静音，避免原始流绕过增益或双路播放。
  const remoteAudioOutputs = useRef<Map<string, ReturnType<typeof createRemoteAudioOutput>>>(
    new Map(),
  );
  const screenStreams = useRef<Map<string, MediaStream>>(new Map());
  const localAudioRef = useRef<MediaStream | null>(null);
  const rawAudioRef = useRef<MediaStream | null>(null);
  const micProcessingContext = useRef<AudioContext | null>(null);
  const micProcessingGain = useRef<GainNode | null>(null);
  const micProcessingRecoveryBusy = useRef(false);
  const recoverMicrophoneProcessingRef = useRef<() => void>(() => {});
  const microphoneVolumeRef = useRef(microphoneVolume);
  const microphoneNoiseModeRef = useRef<MicrophoneNoiseMode>('rnnoise');
  const microphoneNoiseBusyRef = useRef(false);
  const rnnoiseFailureRef = useRef<() => void>(() => {});
  const masterOutputVolumeRef = useRef(masterOutputVolume);
  const masterOutputGain = useRef<GainNode | null>(null);
  const localScreenRef = useRef<MediaStream | null>(null);
  const screenAudioPipeline = useRef<ApplicationAudioPipeline | null>(null);
  const screenAudioUnsubscribe = useRef<(() => void) | null>(null);
  const applicationAudioPipeline = useRef<ApplicationAudioPipeline | null>(null);
  const applicationAudioUnsubscribe = useRef<(() => void) | null>(null);
  const applicationAudioStop = useRef<(() => Promise<boolean>) | null>(null);
  const availableScreensRef = useRef<Map<string, AvailableScreen>>(new Map());
  const pendingScreenAudioByPeer = useRef<Map<string, string>>(new Map());
  const watchingScreenPeerRef = useRef<string | null>(null);
  const screenDemandActiveRef = useRef(false);
  const screenAnalysisTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenAnalysisVideo = useRef<HTMLVideoElement | null>(null);
  const screenAnalysisCanvas = useRef<HTMLCanvasElement | null>(null);
  const previousScreenSample = useRef<Uint8ClampedArray | null>(null);
  const activityCandidate = useRef<{ value: ScreenActivity; count: number }>({
    value: 'active',
    count: 0,
  });
  const screenActivityRef = useRef<ScreenActivity>('active');
  const screenRampGuardUntil = useRef(0);
  const screenRampTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 音量分析（Web Audio）
  const audioCtxRef = useRef<AudioContext | null>(null);
  // key = consumerId 或 'local'；value = { analyser, data, socketId }
  const analysers = useRef<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        analyser: AnalyserNode;
        data: Uint8Array<ArrayBuffer>;
        socketId: string;
        stream: MediaStream;
        type: 'voice' | 'application';
        playbackGain: () => number;
      }
    >
  >(new Map());
  const volumeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsEnabledRef = useRef(false);
  const statsCollecting = useRef(false);
  const videoCounterPrev = useRef<RtcVideoCounterSample | null>(null);
  const receiveLossPrev = useRef<{ lost: number; packets: number } | null>(null);
  const remoteLossPrev = useRef<{ lost: number; packets: number } | null>(null);
  const diagnosticHistory = useRef<
    {
      timestamp: string;
      stats: MediaStats;
      trackSettings: MediaTrackSettings | null;
    }[]
  >([]);
  const {
    setMemberVolume,
    toggleMemberMute,
    setScreenReceiveVolume,
    setScreenShareVolume,
    setApplicationAudioShareVolume,
    setApplicationAudioReceiveVolume,
    setMicrophoneVolume,
    setMasterOutputVolume,
    storeRemoteApplicationAudio,
    removeRemoteApplicationAudio,
    clearRemoteApplicationAudios,
  } = useVolumeControls({
    get memberVolumesRef() {
      return memberVolumesRef;
    },
    get setMemberVolumes() {
      return setMemberVolumes;
    },
    get rememberedMemberVolumes() {
      return rememberedMemberVolumes;
    },
    get consumers() {
      return consumers;
    },
    get audioEls() {
      return audioEls;
    },
    get remoteAudioOutputs() {
      return remoteAudioOutputs;
    },
    get memberMuteRestoreVolumes() {
      return memberMuteRestoreVolumes;
    },
    get ensureAudioCtx() {
      return ensureAudioCtx;
    },
    get masterOutputGain() {
      return masterOutputGain;
    },
    get screenReceiveVolumeRef() {
      return screenReceiveVolumeRef;
    },
    get setScreenReceiveVolumeState() {
      return setScreenReceiveVolumeState;
    },
    get screenShareVolumeRef() {
      return screenShareVolumeRef;
    },
    get setScreenShareVolumeState() {
      return setScreenShareVolumeState;
    },
    get screenAudioPipeline() {
      return screenAudioPipeline;
    },
    get applicationAudioShareVolumeRef() {
      return applicationAudioShareVolumeRef;
    },
    get setApplicationAudioShareVolumeState() {
      return setApplicationAudioShareVolumeState;
    },
    get applicationAudioPipeline() {
      return applicationAudioPipeline;
    },
    get applicationAudioReceiveVolumesRef() {
      return applicationAudioReceiveVolumesRef;
    },
    get setApplicationAudioReceiveVolumes() {
      return setApplicationAudioReceiveVolumes;
    },
    get microphoneVolumeRef() {
      return microphoneVolumeRef;
    },
    get setMicrophoneVolumeState() {
      return setMicrophoneVolumeState;
    },
    get micProcessingGain() {
      return micProcessingGain;
    },
    get recoverMicrophoneProcessingRef() {
      return recoverMicrophoneProcessingRef;
    },
    get audioProducer() {
      return audioProducer;
    },
    get selfMutedRef() {
      return selfMutedRef;
    },
    get forceMutedRef() {
      return forceMutedRef;
    },
    get masterOutputVolumeRef() {
      return masterOutputVolumeRef;
    },
    get setMasterOutputVolumeState() {
      return setMasterOutputVolumeState;
    },
    get remoteApplicationAudiosRef() {
      return remoteApplicationAudiosRef;
    },
    get setRemoteApplicationAudios() {
      return setRemoteApplicationAudios;
    },
  });
  const { refreshAudioDevices, selectAudioOutput } = useAudioDevices({
    get setAudioDeviceError() {
      return setAudioDeviceError;
    },
    get setAudioDevicesRefreshing() {
      return setAudioDevicesRefreshing;
    },
    get rawAudioRef() {
      return rawAudioRef;
    },
    get setAudioInputDevices() {
      return setAudioInputDevices;
    },
    get setAudioOutputDevices() {
      return setAudioOutputDevices;
    },
    get selectedAudioInputRef() {
      return selectedAudioInputRef;
    },
    get setSelectedAudioInputId() {
      return setSelectedAudioInputId;
    },
    get selectedAudioOutputRef() {
      return selectedAudioOutputRef;
    },
    get setSelectedAudioOutputId() {
      return setSelectedAudioOutputId;
    },
    get audioEls() {
      return audioEls;
    },
    get audioCtxRef() {
      return audioCtxRef;
    },
  });
  const {
    ensureAudioCtx,
    playPresenceTone,
    attachAnalyser,
    detachAnalyser,
    clearAnalysers,
    startMeters,
    stopMeters,
  } = useAudioMeters({
    get audioCtxRef() {
      return audioCtxRef;
    },
    get masterOutputGain() {
      return masterOutputGain;
    },
    get masterOutputVolumeRef() {
      return masterOutputVolumeRef;
    },
    get selectedAudioOutputRef() {
      return selectedAudioOutputRef;
    },
    get analysers() {
      return analysers;
    },
    get volumeTimer() {
      return volumeTimer;
    },
    get setSpeakingLevels() {
      return setSpeakingLevels;
    },
    get setSharedAudioLevels() {
      return setSharedAudioLevels;
    },
  });
  const { toggleStats, exportMediaDiagnostics } = useMediaDiagnostics({
    get statsCollecting() {
      return statsCollecting;
    },
    get screenProducer() {
      return screenProducer;
    },
    get watchingScreenPeerRef() {
      return watchingScreenPeerRef;
    },
    get statsEnabledRef() {
      return statsEnabledRef;
    },
    get videoCounterPrev() {
      return videoCounterPrev;
    },
    get receiveLossPrev() {
      return receiveLossPrev;
    },
    get remoteLossPrev() {
      return remoteLossPrev;
    },
    get setStats() {
      return setStats;
    },
    get sendTransport() {
      return sendTransport;
    },
    get recvTransport() {
      return recvTransport;
    },
    get consumers() {
      return consumers;
    },
    get socket() {
      return socket;
    },
    get diagnosticHistory() {
      return diagnosticHistory;
    },
    get setStatsEnabled() {
      return setStatsEnabled;
    },
    get statsTimer() {
      return statsTimer;
    },
    get roomId() {
      return roomId;
    },
    get screenPreset() {
      return screenPreset;
    },
    get screenGameMode() {
      return screenGameMode;
    },
    get fps() {
      return fps;
    },
    get screenNativeResolution() {
      return screenNativeResolution;
    },
    get screenEncodingPlan() {
      return screenEncodingPlan;
    },
  });

  // 卸载时清理所有定时器和音频上下文
  useEffect(
    () => () => {
      const shouldPlayLeaveTone = voiceSessionActiveRef.current;
      if (shouldPlayLeaveTone) {
        // room 导航时，父组件的清理可能晚于本 hook 的清理；在这里补发本地提示。
        voiceSessionActiveRef.current = false;
        playPresenceTone('leave');
      }
      if (volumeTimer.current) clearInterval(volumeTimer.current);
      clearAnalysers();
      if (statsTimer.current) clearInterval(statsTimer.current);
      if (screenAnalysisTimer.current) clearInterval(screenAnalysisTimer.current);
      if (screenRampTimer.current) clearTimeout(screenRampTimer.current);
      screenRampTimer.current = null;
      screenRampGuardUntil.current = 0;
      if (screenAnalysisVideo.current) screenAnalysisVideo.current.srcObject = null;
      remoteAudioOutputs.current.forEach((output) => output.close());
      remoteAudioOutputs.current.clear();
      audioEls.current.forEach((element) => {
        element.pause();
        element.srcObject = null;
      });
      audioEls.current.clear();
      const audioContext = audioCtxRef.current;
      if (audioContext) {
        const closeAudioContext = () => {
          if (audioCtxRef.current === audioContext) audioCtxRef.current = null;
          if (masterOutputGain.current?.context === audioContext) masterOutputGain.current = null;
          audioContext.close().catch(() => {});
        };
        // 最后一声提示需要完成约 250ms 的振荡，卸载时延后关闭上下文。
        if (shouldPlayLeaveTone) setTimeout(closeAudioContext, 600);
        else closeAudioContext();
      }
      micProcessingContext.current?.close().catch(() => {});
      screenAudioUnsubscribe.current?.();
      screenAudioUnsubscribe.current = null;
      screenAudioPipeline.current?.close();
      screenAudioPipeline.current = null;
      void window.coveScreenAudio?.stop();
      applicationAudioUnsubscribe.current?.();
      applicationAudioUnsubscribe.current = null;
      applicationAudioPipeline.current?.close();
      applicationAudioPipeline.current = null;
      void applicationAudioStop.current?.();
      applicationAudioStop.current = null;
      void window.coveApplicationAudio?.stop();
      void window.coveSystemAudio?.stop();
    },
    [playPresenceTone],
  );
  const { setupDevice, consumeProducer } = useMediaTransports({
    get deviceRef() {
      return deviceRef;
    },
    get sendTransport() {
      return sendTransport;
    },
    get recvTransport() {
      return recvTransport;
    },
    get mediaGeneration() {
      return mediaGeneration;
    },
    get socket() {
      return socket;
    },
    get checkTransport() {
      return checkTransport;
    },
    get consumerByProducer() {
      return consumerByProducer;
    },
    get pendingProducers() {
      return pendingProducers;
    },
    get consumers() {
      return consumers;
    },
    get setRemoteScreen() {
      return setRemoteScreen;
    },
    get removeRemoteApplicationAudio() {
      return removeRemoteApplicationAudio;
    },
    get remoteAudioOutputs() {
      return remoteAudioOutputs;
    },
    get setScreenReceiveHasAudio() {
      return setScreenReceiveHasAudio;
    },
    get ensureAudioCtx() {
      return ensureAudioCtx;
    },
    get screenReceiveVolumeRef() {
      return screenReceiveVolumeRef;
    },
    get masterOutputGain() {
      return masterOutputGain;
    },
    get memberVolumesRef() {
      return memberVolumesRef;
    },
    get applicationAudioReceiveVolumesRef() {
      return applicationAudioReceiveVolumesRef;
    },
    get audioEls() {
      return audioEls;
    },
    get selectedAudioOutputRef() {
      return selectedAudioOutputRef;
    },
    get detachAnalyser() {
      return detachAnalyser;
    },
    get attachAnalyser() {
      return attachAnalyser;
    },
    get audioCtxRef() {
      return audioCtxRef;
    },
    get masterOutputVolumeRef() {
      return masterOutputVolumeRef;
    },
    get startMeters() {
      return startMeters;
    },
    get screenStreams() {
      return screenStreams;
    },
  });
  const {
    storeAvailableScreen,
    removeAvailableScreen,
    clearAvailableScreens,
    closeLocalConsumer,
    stopWatchingScreen,
    watchScreen,
    captureWatchGuard,
  } = useScreenViewing({
    get setAvailableScreens() {
      return setAvailableScreens;
    },
    get availableScreensRef() {
      return availableScreensRef;
    },
    get consumers() {
      return consumers;
    },
    get consumerByProducer() {
      return consumerByProducer;
    },
    get socket() {
      return socket;
    },
    get audioEls() {
      return audioEls;
    },
    get remoteAudioOutputs() {
      return remoteAudioOutputs;
    },
    get detachAnalyser() {
      return detachAnalyser;
    },
    get setScreenReceiveHasAudio() {
      return setScreenReceiveHasAudio;
    },
    get screenStreams() {
      return screenStreams;
    },
    get setRemoteScreen() {
      return setRemoteScreen;
    },
    get watchingScreenPeerRef() {
      return watchingScreenPeerRef;
    },
    get setWatchingScreenPeer() {
      return setWatchingScreenPeer;
    },
    get videoCounterPrev() {
      return videoCounterPrev;
    },
    get receiveLossPrev() {
      return receiveLossPrev;
    },
    get screenProducer() {
      return screenProducer;
    },
    get setStats() {
      return setStats;
    },
    get consumeProducer() {
      return consumeProducer;
    },
  });

  // ── Socket 事件 ────────────────────────────────────────────────────────────

  useEffect(() => {
    const onVoiceMembers = (list: VoiceMember[]) => {
      voiceMembersRef.current = list;
      const nextVolumes: Record<string, number> = {};
      for (const member of list) {
        nextVolumes[member.socketId] =
          rememberedMemberVolumes.current[member.userId] ??
          memberVolumesRef.current[member.socketId] ??
          1;
      }
      memberVolumesRef.current = nextVolumes;
      setMemberVolumes(nextVolumes);
      for (const [consumerId, entry] of consumers.current) {
        if (!isMemberVoiceAudio(entry.kind, entry.sourceType)) continue;
        const element = audioEls.current.get(consumerId);
        const volume = nextVolumes[entry.socketId] ?? 1;
        const output = remoteAudioOutputs.current.get(consumerId);
        if (output) output.setVolume(volume);
        else if (element) {
          element.volume = Math.min(1, volume);
          element.muted = volume === 0;
        }
      }
      setVoiceMembers(list);
    };

    const onVoicePresence = ({
      eventId,
      action,
    }: {
      eventId?: string;
      action: 'join' | 'leave';
    }) => {
      if (!deviceRef.current) return;
      if (eventId) {
        if (seenVoicePresenceEvents.current.includes(eventId)) return;
        seenVoicePresenceEvents.current = [...seenVoicePresenceEvents.current.slice(-63), eventId];
      }
      playPresenceTone(action);
    };

    // 服务端通知：有新的 producer（有人加入语音或开始共享）
    const onNewProducer = async ({
      producerId,
      peerId,
      kind,
      appData,
    }: {
      producerId: string;
      peerId: string;
      kind: string;
      appData: Record<string, unknown>;
    }) => {
      if (!deviceRef.current) return; // 尚未加入语音时不建立媒体订阅
      const sourceType = appData?.type;
      if (sourceType === 'screen') {
        storeAvailableScreen({
          socketId: peerId,
          videoProducerId: producerId,
          audioProducerId: pendingScreenAudioByPeer.current.get(peerId),
        });
        return;
      }
      if (sourceType === 'screen-audio') {
        pendingScreenAudioByPeer.current.set(peerId, producerId);
        const current = availableScreensRef.current.get(peerId);
        if (current) storeAvailableScreen({ ...current, audioProducerId: producerId });
        if (watchingScreenPeerRef.current === peerId)
          await consumeProducer(producerId, peerId, kind, appData, captureWatchGuard(peerId));
        return;
      }
      if (sourceType === 'application-audio') {
        const consumed = await consumeProducer(producerId, peerId, kind, appData);
        if (consumed) {
          storeRemoteApplicationAudio({
            socketId: peerId,
            producerId,
            label:
              typeof appData?.label === 'string' && appData.label.trim() ? appData.label : '应用',
          });
        }
        return;
      }
      await consumeProducer(producerId, peerId, kind, appData);
    };

    // 服务端通知：某个 consumer 对应的 producer 已关闭
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) => {
      const entry = consumers.current.get(consumerId);
      if (!entry) return;
      closeLocalConsumer(consumerId, false);
      if (entry.sourceType === 'screen') {
        // 视频已结束时一并关闭关联音频，避免残留无画面的订阅。
        stopWatchingScreen();
      }
      if (entry.sourceType === 'application-audio')
        removeRemoteApplicationAudio(entry.socketId, entry.producerId);
    };

    // 未观看的客户端没有 Consumer，也必须在分享结束时移除“观看共享”入口。
    const onProducerClosed = ({
      producerId,
      peerId,
      sourceType,
    }: {
      producerId: string;
      peerId: string;
      sourceType: 'screen' | 'screen-audio';
    }) => {
      if (sourceType === 'screen-audio') {
        if (pendingScreenAudioByPeer.current.get(peerId) === producerId)
          pendingScreenAudioByPeer.current.delete(peerId);
        const current = availableScreensRef.current.get(peerId);
        if (current?.audioProducerId === producerId)
          storeAvailableScreen({ ...current, audioProducerId: undefined });
        return;
      }
      removeAvailableScreen(peerId, producerId);
      if (watchingScreenPeerRef.current === peerId) stopWatchingScreen();
    };

    const onScreenViewers = ({ peerId, viewerCount }: { peerId: string; viewerCount: number }) => {
      if (peerId === socket.id) setScreenViewerCount(viewerCount);
    };

    const onScreenDemand = ({
      sourceType,
      active,
      viewerCount,
    }: {
      sourceType: 'screen' | 'screen-audio';
      active: boolean;
      viewerCount: number;
    }) => {
      if (sourceType === 'screen') {
        screenDemandActiveRef.current = active;
        setScreenViewerCount(viewerCount);
        const producer = screenProducer.current;
        if (active) {
          producer?.resume();
        } else producer?.pause();
      } else if (active && !forceMutedRef.current) screenAudioProducer.current?.resume();
      else screenAudioProducer.current?.pause();
    };

    const onUserLeft = ({ socketId }: { socketId: string }) => {
      // 清理该用户所有相关的 consumer / 音频元素 / 音量分析
      for (const [cid, entry] of consumers.current) {
        if (entry.socketId !== socketId) continue;
        const el = audioEls.current.get(cid);
        if (el) {
          el.pause();
          el.srcObject = null;
          audioEls.current.delete(cid);
        }
        const output = remoteAudioOutputs.current.get(cid);
        if (output) {
          output.close();
          remoteAudioOutputs.current.delete(cid);
        }
        detachAnalyser(cid);
        entry.consumer.close();
        consumerByProducer.current.delete(entry.producerId);
        consumers.current.delete(cid);
      }
      screenStreams.current.delete(socketId);
      setRemoteScreen((p) => (p?.socketId === socketId ? null : p));
      pendingScreenAudioByPeer.current.delete(socketId);
      removeAvailableScreen(socketId);
      removeRemoteApplicationAudio(socketId);
      if (watchingScreenPeerRef.current === socketId) {
        watchingScreenPeerRef.current = null;
        setWatchingScreenPeer(null);
        videoCounterPrev.current = null;
        receiveLossPrev.current = null;
        if (!screenProducer.current) setStats(EMPTY_STATS);
      }
    };

    socket.on('voice:members-updated', onVoiceMembers);
    socket.on('voice:presence', onVoicePresence);
    socket.on('ms:new-producer', onNewProducer);
    socket.on('ms:consumer-closed', onConsumerClosed);
    socket.on('ms:producer-closed', onProducerClosed);
    socket.on('screen:viewers', onScreenViewers);
    socket.on('screen:demand', onScreenDemand);
    socket.on('voice:user-left', onUserLeft);

    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('voice:presence', onVoicePresence);
      socket.off('ms:new-producer', onNewProducer);
      socket.off('ms:consumer-closed', onConsumerClosed);
      socket.off('ms:producer-closed', onProducerClosed);
      socket.off('screen:viewers', onScreenViewers);
      socket.off('screen:demand', onScreenDemand);
      socket.off('voice:user-left', onUserLeft);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    socket,
    inVoice,
    consumeProducer,
    captureWatchGuard,
    closeLocalConsumer,
    stopWatchingScreen,
    storeAvailableScreen,
    removeAvailableScreen,
    playPresenceTone,
    storeRemoteApplicationAudio,
    removeRemoteApplicationAudio,
  ]);

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
        applicationAudioProducer.current?.pause();
      } else {
        if (audioProducer.current)
          syncMicrophoneMute(
            audioProducer.current,
            selfMutedRef.current,
            false,
            microphoneVolumeRef.current,
          );
        if (screenDemandActiveRef.current) screenAudioProducer.current?.resume();
        applicationAudioProducer.current?.resume();
      }
      setIsMuted(muted || selfMutedRef.current);
    };
    socket.on('room:force-muted', onForcedMute);
    return () => {
      socket.off('room:force-muted', onForcedMute);
    };
  }, [socket, roomId]);
  const { prepareMicrophone, replaceMicrophone, selectAudioInput, selectMicrophoneNoiseMode } =
    useMicrophoneControls({
      get microphoneVolumeRef() {
        return microphoneVolumeRef;
      },
      get micProcessingContext() {
        return micProcessingContext;
      },
      get rnnoiseFailureRef() {
        return rnnoiseFailureRef;
      },
      get microphoneNoiseModeRef() {
        return microphoneNoiseModeRef;
      },
      get audioProducer() {
        return audioProducer;
      },
      get mediaGeneration() {
        return mediaGeneration;
      },
      get selfMutedRef() {
        return selfMutedRef;
      },
      get forceMutedRef() {
        return forceMutedRef;
      },
      get rawAudioRef() {
        return rawAudioRef;
      },
      get localAudioRef() {
        return localAudioRef;
      },
      get micProcessingGain() {
        return micProcessingGain;
      },
      get setMicrophoneNoiseMode() {
        return setMicrophoneNoiseMode;
      },
      get setMicrophoneNoiseError() {
        return setMicrophoneNoiseError;
      },
      get detachAnalyser() {
        return detachAnalyser;
      },
      get attachAnalyser() {
        return attachAnalyser;
      },
      get socket() {
        return socket;
      },
      get refreshAudioDevices() {
        return refreshAudioDevices;
      },
      get micProcessingRecoveryBusy() {
        return micProcessingRecoveryBusy;
      },
      get recoverMicrophoneProcessingRef() {
        return recoverMicrophoneProcessingRef;
      },
      get microphoneNoiseBusyRef() {
        return microphoneNoiseBusyRef;
      },
      get selectedAudioInputRef() {
        return selectedAudioInputRef;
      },
      get setSelectedAudioInputId() {
        return setSelectedAudioInputId;
      },
      get setAudioDeviceError() {
        return setAudioDeviceError;
      },
      get inVoice() {
        return inVoice;
      },
      get setAudioInputSwitching() {
        return setAudioInputSwitching;
      },
      get joiningRef() {
        return joiningRef;
      },
      get audioInputSwitching() {
        return audioInputSwitching;
      },
      get setMicrophoneNoiseSwitching() {
        return setMicrophoneNoiseSwitching;
      },
    });

  rnnoiseFailureRef.current = () => {
    setMicrophoneNoiseError('RNNoise 运行中断，正在尝试恢复系统降噪；也可手动选择系统降噪重试。');
    void selectMicrophoneNoiseMode('system');
  };
  const { joinVoice, leaveVoice, refreshAudioConnection, toggleMute } = useVoiceSession({
    get voiceSessionActiveRef() {
      return voiceSessionActiveRef;
    },
    get joiningRef() {
      return joiningRef;
    },
    get socket() {
      return socket;
    },
    get mediaGeneration() {
      return mediaGeneration;
    },
    get voiceSocketId() {
      return voiceSocketId;
    },
    get setIsJoining() {
      return setIsJoining;
    },
    get setAudioDeviceError() {
      return setAudioDeviceError;
    },
    get prepareMicrophone() {
      return prepareMicrophone;
    },
    get selectedAudioInputRef() {
      return selectedAudioInputRef;
    },
    get microphoneNoiseModeRef() {
      return microphoneNoiseModeRef;
    },
    get setMicrophoneNoiseMode() {
      return setMicrophoneNoiseMode;
    },
    get setMicrophoneNoiseError() {
      return setMicrophoneNoiseError;
    },
    get rawAudioRef() {
      return rawAudioRef;
    },
    get micProcessingContext() {
      return micProcessingContext;
    },
    get micProcessingGain() {
      return micProcessingGain;
    },
    get localAudioRef() {
      return localAudioRef;
    },
    get refreshAudioDevices() {
      return refreshAudioDevices;
    },
    get setupDevice() {
      return setupDevice;
    },
    get selfMutedRef() {
      return selfMutedRef;
    },
    get forceMutedRef() {
      return forceMutedRef;
    },
    get microphoneVolumeRef() {
      return microphoneVolumeRef;
    },
    get roomId() {
      return roomId;
    },
    get sendTransport() {
      return sendTransport;
    },
    get audioProducer() {
      return audioProducer;
    },
    get attachAnalyser() {
      return attachAnalyser;
    },
    get startMeters() {
      return startMeters;
    },
    get setInVoice() {
      return setInVoice;
    },
    get pendingScreenAudioByPeer() {
      return pendingScreenAudioByPeer;
    },
    get storeAvailableScreen() {
      return storeAvailableScreen;
    },
    get consumeProducer() {
      return consumeProducer;
    },
    get storeRemoteApplicationAudio() {
      return storeRemoteApplicationAudio;
    },
    get resetVoiceRef() {
      return resetVoiceRef;
    },
    get recvTransport() {
      return recvTransport;
    },
    get connectionGrace() {
      return connectionGrace;
    },
    get playPresenceTone() {
      return playPresenceTone;
    },
    get screenProducer() {
      return screenProducer;
    },
    get screenAudioProducer() {
      return screenAudioProducer;
    },
    get applicationAudioProducer() {
      return applicationAudioProducer;
    },
    get deviceRef() {
      return deviceRef;
    },
    get screenAudioUnsubscribe() {
      return screenAudioUnsubscribe;
    },
    get screenAudioPipeline() {
      return screenAudioPipeline;
    },
    get applicationAudioUnsubscribe() {
      return applicationAudioUnsubscribe;
    },
    get applicationAudioPipeline() {
      return applicationAudioPipeline;
    },
    get applicationAudioStop() {
      return applicationAudioStop;
    },
    get setIsApplicationAudioSharing() {
      return setIsApplicationAudioSharing;
    },
    get setApplicationAudioLabel() {
      return setApplicationAudioLabel;
    },
    get localScreenRef() {
      return localScreenRef;
    },
    get setLocalScreen() {
      return setLocalScreen;
    },
    get screenAnalysisTimer() {
      return screenAnalysisTimer;
    },
    get screenRampTimer() {
      return screenRampTimer;
    },
    get screenRampGuardUntil() {
      return screenRampGuardUntil;
    },
    get screenAnalysisVideo() {
      return screenAnalysisVideo;
    },
    get screenAnalysisCanvas() {
      return screenAnalysisCanvas;
    },
    get previousScreenSample() {
      return previousScreenSample;
    },
    get consumers() {
      return consumers;
    },
    get consumerByProducer() {
      return consumerByProducer;
    },
    get pendingProducers() {
      return pendingProducers;
    },
    get audioEls() {
      return audioEls;
    },
    get remoteAudioOutputs() {
      return remoteAudioOutputs;
    },
    get screenStreams() {
      return screenStreams;
    },
    get stopMeters() {
      return stopMeters;
    },
    get clearAnalysers() {
      return clearAnalysers;
    },
    get receiveLossPrev() {
      return receiveLossPrev;
    },
    get remoteLossPrev() {
      return remoteLossPrev;
    },
    get videoCounterPrev() {
      return videoCounterPrev;
    },
    get setStats() {
      return setStats;
    },
    get setRemoteScreen() {
      return setRemoteScreen;
    },
    get clearAvailableScreens() {
      return clearAvailableScreens;
    },
    get clearRemoteApplicationAudios() {
      return clearRemoteApplicationAudios;
    },
    get watchingScreenPeerRef() {
      return watchingScreenPeerRef;
    },
    get setWatchingScreenPeer() {
      return setWatchingScreenPeer;
    },
    get screenDemandActiveRef() {
      return screenDemandActiveRef;
    },
    get setScreenViewerCount() {
      return setScreenViewerCount;
    },
    get setScreenEncodingPlan() {
      return setScreenEncodingPlan;
    },
    get voiceMembersRef() {
      return voiceMembersRef;
    },
    get setVoiceMembers() {
      return setVoiceMembers;
    },
    get setIsMuted() {
      return setIsMuted;
    },
    get setIsSharing() {
      return setIsSharing;
    },
    get microphoneNoiseBusyRef() {
      return microphoneNoiseBusyRef;
    },
    get setAudioInputSwitching() {
      return setAudioInputSwitching;
    },
    get replaceMicrophone() {
      return replaceMicrophone;
    },
    get selectAudioOutput() {
      return selectAudioOutput;
    },
    get selectedAudioOutputRef() {
      return selectedAudioOutputRef;
    },
  });
  const {
    stopScreenAnalysis,
    applyScreenActivity,
    armScreenRampGuard,
    clearScreenRampGuard,
    startScreenAnalysis,
  } = useScreenAnalysis({
    get screenAnalysisTimer() {
      return screenAnalysisTimer;
    },
    get screenAnalysisVideo() {
      return screenAnalysisVideo;
    },
    get screenAnalysisCanvas() {
      return screenAnalysisCanvas;
    },
    get previousScreenSample() {
      return previousScreenSample;
    },
    get activityCandidate() {
      return activityCandidate;
    },
    get screenProducer() {
      return screenProducer;
    },
    get localScreenRef() {
      return localScreenRef;
    },
    get screenRampGuardUntil() {
      return screenRampGuardUntil;
    },
    get screenActivityRef() {
      return screenActivityRef;
    },
    get setScreenActivity() {
      return setScreenActivity;
    },
    get setScreenEncodingPlan() {
      return setScreenEncodingPlan;
    },
    get screenRampTimer() {
      return screenRampTimer;
    },
  });
  const { closeScreenAudio, startScreenAudio } = useScreenAudio({
    get screenAudioProducer() {
      return screenAudioProducer;
    },
    get socket() {
      return socket;
    },
    get screenAudioUnsubscribe() {
      return screenAudioUnsubscribe;
    },
    get screenAudioPipeline() {
      return screenAudioPipeline;
    },
    get screenShareVolumeRef() {
      return screenShareVolumeRef;
    },
    get sendTransport() {
      return sendTransport;
    },
    get forceMutedRef() {
      return forceMutedRef;
    },
    get screenDemandActiveRef() {
      return screenDemandActiveRef;
    },
  });
  const { startScreenShare, updateScreenShare, stopScreenShare } = useScreenPublishing({
    get inVoice() {
      return inVoice;
    },
    get isSharing() {
      return isSharing;
    },
    get screenPreset() {
      return screenPreset;
    },
    get screenGameMode() {
      return screenGameMode;
    },
    get screenNativeResolution() {
      return screenNativeResolution;
    },
    get fps() {
      return fps;
    },
    get shareAudio() {
      return shareAudio;
    },
    get setScreenPreset() {
      return setScreenPreset;
    },
    get setFps() {
      return setFps;
    },
    get setShareAudio() {
      return setShareAudio;
    },
    get setScreenGameMode() {
      return setScreenGameMode;
    },
    get setScreenNativeResolution() {
      return setScreenNativeResolution;
    },
    get localScreenRef() {
      return localScreenRef;
    },
    get setLocalScreen() {
      return setLocalScreen;
    },
    get videoCounterPrev() {
      return videoCounterPrev;
    },
    get remoteLossPrev() {
      return remoteLossPrev;
    },
    get deviceRef() {
      return deviceRef;
    },
    get sendTransport() {
      return sendTransport;
    },
    get socket() {
      return socket;
    },
    get screenProducer() {
      return screenProducer;
    },
    get screenDemandActiveRef() {
      return screenDemandActiveRef;
    },
    get armScreenRampGuard() {
      return armScreenRampGuard;
    },
    get applyScreenActivity() {
      return applyScreenActivity;
    },
    get stopScreenAnalysis() {
      return stopScreenAnalysis;
    },
    get startScreenAnalysis() {
      return startScreenAnalysis;
    },
    get startScreenAudio() {
      return startScreenAudio;
    },
    get setIsSharing() {
      return setIsSharing;
    },
    get clearScreenRampGuard() {
      return clearScreenRampGuard;
    },
    get screenAudioProducer() {
      return screenAudioProducer;
    },
    get screenAudioUnsubscribe() {
      return screenAudioUnsubscribe;
    },
    get screenAudioPipeline() {
      return screenAudioPipeline;
    },
    get setScreenEncodingPlan() {
      return setScreenEncodingPlan;
    },
    get roomId() {
      return roomId;
    },
    get closeScreenAudio() {
      return closeScreenAudio;
    },
    get setScreenViewerCount() {
      return setScreenViewerCount;
    },
    get setScreenActivity() {
      return setScreenActivity;
    },
    get screenActivityRef() {
      return screenActivityRef;
    },
    get watchingScreenPeerRef() {
      return watchingScreenPeerRef;
    },
    get setStats() {
      return setStats;
    },
    get clearAvailableScreens() {
      return clearAvailableScreens;
    },
    get clearRemoteApplicationAudios() {
      return clearRemoteApplicationAudios;
    },
  });
  const { stopApplicationAudioShare, startApplicationAudioShare, startSystemAudioShare } =
    useApplicationAudioPublishing({
      get detachAnalyser() {
        return detachAnalyser;
      },
      get applicationAudioProducer() {
        return applicationAudioProducer;
      },
      get socket() {
        return socket;
      },
      get applicationAudioUnsubscribe() {
        return applicationAudioUnsubscribe;
      },
      get applicationAudioPipeline() {
        return applicationAudioPipeline;
      },
      get applicationAudioStop() {
        return applicationAudioStop;
      },
      get setIsApplicationAudioSharing() {
        return setIsApplicationAudioSharing;
      },
      get setApplicationAudioLabel() {
        return setApplicationAudioLabel;
      },
      get inVoice() {
        return inVoice;
      },
      get applicationAudioShareVolumeRef() {
        return applicationAudioShareVolumeRef;
      },
      get sendTransport() {
        return sendTransport;
      },
      get forceMutedRef() {
        return forceMutedRef;
      },
      get attachAnalyser() {
        return attachAnalyser;
      },
      get startMeters() {
        return startMeters;
      },
    });

  const toggleShareAudio = useCallback(() => setShareAudio((p) => !p), []);

  return {
    inVoice,
    isJoining,
    isMuted,
    isForceMuted,
    isSharing,
    screenPreset,
    fps,
    shareAudio,
    screenGameMode,
    screenNativeResolution,
    isApplicationAudioSharing,
    applicationAudioLabel,
    applicationAudioShareVolume,
    screenActivity,
    screenEncodingPlan,
    screenViewerCount,
    voiceMembers,
    localScreen,
    remoteScreen, // { socketId, stream: MediaStream } | null
    availableScreens,
    remoteApplicationAudios,
    watchingScreenPeerId: watchingScreenPeer,
    isWatchingScreen: !!watchingScreenPeer,
    joinVoice,
    leaveVoice,
    toggleMute,
    startScreenShare,
    updateScreenShare,
    stopScreenShare,
    startApplicationAudioShare,
    stopApplicationAudioShare,
    setApplicationAudioShareVolume,
    startSystemAudioShare,
    watchScreen,
    stopWatchingScreen,
    toggleShareAudio,
    // 新增：实时统计 + 音量
    stats,
    statsEnabled,
    toggleStats,
    exportMediaDiagnostics,
    speakingLevels, // socketId → 0~1，音量前的输入电平
    sharedAudioLevels, // socketId → 0~1，同为音量前的输入电平；音量封顶由 UI 侧负责
    memberVolumes,
    setMemberVolume,
    toggleMemberMute,
    screenReceiveVolume,
    screenReceiveHasAudio,
    setScreenReceiveVolume,
    screenShareVolume,
    setScreenShareVolume,
    applicationAudioReceiveVolumes,
    setApplicationAudioReceiveVolume,
    microphoneVolume,
    setMicrophoneVolume,
    microphoneNoiseMode,
    microphoneNoiseSwitching,
    microphoneNoiseError,
    selectMicrophoneNoiseMode,
    masterOutputVolume,
    setMasterOutputVolume,
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInputId,
    selectedAudioOutputId,
    audioDevicesRefreshing,
    audioInputSwitching,
    audioDeviceError,
    refreshAudioDevices,
    selectAudioInput,
    selectAudioOutput,
    refreshAudioConnection,
    playPresenceTone,
    localSocketId: socket.id,
    // Read-only identity for generation-scoped collaboration; no media policy changes.
    localScreenProducerId: screenProducer.current?.id ?? null,
  };
}

export type { Fps, MediaStats } from './desktopMediaSupport';
