import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Device, types as MsTypes } from 'mediasoup-client';

type Transport       = MsTypes.Transport;
type Producer        = MsTypes.Producer;
type Consumer        = MsTypes.Consumer;
type RtpCapabilities = MsTypes.RtpCapabilities;
import { VoiceMember } from '../types';
import {
  applyAudioContextOutput,
  applyAudioElementOutput,
  AUDIO_INPUT_DEVICE_KEY,
  AUDIO_OUTPUT_DEVICE_KEY,
  AudioDeviceOption,
  createMicrophoneConstraints,
  createRemoteAudioOutput,
  isMemberVoiceAudio,
  DEFAULT_AUDIO_DEVICE_ID,
  loadAudioDeviceId,
  saveAudioDeviceId,
  toAudioDeviceOptions,
} from '../audioDevices';
import {
  intervalLossPercent,
  mediaDiagnosticSessionKey,
  shouldAcceptMediaDiagnosticSample,
  statNumber,
  type RtcStat,
  type RtcVideoCounterSample,
  videoCounterRates,
  videoCounterSample,
} from '../mediaDiagnostics';
import {
  applyScreenCaptureConstraints,
  createScreenEncodingPlan,
  toScreenRtpEncoding,
  withScreenEncodingPlan,
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from '../screenCapture';
import { ApplicationAudioPipeline, type ApplicationAudioSource } from '../applicationAudio';

export { SCREEN_PRESETS } from '../screenCapture';
export type { ScreenPreset } from '../screenCapture';
export type Fps = 30 | 60;

export interface MediaStats {
  role: 'sender' | 'receiver' | 'idle';
  rtt: number | null;
  fps: number | null;
  trackFps: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  sendFps: number | null;
  receiveFps: number | null;
  decodeFps: number | null;
  loss: number | null;
  remoteLoss: number | null;
  bitrate: number | null;
  targetBitrate: number | null;
  availableBitrate: number | null;
  retransmitBitrate: number | null;
  jitter: number | null;
  width: number | null;
  height: number | null;
  trackWidth: number | null;
  trackHeight: number | null;
  droppedFrames: number | null;
  encodeTimeMs: number | null;
  decodeTimeMs: number | null;
  averageQp: number | null;
  nackPerSecond: number | null;
  pliPerSecond: number | null;
  firPerSecond: number | null;
  qualityLimitation: string | null;
  qualityLimitationCpuSeconds: number | null;
  qualityLimitationBandwidthSeconds: number | null;
  protocol: string | null;
  codec: string | null;
  encoderImplementation: string | null;
  decoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  powerEfficientDecoder: boolean | null;
  displaySurface: string | null;
  serverIngressBitrate: number | null;
  serverEgressBitrate: number | null;
  serverScore: number | null;
}

const EMPTY_STATS: MediaStats = {
  role: 'idle', rtt: null, fps: null,
  trackFps: null, captureFps: null, encodeFps: null, sendFps: null,
  receiveFps: null, decodeFps: null,
  loss: null, remoteLoss: null, bitrate: null, targetBitrate: null,
  availableBitrate: null, retransmitBitrate: null,
  jitter: null, width: null, height: null, trackWidth: null, trackHeight: null,
  droppedFrames: null, encodeTimeMs: null, decodeTimeMs: null, averageQp: null,
  nackPerSecond: null, pliPerSecond: null, firPerSecond: null,
  qualityLimitation: null, qualityLimitationCpuSeconds: null,
  qualityLimitationBandwidthSeconds: null,
  protocol: null, codec: null,
  encoderImplementation: null, decoderImplementation: null,
  powerEfficientEncoder: null, powerEfficientDecoder: null,
  displaySurface: null,
  serverIngressBitrate: null, serverEgressBitrate: null, serverScore: null,
};

interface ServerRtpDiagnostic {
  bitrateKbps: number | null;
  score: number | null;
}

interface ServerMediaDiagnostics {
  role: 'sender' | 'receiver' | 'idle';
  transports: {
    send?: { rtpRecvBitrateKbps: number | null } | null;
    receive?: { rtpSendBitrateKbps: number | null } | null;
  };
  producers: { stats: ServerRtpDiagnostic[]; score: { score?: number }[] }[];
  consumers: { stats: ServerRtpDiagnostic[]; score: { score?: number; producerScore?: number } }[];
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
interface AvailableScreen {
  socketId: string;
  videoProducerId: string;
  audioProducerId?: string;
}
interface RemoteApplicationAudio {
  socketId: string;
  producerId: string;
  label: string;
}
interface ProcessedMicrophone {
  stream: MediaStream;
  context: AudioContext | null;
}

const MEMBER_VOLUME_KEY = 'cove_member_volumes_v1';
const SCREEN_RECEIVE_VOLUME_KEY = 'cove_screen_receive_volume_v1';
const SCREEN_SHARE_VOLUME_KEY = 'cove_screen_share_volume_v1';
const APPLICATION_AUDIO_SHARE_VOLUME_KEY = 'cove_application_audio_share_volume_v1';
const APPLICATION_AUDIO_RECEIVE_VOLUME_KEY = 'cove_application_audio_receive_volume_v1';

// Chromium 的系统降噪负责处理连续噪声；这个轻量自适应噪声门只在用户不说话时
// 继续衰减残留底噪，让 Opus DTX 能真正进入静音状态。门限会缓慢跟随本机噪声底，
// 并保留 140ms，避免切掉句尾或短暂停顿。
const MIC_NOISE_GATE_WORKLET = `
class CoveMicNoiseGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1;
    this.envelope = 0;
    this.noiseFloor = 0.0035;
    this.holdBlocks = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const firstChannel = input && input[0];
    if (!firstChannel) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    let sumSquares = 0;
    for (let i = 0; i < firstChannel.length; i++) {
      const sample = firstChannel[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, firstChannel.length));
    const envelopeRate = rms > this.envelope ? 0.45 : 0.08;
    this.envelope += (rms - this.envelope) * envelopeRate;

    // 只在低电平区域学习噪声底；正常说话不会把门限越推越高。
    if (rms < 0.035) {
      const learnRate = rms < this.noiseFloor ? 0.08 : 0.002;
      this.noiseFloor += (rms - this.noiseFloor) * learnRate;
      this.noiseFloor = Math.max(0.0008, Math.min(0.018, this.noiseFloor));
    }

    const openThreshold = Math.max(0.0065, this.noiseFloor * 2.2);
    const closeThreshold = openThreshold * 0.68;
    let targetGain;
    if (this.envelope >= openThreshold) {
      this.holdBlocks = Math.ceil(sampleRate * 0.14 / firstChannel.length);
      targetGain = 1;
    } else if (this.holdBlocks > 0) {
      this.holdBlocks -= 1;
      targetGain = 1;
    } else if (this.envelope <= closeThreshold) {
      targetGain = 0.045;
    } else {
      const position = (this.envelope - closeThreshold) / (openThreshold - closeThreshold);
      targetGain = 0.045 + position * 0.955;
    }

    const attack = Math.exp(-1 / (sampleRate * 0.004));
    const release = Math.exp(-1 / (sampleRate * 0.18));
    for (let i = 0; i < firstChannel.length; i++) {
      const smoothing = targetGain > this.gain ? attack : release;
      this.gain = targetGain + (this.gain - targetGain) * smoothing;
      for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
        const source = input[channelIndex] || firstChannel;
        output[channelIndex][i] = source[i] * this.gain;
      }
    }
    return true;
  }
}
registerProcessor('cove-mic-noise-gate', CoveMicNoiseGate);
`;

async function createMicNoiseGate(context: AudioContext): Promise<AudioWorkletNode | null> {
  if (!context.audioWorklet) return null;
  const moduleUrl = URL.createObjectURL(new Blob([MIC_NOISE_GATE_WORKLET], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
    return new AudioWorkletNode(context, 'cove-mic-noise-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
  } catch (error) {
    console.warn('[mic] 自适应降噪模块不可用，继续使用系统降噪', error);
    return null;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function loadNumber(key: string, fallback: number) {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  } catch {
    return fallback;
  }
}

function loadMemberVolumes(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMBER_VOLUME_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) =>
      typeof value === 'number' && Number.isFinite(value)
        ? [[key, Math.max(0, Math.min(2, value))]]
        : []));
  } catch {
    return {};
  }
}

function loadVolumeMap(key: string): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([entryKey, value]) =>
      typeof value === 'number' && Number.isFinite(value)
        ? [[entryKey, Math.max(0, Math.min(1, value))]]
        : []));
  } catch {
    return {};
  }
}

export function useWebRTC(socket: Socket, roomId: string) {
  const [inVoice,      setInVoice]      = useState(false);
  const [isJoining,    setIsJoining]    = useState(false);
  const [isMuted,      setIsMuted]      = useState(false);
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [isSharing,    setIsSharing]    = useState(false);
  const [isApplicationAudioSharing, setIsApplicationAudioSharing] = useState(false);
  const [applicationAudioLabel, setApplicationAudioLabel] = useState<string | null>(null);
  const [screenPreset, setScreenPreset] = useState<ScreenPreset>('720p');
  const [fps,          setFps]          = useState<Fps>(30);
  const [shareAudio,   setShareAudio]   = useState(false);
  const [screenGameMode, setScreenGameMode] = useState(false);
  const [screenNativeResolution, setScreenNativeResolution] = useState(false);
  const [screenActivity, setScreenActivity] = useState<ScreenActivity>('active');
  const [screenEncodingPlan, setScreenEncodingPlan] = useState<ScreenEncodingPlan | null>(null);
  const [screenViewerCount, setScreenViewerCount] = useState(0);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [localScreen,  setLocalScreen]  = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [availableScreens, setAvailableScreens] = useState<AvailableScreen[]>([]);
  const [remoteApplicationAudios, setRemoteApplicationAudios] = useState<RemoteApplicationAudio[]>([]);
  const [watchingScreenPeer, setWatchingScreenPeer] = useState<string | null>(null);
  const [screenReceiveVolume, setScreenReceiveVolumeState] = useState(() => loadNumber(SCREEN_RECEIVE_VOLUME_KEY, 1));
  const [screenShareVolume, setScreenShareVolumeState] = useState(() => loadNumber(SCREEN_SHARE_VOLUME_KEY, 1));
  const [applicationAudioShareVolume, setApplicationAudioShareVolumeState] = useState(() => loadNumber(APPLICATION_AUDIO_SHARE_VOLUME_KEY, 1));
  const [applicationAudioReceiveVolumes, setApplicationAudioReceiveVolumes] = useState<Record<string, number>>(() => loadVolumeMap(APPLICATION_AUDIO_RECEIVE_VOLUME_KEY));
  const [audioInputDevices, setAudioInputDevices] = useState<AudioDeviceOption[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() => loadAudioDeviceId(AUDIO_INPUT_DEVICE_KEY));
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState(() => loadAudioDeviceId(AUDIO_OUTPUT_DEVICE_KEY));
  const [audioDevicesRefreshing, setAudioDevicesRefreshing] = useState(false);
  const [audioInputSwitching, setAudioInputSwitching] = useState(false);
  const [audioDeviceError, setAudioDeviceError] = useState<string | null>(null);

  // 实时统计（帧率 / 延迟 / 丢包），开关控制是否采集
  const [statsEnabled, setStatsEnabled] = useState(false);
  const [stats, setStats] = useState<MediaStats>(EMPTY_STATS);
  // 每个人说话音量 0~1（key = socketId）
  const [speakingLevels, setSpeakingLevels] = useState<Record<string, number>>({});
  // 本机针对每位远端成员的麦克风播放增益，1 = 100% 原始音量，2 = 200%。
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});

  // mediasoup-client 实例
  const deviceRef       = useRef<Device | null>(null);
  const sendTransport   = useRef<Transport | null>(null);
  const recvTransport   = useRef<Transport | null>(null);
  const audioProducer   = useRef<Producer | null>(null);
  const screenProducer  = useRef<Producer | null>(null);
  const screenAudioProducer = useRef<Producer | null>(null); // 共享屏幕时的系统音频
  const applicationAudioProducer = useRef<Producer | null>(null);
  const selfMutedRef    = useRef(false);
  const forceMutedRef   = useRef(false);
  const joiningRef      = useRef(false);
  // 仅在已经建立语音会话后播放本地“离开”提示，避免组件卸载/重复清理时误播。
  const voiceSessionActiveRef = useRef(false);
  const memberVolumesRef = useRef<Record<string, number>>({});
  const rememberedMemberVolumes = useRef<Record<string, number>>(loadMemberVolumes());
  // 点击远端扬声器静音后，记住静音前的音量，恢复时不把用户调好的音量重置为 100%。
  const memberMuteRestoreVolumes = useRef<Record<string, number>>({});
  const voiceMembersRef = useRef<VoiceMember[]>([]);
  const seenVoicePresenceEvents = useRef<string[]>([]);
  const screenReceiveVolumeRef = useRef(screenReceiveVolume);
  const screenShareVolumeRef = useRef(screenShareVolume);
  const applicationAudioShareVolumeRef = useRef(applicationAudioShareVolume);
  const applicationAudioReceiveVolumesRef = useRef(applicationAudioReceiveVolumes);
  const remoteApplicationAudiosRef = useRef<RemoteApplicationAudio[]>([]);
  const selectedAudioInputRef = useRef(selectedAudioInputId);
  const selectedAudioOutputRef = useRef(selectedAudioOutputId);
  // consumerId → { consumer, socketId, kind, sourceType }
  const consumers       = useRef<Map<string, { consumer: Consumer; socketId: string; kind: string; producerId: string; sourceType?: string }>>(new Map());
  // 同一个 producer 只允许创建一个 consumer；同时记录进行中的请求以避免信令竞态。
  const consumerByProducer = useRef<Map<string, string>>(new Map());
  const pendingProducers    = useRef<Set<string>>(new Set());
  // 音频播放元素，按 consumerId 存储（一个人可能同时有麦克风+系统音频两路）
  const audioEls        = useRef<Map<string, HTMLAudioElement>>(new Map());
  // 所有远端音轨（麦克风、屏幕、应用音频）均通过各自的 Web Audio 增益播放。
  // 激活 WebRTC 的媒体元素必须静音，避免原始流绕过增益或双路播放。
  const remoteAudioOutputs = useRef<Map<string, ReturnType<typeof createRemoteAudioOutput>>>(new Map());
  const screenStreams    = useRef<Map<string, MediaStream>>(new Map());
  const localAudioRef   = useRef<MediaStream | null>(null);
  const rawAudioRef     = useRef<MediaStream | null>(null);
  const micProcessingContext = useRef<AudioContext | null>(null);
  const localScreenRef  = useRef<MediaStream | null>(null);
  const screenAudioPipeline = useRef<ApplicationAudioPipeline | null>(null);
  const screenAudioUnsubscribe = useRef<(() => void) | null>(null);
  const applicationAudioPipeline = useRef<ApplicationAudioPipeline | null>(null);
  const applicationAudioUnsubscribe = useRef<(() => void) | null>(null);
  const availableScreensRef = useRef<Map<string, AvailableScreen>>(new Map());
  const pendingScreenAudioByPeer = useRef<Map<string, string>>(new Map());
  const watchingScreenPeerRef = useRef<string | null>(null);
  const screenDemandActiveRef = useRef(false);
  const screenAnalysisTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenAnalysisVideo = useRef<HTMLVideoElement | null>(null);
  const screenAnalysisCanvas = useRef<HTMLCanvasElement | null>(null);
  const previousScreenSample = useRef<Uint8ClampedArray | null>(null);
  const activityCandidate = useRef<{ value: ScreenActivity; count: number }>({ value: 'active', count: 0 });
  const screenActivityRef = useRef<ScreenActivity>('active');

  // 音量分析（Web Audio）
  const audioCtxRef     = useRef<AudioContext | null>(null);
  // key = consumerId 或 'local'；value = { analyser, data, socketId }
  const analysers       = useRef<Map<string, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer>; socketId: string }>>(new Map());
  const volumeTimer     = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsEnabledRef = useRef(false);
  const statsCollecting = useRef(false);
  const videoCounterPrev = useRef<RtcVideoCounterSample | null>(null);
  const receiveLossPrev = useRef<{ lost: number; packets: number } | null>(null);
  const remoteLossPrev = useRef<{ lost: number; packets: number } | null>(null);
  const diagnosticHistory = useRef<{ timestamp: string; stats: MediaStats; trackSettings: MediaTrackSettings | null }[]>([]);

  const setMemberVolume = useCallback((socketId: string, userId: string, volume: number) => {
    // 1.0 = 100% 原始音量，2.0 = 200%（两倍增益）。
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    memberVolumesRef.current = { ...memberVolumesRef.current, [socketId]: normalized };
    setMemberVolumes(memberVolumesRef.current);
    if (userId) {
      rememberedMemberVolumes.current = { ...rememberedMemberVolumes.current, [userId]: normalized };
      try { localStorage.setItem(MEMBER_VOLUME_KEY, JSON.stringify(rememberedMemberVolumes.current)); }
      catch { /* 存储不可用不应阻断本次音量调整。 */ }
    }
    for (const [consumerId, entry] of consumers.current) {
      if (entry.socketId !== socketId || !isMemberVoiceAudio(entry.kind, entry.sourceType)) continue;
      const element = audioEls.current.get(consumerId);
      const output = remoteAudioOutputs.current.get(consumerId);
      if (output) output.setVolume(normalized);
      else if (element) { element.volume = Math.min(1, normalized); element.muted = normalized === 0; }
    }
  }, []);

  const toggleMemberMute = useCallback((socketId: string, userId: string) => {
    const current = memberVolumesRef.current[socketId] ?? 1;
    if (current === 0) {
      const restored = memberMuteRestoreVolumes.current[userId] ?? 1;
      delete memberMuteRestoreVolumes.current[userId];
      setMemberVolume(socketId, userId, restored);
    } else {
      if (userId) memberMuteRestoreVolumes.current[userId] = current;
      setMemberVolume(socketId, userId, 0);
    }
  }, [setMemberVolume]);

  const setScreenReceiveVolume = useCallback((volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    screenReceiveVolumeRef.current = normalized;
    setScreenReceiveVolumeState(normalized);
    try { localStorage.setItem(SCREEN_RECEIVE_VOLUME_KEY, String(normalized)); }
    catch { /* 无法保存偏好也必须应用本次音量。 */ }
    for (const [consumerId, entry] of consumers.current) {
      if (entry.sourceType !== 'screen-audio') continue;
      const element = audioEls.current.get(consumerId);
      if (element) {
        element.volume = normalized;
        element.muted = normalized === 0;
      }
    }
  }, []);

  const setScreenShareVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    screenShareVolumeRef.current = normalized;
    setScreenShareVolumeState(normalized);
    localStorage.setItem(SCREEN_SHARE_VOLUME_KEY, String(normalized));
    screenAudioPipeline.current?.setVolume(normalized);
  }, []);

  const setApplicationAudioShareVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    applicationAudioShareVolumeRef.current = normalized;
    setApplicationAudioShareVolumeState(normalized);
    localStorage.setItem(APPLICATION_AUDIO_SHARE_VOLUME_KEY, String(normalized));
    applicationAudioPipeline.current?.setVolume(normalized);
  }, []);

  const setApplicationAudioReceiveVolume = useCallback((socketId: string, volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    const nextVolumes = { ...applicationAudioReceiveVolumesRef.current, [socketId]: normalized };
    applicationAudioReceiveVolumesRef.current = nextVolumes;
    setApplicationAudioReceiveVolumes(nextVolumes);
    try { localStorage.setItem(APPLICATION_AUDIO_RECEIVE_VOLUME_KEY, JSON.stringify(nextVolumes)); }
    catch { /* 无法保存偏好也必须应用本次音量。 */ }
    for (const [consumerId, entry] of consumers.current) {
      if (entry.socketId !== socketId || entry.sourceType !== 'application-audio') continue;
      const element = audioEls.current.get(consumerId);
      if (element) {
        element.volume = normalized;
        element.muted = normalized === 0;
      }
    }
  }, []);

  const publishRemoteApplicationAudios = useCallback((next: RemoteApplicationAudio[]) => {
    remoteApplicationAudiosRef.current = next;
    setRemoteApplicationAudios(next);
  }, []);

  const storeRemoteApplicationAudio = useCallback((value: RemoteApplicationAudio) => {
    const next = [
      ...remoteApplicationAudiosRef.current.filter(item => item.socketId !== value.socketId),
      value,
    ];
    publishRemoteApplicationAudios(next);
  }, [publishRemoteApplicationAudios]);

  const removeRemoteApplicationAudio = useCallback((socketId: string, producerId?: string) => {
    const next = remoteApplicationAudiosRef.current.filter(item =>
      item.socketId !== socketId || (producerId !== undefined && item.producerId !== producerId));
    if (next.length !== remoteApplicationAudiosRef.current.length)
      publishRemoteApplicationAudios(next);
  }, [publishRemoteApplicationAudios]);

  const clearRemoteApplicationAudios = useCallback(() => {
    if (remoteApplicationAudiosRef.current.length) publishRemoteApplicationAudios([]);
  }, [publishRemoteApplicationAudios]);

  const refreshAudioDevices = useCallback(async (requestPermission = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioDeviceError('当前环境无法读取音频设备。');
      return;
    }
    setAudioDevicesRefreshing(true);
    setAudioDeviceError(null);
    let permissionStream: MediaStream | null = null;
    try {
      if (requestPermission && !rawAudioRef.current) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputDevices(toAudioDeviceOptions(devices, 'audioinput'));
      setAudioOutputDevices(toAudioDeviceOptions(devices, 'audiooutput'));
    } catch (error) {
      setAudioDeviceError(error instanceof Error ? error.message : '读取音频设备失败。');
    } finally {
      permissionStream?.getTracks().forEach(track => track.stop());
      setAudioDevicesRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshAudioDevices(false);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => { refreshAudioDevices(false); };
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshAudioDevices]);

  const selectAudioOutput = useCallback(async (deviceId: string) => {
    const nextDeviceId = deviceId || DEFAULT_AUDIO_DEVICE_ID;
    selectedAudioOutputRef.current = nextDeviceId;
    setSelectedAudioOutputId(nextDeviceId);
    saveAudioDeviceId(AUDIO_OUTPUT_DEVICE_KEY, nextDeviceId);
    setAudioDeviceError(null);

    const changes: Promise<boolean>[] = [];
    audioEls.current.forEach(element => {
      changes.push(applyAudioElementOutput(element, nextDeviceId));
    });
    if (audioCtxRef.current) changes.push(applyAudioContextOutput(audioCtxRef.current, nextDeviceId));
    const results = await Promise.allSettled(changes);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      const reason = rejected.reason;
      setAudioDeviceError(`切换扬声器失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }, []);

  // ── 音量分析工具 ──────────────────────────────────────────────────────────────
  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctx();
      applyAudioContextOutput(audioCtxRef.current, selectedAudioOutputRef.current).catch(error => {
        console.warn('[audio] 提示音切换输出设备失败', error);
      });
    }
    return audioCtxRef.current;
  }, []);

  const playPresenceTone = useCallback((action: 'join' | 'leave') => {
    try {
      const context = ensureAudioCtx();
      context.resume().catch(() => {});
      const frequencies = action === 'join' ? [523.25, 659.25] : [493.88, 392.0];
      const start = context.currentTime;
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = start + index * 0.11;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.13, noteStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.13);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + 0.14);
      });
    } catch { /* 音效失败不影响语音 */ }
  }, [ensureAudioCtx]);

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

  // 分阶段媒体统计：采集 → 编码 → RTP 发送 → SFU → RTP 接收 → 解码。
  // 每个速率都由同一个 RTP 对象的累计计数器求差，避免切换共享或统计对象时出现假低值/假峰值。
  const collectStats = useCallback(async () => {
    if (statsCollecting.current) return;
    statsCollecting.current = true;
    const next: MediaStats = { ...EMPTY_STATS };
    const sendingProducerId = screenProducer.current?.id ?? null;
    const sendingScreen = Boolean(sendingProducerId);
    const watchedPeerId = watchingScreenPeerRef.current;
    const capturedSessionKey = mediaDiagnosticSessionKey(sendingProducerId, watchedPeerId);
    if (!statsEnabledRef.current || !capturedSessionKey) {
      videoCounterPrev.current = null;
      receiveLossPrev.current = null;
      remoteLossPrev.current = null;
      setStats(EMPTY_STATS);
      statsCollecting.current = false;
      return;
    }
    next.role = sendingScreen ? 'sender' : watchedPeerId ? 'receiver' : 'idle';

    try {
      const selectedTransport = sendingScreen
        ? sendTransport.current
        : watchedPeerId ? recvTransport.current : null;
      if (selectedTransport) {
        const report = await selectedTransport.getStats();
        const pairs: RtcStat[] = [];
        report.forEach(stat => {
          const value = stat as unknown as RtcStat;
          if (value.type === 'candidate-pair' && (!value.state || value.state === 'succeeded')) pairs.push(value);
        });
        const pair = pairs.find(value => value.nominated === true || value.selected === true) ?? pairs[0];
        if (pair) {
          if (typeof pair.currentRoundTripTime === 'number')
            next.rtt = Math.round(pair.currentRoundTripTime * 1_000);
          if (sendingScreen && typeof pair.availableOutgoingBitrate === 'number')
            next.availableBitrate = Math.round(pair.availableOutgoingBitrate / 1_000);
          const candidate = report.get(String(pair.localCandidateId ?? '')) as unknown as RtcStat | undefined;
          if (candidate?.protocol) next.protocol = String(candidate.protocol).toUpperCase();
        }
      }

      let videoReport: RTCStatsReport | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      if (screenProducer.current) {
        videoReport = await screenProducer.current.getStats();
        videoTrack = screenProducer.current.track ?? null;
      } else {
        for (const { consumer, kind, socketId } of consumers.current.values()) {
          if (kind !== 'video' || (watchedPeerId && socketId !== watchedPeerId)) continue;
          videoReport = await consumer.getStats();
          videoTrack = consumer.track ?? null;
          break;
        }
      }

      if (videoTrack) {
        const settings = videoTrack.getSettings();
        next.trackFps = typeof settings.frameRate === 'number' ? Math.round(settings.frameRate * 10) / 10 : null;
        next.trackWidth = settings.width ?? null;
        next.trackHeight = settings.height ?? null;
        next.displaySurface = settings.displaySurface ?? null;
      }

      let rtpStat: RtcStat | undefined;
      let remoteInbound: RtcStat | undefined;
      let mediaSource: RtcStat | undefined;
      videoReport?.forEach(stat => {
        const value = stat as unknown as RtcStat;
        const isVideo = !value.kind || value.kind === 'video' || value.mediaType === 'video';
        if (sendingScreen && value.type === 'outbound-rtp' && value.isRemote !== true && isVideo) rtpStat = value;
        if (!sendingScreen && value.type === 'inbound-rtp' && value.isRemote !== true && isVideo) rtpStat = value;
        if (value.type === 'remote-inbound-rtp' && isVideo) remoteInbound = value;
        if (value.type === 'media-source' && isVideo) mediaSource = value;
      });

      if (rtpStat && videoReport) {
        if (rtpStat.mediaSourceId) {
          const linkedSource = videoReport.get(String(rtpStat.mediaSourceId)) as unknown as RtcStat | undefined;
          if (linkedSource) mediaSource = linkedSource;
        }
        const counterStat: RtcStat = {
          ...rtpStat,
          id: `${String(rtpStat.id ?? '')}:${String(mediaSource?.id ?? '')}`,
          framesCaptured: statNumber(mediaSource, 'frames', statNumber(rtpStat, 'framesCaptured')),
        };
        const sample = videoCounterSample(counterStat);
        const rates = videoCounterRates(sample, videoCounterPrev.current);
        videoCounterPrev.current = sample;

        const sourceReportedFps = typeof mediaSource?.framesPerSecond === 'number'
          ? Math.round(mediaSource.framesPerSecond * 10) / 10 : null;
        const rtpReportedFps = typeof rtpStat.framesPerSecond === 'number'
          ? Math.round(rtpStat.framesPerSecond * 10) / 10 : null;
        const hasCaptureCounter = typeof mediaSource?.frames === 'number'
          || typeof rtpStat.framesCaptured === 'number';
        next.captureFps = hasCaptureCounter ? rates.captureFps ?? sourceReportedFps : sourceReportedFps;
        next.encodeFps = typeof rtpStat.framesEncoded === 'number' ? rates.encodeFps : null;
        next.sendFps = typeof rtpStat.framesSent === 'number' ? rates.sendFps : null;
        next.receiveFps = typeof rtpStat.framesReceived === 'number' ? rates.receiveFps : null;
        next.decodeFps = typeof rtpStat.framesDecoded === 'number'
          ? rates.decodeFps ?? (!sendingScreen ? rtpReportedFps : null)
          : !sendingScreen ? rtpReportedFps : null;
        next.fps = sendingScreen
          ? next.sendFps ?? next.encodeFps ?? rtpReportedFps
          : next.decodeFps ?? next.receiveFps ?? rtpReportedFps;
        next.bitrate = rates.bitrateKbps;
        next.retransmitBitrate = rates.retransmitKbps;
        next.encodeTimeMs = rates.encodeTimeMs;
        next.decodeTimeMs = rates.decodeTimeMs;
        next.averageQp = rates.averageQp;
        next.nackPerSecond = rates.nackPerSecond;
        next.pliPerSecond = rates.pliPerSecond;
        next.firPerSecond = rates.firPerSecond;
        next.droppedFrames = typeof rtpStat.framesDropped === 'number' ? rates.droppedFps : null;
        next.width = typeof rtpStat.frameWidth === 'number' ? rtpStat.frameWidth : null;
        next.height = typeof rtpStat.frameHeight === 'number' ? rtpStat.frameHeight : null;
        next.targetBitrate = typeof rtpStat.targetBitrate === 'number'
          ? Math.round(rtpStat.targetBitrate / 1_000) : null;
        next.qualityLimitation = typeof rtpStat.qualityLimitationReason === 'string'
          ? rtpStat.qualityLimitationReason : null;
        const durations = rtpStat.qualityLimitationDurations as RtcStat | undefined;
        next.qualityLimitationCpuSeconds = typeof durations?.cpu === 'number'
          ? Math.round(durations.cpu * 10) / 10 : null;
        next.qualityLimitationBandwidthSeconds = typeof durations?.bandwidth === 'number'
          ? Math.round(durations.bandwidth * 10) / 10 : null;
        next.encoderImplementation = typeof rtpStat.encoderImplementation === 'string'
          ? rtpStat.encoderImplementation : null;
        next.decoderImplementation = typeof rtpStat.decoderImplementation === 'string'
          ? rtpStat.decoderImplementation : null;
        next.powerEfficientEncoder = typeof rtpStat.powerEfficientEncoder === 'boolean'
          ? rtpStat.powerEfficientEncoder : null;
        next.powerEfficientDecoder = typeof rtpStat.powerEfficientDecoder === 'boolean'
          ? rtpStat.powerEfficientDecoder : null;
        if (rtpStat.codecId) {
          const codec = videoReport.get(String(rtpStat.codecId)) as unknown as RtcStat | undefined;
          if (codec?.mimeType) next.codec = String(codec.mimeType).replace(/^video\//i, '').toUpperCase();
        }

        if (sendingScreen && remoteInbound) {
          const lost = statNumber(remoteInbound, 'packetsLost');
          next.remoteLoss = intervalLossPercent(lost, sample.packets, remoteLossPrev.current, true);
          remoteLossPrev.current = { lost, packets: sample.packets };
          if (typeof remoteInbound.roundTripTime === 'number')
            next.rtt = Math.round(remoteInbound.roundTripTime * 1_000);
          if (typeof remoteInbound.jitter === 'number')
            next.jitter = Math.round(remoteInbound.jitter * 1_000);
        } else if (!sendingScreen) {
          const lost = statNumber(rtpStat, 'packetsLost');
          const received = statNumber(rtpStat, 'packetsReceived');
          next.loss = intervalLossPercent(lost, received, receiveLossPrev.current);
          receiveLossPrev.current = { lost, packets: received };
          if (typeof rtpStat.jitter === 'number') next.jitter = Math.round(rtpStat.jitter * 1_000);
        }
      }

      const serverSnapshot = await new Promise<ServerMediaDiagnostics | null>(resolve => {
        socket.timeout(1_500).emit(
          'ms:media-diagnostics', {},
          (error: Error | null, value: ServerMediaDiagnostics) => resolve(error ? null : value),
        );
      });
      if (serverSnapshot?.role === 'sender') {
        const producer = serverSnapshot.producers[0];
        next.serverIngressBitrate = producer?.stats[0]?.bitrateKbps
          ?? serverSnapshot.transports.send?.rtpRecvBitrateKbps ?? null;
        next.serverScore = producer?.stats[0]?.score
          ?? producer?.score?.[0]?.score ?? null;
      } else if (serverSnapshot?.role === 'receiver') {
        const consumer = serverSnapshot.consumers[0];
        next.serverEgressBitrate = consumer?.stats[0]?.bitrateKbps
          ?? serverSnapshot.transports.receive?.rtpSendBitrateKbps ?? null;
        next.serverScore = consumer?.stats[0]?.score
          ?? consumer?.score?.score ?? null;
      }

      const currentSessionKey = mediaDiagnosticSessionKey(
        screenProducer.current?.id ?? null,
        watchingScreenPeerRef.current,
      );
      if (!shouldAcceptMediaDiagnosticSample(
        statsEnabledRef.current,
        capturedSessionKey,
        currentSessionKey,
      )) {
        setStats(EMPTY_STATS);
        return;
      }

      const trackSettings = videoTrack?.getSettings() ?? null;
      const diagnosticEntry = { timestamp: new Date().toISOString(), stats: next, trackSettings };
      // 仅在内存中保留最近 600 个样本，只有手动点击导出才保存文件。
      diagnosticHistory.current.push(diagnosticEntry);
      if (diagnosticHistory.current.length > 600) diagnosticHistory.current.shift();
      setStats(next);
    } catch (error) {
      console.warn('[media-diag] 采集客户端媒体统计失败', error);
    } finally {
      statsCollecting.current = false;
    }
  }, [socket]);

  // stats 开关：打开时每秒采集一次
  const toggleStats = useCallback(() => {
    setStatsEnabled(prev => {
      const next = !prev;
      statsEnabledRef.current = next;
      if (next) {
        if (!statsTimer.current) statsTimer.current = setInterval(() => { collectStats(); }, 1000);
      } else {
        if (statsTimer.current) { clearInterval(statsTimer.current); statsTimer.current = null; }
        receiveLossPrev.current = null;
        remoteLossPrev.current = null;
        videoCounterPrev.current = null;
        setStats(EMPTY_STATS);
      }
      return next;
    });
  }, [collectStats]);

  const exportMediaDiagnostics = useCallback(() => {
    const producer = screenProducer.current;
    const payload = {
      exportedAt: new Date().toISOString(),
      roomId,
      socketId: socket.id ?? null,
      userAgent: navigator.userAgent,
      screen: {
        preset: screenPreset,
        requestedFps: screenGameMode ? 60 : fps,
        gameMode: screenGameMode,
        nativeResolution: screenNativeResolution,
        configuredMaxBitrate: null,
        encodingPlan: screenEncodingPlan,
        trackSettings: producer?.track?.getSettings() ?? null,
        senderParameters: producer?.rtpSender?.getParameters() ?? null,
      },
      samples: diagnosticHistory.current,
    };
    const text = JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? Number(value) : value, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cove-media-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [fps, roomId, screenEncodingPlan, screenGameMode, screenNativeResolution, screenPreset, socket.id]);

  // 卸载时清理所有定时器和音频上下文
  useEffect(() => () => {
    const shouldPlayLeaveTone = voiceSessionActiveRef.current;
    if (shouldPlayLeaveTone) {
      // room 导航时，父组件的清理可能晚于本 hook 的清理；在这里补发本地提示。
      voiceSessionActiveRef.current = false;
      playPresenceTone('leave');
    }
    if (volumeTimer.current) clearInterval(volumeTimer.current);
    if (statsTimer.current) clearInterval(statsTimer.current);
    if (screenAnalysisTimer.current) clearInterval(screenAnalysisTimer.current);
    if (screenAnalysisVideo.current) screenAnalysisVideo.current.srcObject = null;
    remoteAudioOutputs.current.forEach(output => output.close());
    remoteAudioOutputs.current.clear();
    audioEls.current.forEach(element => { element.pause(); element.srcObject = null; });
    audioEls.current.clear();
    const audioContext = audioCtxRef.current;
    if (audioContext) {
      const closeAudioContext = () => {
        if (audioCtxRef.current === audioContext) audioCtxRef.current = null;
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
    void window.coveApplicationAudio?.stop();
  }, [playPresenceTone]);

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
  ): Promise<boolean> => {
    const device = deviceRef.current;
    const rt     = recvTransport.current;
    if (!device || !rt) return false;
    if (consumerByProducer.current.has(producerId)) return true;
    if (pendingProducers.current.has(producerId)) return false;
    pendingProducers.current.add(producerId);

    try {
      const params = await emitAsync<Record<string, unknown>>(socket, 'ms:consume', {
        producerId, rtpCapabilities: device.rtpCapabilities,
      });

      const consumer = await rt.consume(params as never);
      const sourceType = typeof appData?.type === 'string' ? appData.type : undefined;
      consumers.current.set(consumer.id, { consumer, socketId: peerId, kind, producerId, sourceType });
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
        const isVoice = isMemberVoiceAudio(kind, sourceType);
        const memberVolume = memberVolumesRef.current[peerId] ?? 1;
        const volume = sourceType === 'screen-audio'
          ? screenReceiveVolumeRef.current
          : sourceType === 'application-audio'
            ? applicationAudioReceiveVolumesRef.current[peerId] ?? 1
            : memberVolume;
        let usesGainOutput = false;
        if (isVoice) {
          try {
            const context = ensureAudioCtx();
            const output = createRemoteAudioOutput(context, stream, volume);
            remoteAudioOutputs.current.set(consumer.id, output);
            usesGainOutput = true;
            void output.resume().catch(error => {
              console.warn('[audio] 恢复远端音频输出失败，等待下一次点击重试', error);
              document.addEventListener('click', () => {
                if (remoteAudioOutputs.current.get(consumer.id) === output) void output.resume().catch(() => {});
              }, { once: true });
            });
          } catch (error) {
            console.warn('[audio] 创建远端麦克风增益失败，回退到标准音量', error);
          }
        }
        if (!usesGainOutput) {
          // Electron 29 对按需暂停/恢复的屏幕音频通过 MediaStreamAudioSourceNode
          // 播放并不稳定。共享音频使用实际媒体元素作为唯一可听路径；麦克风仅在
          // Web Audio 初始化失败时进入相同的兼容回退。
          const el = new Audio();
          el.autoplay = true;
          el.volume = Math.min(1, volume);
          el.muted = volume === 0;
          el.srcObject = stream;
          audioEls.current.set(consumer.id, el);
          applyAudioElementOutput(el, selectedAudioOutputRef.current).catch(error => {
            console.warn('[audio] 远端音频切换输出设备失败，使用系统默认设备', error);
          }).finally(() => el.play().then(() => {
            if (sourceType === 'screen-audio')
              console.info('[screen-audio] 播放元素已启动', { paused: el.paused, readyState: el.readyState });
          }).catch(error => {
            console.warn('[audio] 自动播放被阻止，等待下一次点击重试', { sourceType, error });
            const resume = () => {
              if (audioEls.current.get(consumer.id) !== el) return;
              void el.play().catch(retryError =>
                console.warn('[audio] 点击后仍无法播放远端音频', { sourceType, error: retryError }));
            };
            document.addEventListener('click', resume, { once: true });
          }));
        }
        // 只对麦克风音频做音量分析（系统音频不计入"说话"）
        if (appData?.type !== 'screen-audio' && appData?.type !== 'application-audio') {
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
        if (sourceType === 'application-audio')
          removeRemoteApplicationAudio(peerId, producerId);
      });
      return true;
    } catch (e) {
      console.error('[mediasoup] consume 失败:', e);
      return false;
    } finally {
      pendingProducers.current.delete(producerId);
    }
  }, [removeRemoteApplicationAudio, socket]);

  const publishAvailableScreens = useCallback(() => {
    setAvailableScreens([...availableScreensRef.current.values()]);
  }, []);

  const storeAvailableScreen = useCallback((value: AvailableScreen) => {
    availableScreensRef.current.set(value.socketId, value);
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const removeAvailableScreen = useCallback((socketId: string, videoProducerId?: string) => {
    const current = availableScreensRef.current.get(socketId);
    if (!current || (videoProducerId && current.videoProducerId !== videoProducerId)) return;
    availableScreensRef.current.delete(socketId);
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const clearAvailableScreens = useCallback(() => {
    availableScreensRef.current.clear();
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const closeLocalConsumer = useCallback((consumerId: string, notifyServer: boolean) => {
    const entry = consumers.current.get(consumerId);
    if (!entry) return;
    consumers.current.delete(consumerId);
    consumerByProducer.current.delete(entry.producerId);
    if (notifyServer) socket.emit('ms:close-consumer', { consumerId });
    entry.consumer.close();
    const el = audioEls.current.get(consumerId);
    if (el) { el.pause(); el.srcObject = null; audioEls.current.delete(consumerId); }
    const output = remoteAudioOutputs.current.get(consumerId);
    if (output) {
      output.close();
      remoteAudioOutputs.current.delete(consumerId);
    }
    detachAnalyser(consumerId);
    if (entry.kind === 'video') {
      screenStreams.current.delete(entry.socketId);
      setRemoteScreen(current => current?.socketId === entry.socketId ? null : current);
    }
  }, [socket]);

  const stopWatchingScreen = useCallback(() => {
    const peerId = watchingScreenPeerRef.current;
    if (!peerId) return;
    for (const [consumerId, entry] of [...consumers.current]) {
      if (entry.socketId !== peerId || (entry.sourceType !== 'screen' && entry.sourceType !== 'screen-audio')) continue;
      closeLocalConsumer(consumerId, true);
    }
    watchingScreenPeerRef.current = null;
    setWatchingScreenPeer(null);
    setRemoteScreen(current => current?.socketId === peerId ? null : current);
    videoCounterPrev.current = null;
    receiveLossPrev.current = null;
    if (!screenProducer.current) setStats(EMPTY_STATS);
  }, [closeLocalConsumer]);

  const watchScreen = useCallback(async (socketId?: string) => {
    const source = socketId
      ? availableScreensRef.current.get(socketId)
      : availableScreensRef.current.values().next().value as AvailableScreen | undefined;
    if (!source || watchingScreenPeerRef.current === source.socketId) return;
    if (watchingScreenPeerRef.current) stopWatchingScreen();

    watchingScreenPeerRef.current = source.socketId;
    setWatchingScreenPeer(source.socketId);
    videoCounterPrev.current = null;
    receiveLossPrev.current = null;
    const videoOk = await consumeProducer(source.videoProducerId, source.socketId, 'video', { type: 'screen' });
    if (!videoOk) {
      watchingScreenPeerRef.current = null;
      setWatchingScreenPeer(null);
      return;
    }
    const latest = availableScreensRef.current.get(source.socketId);
    if (latest?.audioProducerId)
      await consumeProducer(latest.audioProducerId, source.socketId, 'audio', { type: 'screen-audio' });
  }, [consumeProducer, stopWatchingScreen]);

  // ── Socket 事件 ────────────────────────────────────────────────────────────

  useEffect(() => {
    const onVoiceMembers = (list: VoiceMember[]) => {
      voiceMembersRef.current = list;
      const nextVolumes: Record<string, number> = {};
      for (const member of list) {
        nextVolumes[member.socketId] = rememberedMemberVolumes.current[member.userId]
          ?? memberVolumesRef.current[member.socketId]
          ?? 1;
      }
      memberVolumesRef.current = nextVolumes;
      setMemberVolumes(nextVolumes);
      for (const [consumerId, entry] of consumers.current) {
        if (!isMemberVoiceAudio(entry.kind, entry.sourceType)) continue;
        const element = audioEls.current.get(consumerId);
        const volume = nextVolumes[entry.socketId] ?? 1;
        const output = remoteAudioOutputs.current.get(consumerId);
        if (output) output.setVolume(volume);
        else if (element) { element.volume = Math.min(1, volume); element.muted = volume === 0; }
      }
      setVoiceMembers(list);
    };

    const onVoicePresence = ({ eventId, action }: { eventId?: string; action: 'join' | 'leave' }) => {
      if (!deviceRef.current) return;
      if (eventId) {
        if (seenVoicePresenceEvents.current.includes(eventId)) return;
        seenVoicePresenceEvents.current = [...seenVoicePresenceEvents.current.slice(-63), eventId];
      }
      playPresenceTone(action);
    };

    // 服务端通知：有新的 producer（有人加入语音或开始共享）
    const onNewProducer = async ({
      producerId, peerId, kind, appData,
    }: { producerId: string; peerId: string; kind: string; appData: Record<string, unknown> }) => {
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
        if (current)
          storeAvailableScreen({ ...current, audioProducerId: producerId });
        if (watchingScreenPeerRef.current === peerId)
          await consumeProducer(producerId, peerId, kind, appData);
        return;
      }
      if (sourceType === 'application-audio') {
        const consumed = await consumeProducer(producerId, peerId, kind, appData);
        if (consumed) {
          storeRemoteApplicationAudio({
            socketId: peerId,
            producerId,
            label: typeof appData?.label === 'string' && appData.label.trim() ? appData.label : '应用',
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
        watchingScreenPeerRef.current = null;
        setWatchingScreenPeer(null);
        videoCounterPrev.current = null;
        receiveLossPrev.current = null;
        if (!screenProducer.current) setStats(EMPTY_STATS);
      }
      if (entry.sourceType === 'application-audio')
        removeRemoteApplicationAudio(entry.socketId, entry.producerId);
    };

    // 未观看的客户端没有 Consumer，也必须在分享结束时移除“观看共享”入口。
    const onProducerClosed = ({
      producerId, peerId, sourceType,
    }: { producerId: string; peerId: string; sourceType: 'screen' | 'screen-audio' }) => {
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

    const onScreenDemand = ({ sourceType, active, viewerCount }:
      { sourceType: 'screen' | 'screen-audio'; active: boolean; viewerCount: number }) => {
      if (sourceType === 'screen') {
        screenDemandActiveRef.current = active;
        setScreenViewerCount(viewerCount);
        const producer = screenProducer.current;
        if (active) {
          producer?.resume();
          if (producer?.track && producer.appData?.adaptation === 'game') {
            void applyScreenCaptureConstraints(producer.track, {
              fps: 60,
              strictFrameRate: true,
            }).then(result => {
              console.info('[media-diag] 观看恢复后重新应用游戏模式采集约束', {
                mode: result.mode,
                constraints: result.constraints,
                settings: producer.track?.getSettings(),
              });
            }).catch(error => {
              console.warn('[media-diag] 观看恢复后重新应用采集约束失败', error);
            });
          }
        } else producer?.pause();
      } else if (active && !forceMutedRef.current) screenAudioProducer.current?.resume();
      else screenAudioProducer.current?.pause();
    };

    const onUserLeft = ({ socketId }: { socketId: string }) => {
      // 清理该用户所有相关的 consumer / 音频元素 / 音量分析
      for (const [cid, entry] of consumers.current) {
        if (entry.socketId !== socketId) continue;
        const el = audioEls.current.get(cid);
        if (el) { el.pause(); el.srcObject = null; audioEls.current.delete(cid); }
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
      setRemoteScreen(p => p?.socketId === socketId ? null : p);
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
    socket.on('voice:presence',        onVoicePresence);
    socket.on('ms:new-producer',       onNewProducer);
    socket.on('ms:consumer-closed',    onConsumerClosed);
    socket.on('ms:producer-closed',    onProducerClosed);
    socket.on('screen:viewers',        onScreenViewers);
    socket.on('screen:demand',         onScreenDemand);
    socket.on('voice:user-left',       onUserLeft);

    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('voice:presence',        onVoicePresence);
      socket.off('ms:new-producer',       onNewProducer);
      socket.off('ms:consumer-closed',    onConsumerClosed);
      socket.off('ms:producer-closed',    onProducerClosed);
      socket.off('screen:viewers',        onScreenViewers);
      socket.off('screen:demand',         onScreenDemand);
      socket.off('voice:user-left',       onUserLeft);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, inVoice, consumeProducer, closeLocalConsumer, stopWatchingScreen, storeAvailableScreen, removeAvailableScreen, playPresenceTone, storeRemoteApplicationAudio, removeRemoteApplicationAudio]);

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
        if (!selfMutedRef.current) audioProducer.current?.resume();
        if (screenDemandActiveRef.current) screenAudioProducer.current?.resume();
        applicationAudioProducer.current?.resume();
      }
      setIsMuted(muted || selfMutedRef.current);
    };
    socket.on('room:force-muted', onForcedMute);
    return () => { socket.off('room:force-muted', onForcedMute); };
  }, [socket, roomId]);

  const createProcessedMicStream = useCallback(async (rawStream: MediaStream): Promise<ProcessedMicrophone> => {
    if (!/Windows/i.test(navigator.userAgent)) return { stream: rawStream, context: null };
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Ctx({ sampleRate: 48_000, latencyHint: 'interactive' });
    const source = context.createMediaStreamSource(rawStream);
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 72;
    highPass.Q.value = 0.7;

    let tail: AudioNode = highPass;
    source.connect(highPass);
    // 中国电网基频为50Hz，常见电流嗡声还会出现在100/150Hz谐波。
    for (const frequency of [50, 100, 150]) {
      const notch = context.createBiquadFilter();
      notch.type = 'notch';
      notch.frequency.value = frequency;
      notch.Q.value = frequency === 50 ? 18 : 24;
      tail.connect(notch);
      tail = notch;
    }

    const noiseGate = await createMicNoiseGate(context);
    const outputGain = context.createGain();
    outputGain.gain.value = 0.92;
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    if (noiseGate) tail.connect(noiseGate).connect(outputGain).connect(destination);
    else tail.connect(outputGain).connect(destination);
    await context.resume();
    const processedTrack = destination.stream.getAudioTracks()[0];
    if (processedTrack) processedTrack.contentHint = 'speech';
    return { stream: destination.stream, context };
  }, []);

  const requestMicrophone = useCallback(async (deviceId: string) => {
    return Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: createMicrophoneConstraints(deviceId) }),
      new Promise<MediaStream>((_, reject) =>
        setTimeout(() => reject(new Error('getUserMedia 超时（10s）——很可能是麦克风权限被系统/应用挡住')), 10_000)),
    ]);
  }, []);

  const replaceMicrophone = useCallback(async (deviceId: string) => {
    const producer = audioProducer.current;
    if (!producer) return;

    let nextRaw: MediaStream | null = null;
    let nextProcessed: ProcessedMicrophone | null = null;
    try {
      nextRaw = await requestMicrophone(deviceId);
      nextProcessed = await createProcessedMicStream(nextRaw);
      const nextTrack = nextProcessed.stream.getAudioTracks()[0];
      if (!nextTrack) throw new Error('选择的设备没有提供音频轨道');
      nextTrack.contentHint = 'speech';
      await producer.replaceTrack({ track: nextTrack });

      const previousRaw = rawAudioRef.current;
      const previousProcessed = localAudioRef.current;
      const previousContext = micProcessingContext.current;
      rawAudioRef.current = nextRaw;
      localAudioRef.current = nextProcessed.stream;
      micProcessingContext.current = nextProcessed.context;

      detachAnalyser('local');
      attachAnalyser('local', nextProcessed.stream, socket.id ?? 'local');
      previousProcessed?.getTracks().forEach(track => track.stop());
      if (previousRaw && previousRaw !== previousProcessed)
        previousRaw.getTracks().forEach(track => track.stop());
      previousContext?.close().catch(() => {});
      refreshAudioDevices(false);
    } catch (error) {
      nextProcessed?.stream.getTracks().forEach(track => track.stop());
      if (nextRaw && nextRaw !== nextProcessed?.stream)
        nextRaw.getTracks().forEach(track => track.stop());
      nextProcessed?.context?.close().catch(() => {});
      throw error;
    }
  }, [createProcessedMicStream, refreshAudioDevices, requestMicrophone, socket.id]);

  const selectAudioInput = useCallback(async (deviceId: string) => {
    const nextDeviceId = deviceId || DEFAULT_AUDIO_DEVICE_ID;
    const previousDeviceId = selectedAudioInputRef.current;
    if (nextDeviceId === previousDeviceId) return;

    selectedAudioInputRef.current = nextDeviceId;
    setSelectedAudioInputId(nextDeviceId);
    saveAudioDeviceId(AUDIO_INPUT_DEVICE_KEY, nextDeviceId);
    setAudioDeviceError(null);
    if (!inVoice || !audioProducer.current) return;

    setAudioInputSwitching(true);
    try {
      await replaceMicrophone(nextDeviceId);
    } catch (error) {
      selectedAudioInputRef.current = previousDeviceId;
      setSelectedAudioInputId(previousDeviceId);
      saveAudioDeviceId(AUDIO_INPUT_DEVICE_KEY, previousDeviceId);
      setAudioDeviceError(`切换麦克风失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAudioInputSwitching(false);
    }
  }, [inVoice, replaceMicrophone]);

  // ── 加入语音 ───────────────────────────────────────────────────────────────

  const joinVoice = useCallback(async () => {
    if (inVoice || joiningRef.current) return;
    joiningRef.current = true;
    setIsJoining(true);
    console.log('%c[joinVoice] 开始加入语音…', 'color:#3b82f6;font-weight:bold');
    let rawStream: MediaStream | null = null;
    let stream: MediaStream | null = null;
    try {
      console.log('[joinVoice] 请求麦克风权限 getUserMedia…');
      // 超时保护：Electron 权限挂起时 getUserMedia 会永不返回，加 10s 超时把问题暴露出来
      rawStream = await requestMicrophone(selectedAudioInputRef.current);
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
      rawAudioRef.current = rawStream;
      const processed = await createProcessedMicStream(rawStream);
      stream = processed.stream;
      micProcessingContext.current = processed.context;
      localAudioRef.current = stream;
      refreshAudioDevices(false);

      console.log('[joinVoice] 初始化 mediasoup Device 和传输通道…');
      const ok = await setupDevice();
      if (!ok) {
        stream.getTracks().forEach(t => t.stop());
        if (rawStream !== stream) rawStream.getTracks().forEach(t => t.stop());
        localAudioRef.current = null;
        rawAudioRef.current = null;
        micProcessingContext.current?.close().catch(() => {});
        micProcessingContext.current = null;
        return;
      }
      console.log('%c[joinVoice] [OK] Device 就绪，开始发布音频', 'color:#22c55e');

      // 发布音频（标记 type:mic 以区分系统音频）
      const producer = await sendTransport.current!.produce({
        track:   stream.getAudioTracks()[0],
        codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
        appData: { type: 'mic' },
      });
      audioProducer.current = producer;
      if (forceMutedRef.current) producer.pause();
      producer.on('trackended', () => { /* 麦克风被拔 */ });

      // 本地麦克风音量分析（显示在自己名字旁）
      attachAnalyser('local', stream, socket.id ?? 'local');
      startMeters();

      voiceSessionActiveRef.current = true;
      setInVoice(true);
      socket.emit('voice:join', roomId);

      // 消费已经在频道里的人的 producer
      const existing = await emitAsync<
        { producerId: string; peerId: string; kind: string; appData: Record<string, unknown> }[]
      >(socket, 'ms:get-producers');

      for (const source of existing) {
        if (source.appData?.type === 'screen-audio')
          pendingScreenAudioByPeer.current.set(source.peerId, source.producerId);
      }
      for (const { producerId, peerId, kind, appData } of existing) {
        if (appData?.type === 'screen') {
          storeAvailableScreen({
            socketId: peerId,
            videoProducerId: producerId,
            audioProducerId: pendingScreenAudioByPeer.current.get(peerId),
          });
          continue;
        }
        if (appData?.type === 'screen-audio') continue;
        if (appData?.type === 'application-audio') {
          const consumed = await consumeProducer(producerId, peerId, kind, appData);
          if (consumed) {
            storeRemoteApplicationAudio({
              socketId: peerId,
              producerId,
              label: typeof appData.label === 'string' && appData.label.trim() ? appData.label : '应用',
            });
          }
          continue;
        }
        await consumeProducer(producerId, peerId, kind, appData);
      }
      console.log('%c[joinVoice] [OK] 加入语音完成', 'color:#22c55e;font-weight:bold');
    } catch (e) {
      stream?.getTracks().forEach(track => track.stop());
      if (rawStream !== stream) rawStream?.getTracks().forEach(track => track.stop());
      if (localAudioRef.current === stream) localAudioRef.current = null;
      rawAudioRef.current = null;
      micProcessingContext.current?.close().catch(() => {});
      micProcessingContext.current = null;
      console.error('[joinVoice] [ERROR] 失败:', e);
      alert(`加入语音失败：\n${e instanceof Error ? e.message : String(e)}\n\n请检查麦克风权限（Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问）。`);
    } finally {
      joiningRef.current = false;
      setIsJoining(false);
    }
  }, [socket, roomId, inVoice, setupDevice, consumeProducer, storeAvailableScreen, storeRemoteApplicationAudio, createProcessedMicStream, refreshAudioDevices, requestMicrophone]);

  // ── 离开语音 ───────────────────────────────────────────────────────────────

  const leaveVoice = useCallback(() => {
    const shouldPlayLeaveTone = voiceSessionActiveRef.current;
    voiceSessionActiveRef.current = false;
    if (shouldPlayLeaveTone) playPresenceTone('leave');
    joiningRef.current = false;
    setIsJoining(false);
    audioProducer.current?.close();       audioProducer.current       = null;
    screenProducer.current?.close();      screenProducer.current      = null;
    screenAudioProducer.current?.close(); screenAudioProducer.current = null;
    applicationAudioProducer.current?.close(); applicationAudioProducer.current = null;
    sendTransport.current?.close();       sendTransport.current       = null;
    recvTransport.current?.close();       recvTransport.current       = null;
    deviceRef.current = null;

    localAudioRef.current?.getTracks().forEach(t => t.stop());
    localAudioRef.current = null;
    rawAudioRef.current?.getTracks().forEach(t => t.stop());
    rawAudioRef.current = null;
    micProcessingContext.current?.close().catch(() => {});
    micProcessingContext.current = null;
    screenAudioUnsubscribe.current?.();
    screenAudioUnsubscribe.current = null;
    screenAudioPipeline.current?.close();
    screenAudioPipeline.current = null;
    void window.coveScreenAudio?.stop();
    applicationAudioUnsubscribe.current?.();
    applicationAudioUnsubscribe.current = null;
    applicationAudioPipeline.current?.close();
    applicationAudioPipeline.current = null;
    void window.coveApplicationAudio?.stop();
    setIsApplicationAudioSharing(false);
    setApplicationAudioLabel(null);
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    localScreenRef.current = null;
    setLocalScreen(null);
    if (screenAnalysisTimer.current) clearInterval(screenAnalysisTimer.current);
    screenAnalysisTimer.current = null;
    if (screenAnalysisVideo.current) screenAnalysisVideo.current.srcObject = null;
    screenAnalysisVideo.current = null;
    screenAnalysisCanvas.current = null;
    previousScreenSample.current = null;

    consumers.current.forEach(({ consumer }) => consumer.close());
    consumers.current.clear();
    consumerByProducer.current.clear();
    pendingProducers.current.clear();

    audioEls.current.forEach(el => { el.pause(); el.srcObject = null; });
    audioEls.current.clear();
    remoteAudioOutputs.current.forEach(output => output.close());
    remoteAudioOutputs.current.clear();
    screenStreams.current.clear();

    // 停止音量计和统计
    stopMeters();
    analysers.current.clear();
    receiveLossPrev.current = null;
    remoteLossPrev.current = null;
    videoCounterPrev.current = null;
    setStats(EMPTY_STATS);

    setRemoteScreen(null);
    clearAvailableScreens();
    clearRemoteApplicationAudios();
    pendingScreenAudioByPeer.current.clear();
    watchingScreenPeerRef.current = null;
    setWatchingScreenPeer(null);
    screenDemandActiveRef.current = false;
    setScreenViewerCount(0);
    setScreenEncodingPlan(null);
    setInVoice(false);
    voiceMembersRef.current = [];
    setVoiceMembers([]);
    selfMutedRef.current = false;
    setIsMuted(forceMutedRef.current);
    setIsSharing(false);
    socket.emit('voice:leave', roomId);
  }, [socket, roomId, stopMeters, clearAvailableScreens, playPresenceTone]);

  // ── 麦克风静音 ─────────────────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const producer = audioProducer.current;
    if (!producer || forceMutedRef.current) return;
    selfMutedRef.current = !selfMutedRef.current;
    if (selfMutedRef.current) producer.pause();
    else producer.resume();
    setIsMuted(selfMutedRef.current);
    socket.emit('voice:mute-state', { roomId, muted: selfMutedRef.current });
  }, [socket, roomId]);

  // ── 屏幕共享 ───────────────────────────────────────────────────────────────

  const stopScreenAnalysis = useCallback(() => {
    if (screenAnalysisTimer.current) clearInterval(screenAnalysisTimer.current);
    screenAnalysisTimer.current = null;
    if (screenAnalysisVideo.current) {
      screenAnalysisVideo.current.pause();
      screenAnalysisVideo.current.srcObject = null;
    }
    screenAnalysisVideo.current = null;
    screenAnalysisCanvas.current = null;
    previousScreenSample.current = null;
    activityCandidate.current = { value: 'active', count: 0 };
  }, []);

  const applyScreenActivity = useCallback((
    preset: ScreenPreset,
    maxFps: Fps,
    activity: ScreenActivity,
    strictFrameRate = false,
    nativeResolution = false,
  ) => {
    const producer = screenProducer.current;
    const track = producer?.track ?? localScreenRef.current?.getVideoTracks()[0];
    const settings = track?.getSettings();
    const plan = createScreenEncodingPlan({
      preset,
      maxFps,
      activity,
      sourceWidth: settings?.width,
      sourceHeight: settings?.height,
      nativeResolution,
    });
    screenActivityRef.current = activity;
    setScreenActivity(activity);
    setScreenEncodingPlan(plan);
    if (track) {
      track.contentHint = plan.contentHint;
      void applyScreenCaptureConstraints(track, {
        fps: plan.fps,
        strictFrameRate: strictFrameRate && plan.fps === 60,
      }).then(result => {
        console.info('[media-diag] 已应用屏幕采集帧率约束', {
          activity,
          mode: result.mode,
          constraints: result.constraints,
          settings: track.getSettings(),
        });
      }).catch(error => {
        console.warn('[media-diag] 更新屏幕采集帧率约束失败', error);
      });
    }
    if (!producer) return;
    if (producer.track) producer.track.contentHint = plan.contentHint;
    try {
      const currentParameters = producer.rtpSender?.getParameters();
      if (!currentParameters) return;
      const params = withScreenEncodingPlan(currentParameters, plan);
      producer.rtpSender?.setParameters(params).then(() => {
        console.info('[media-diag] 已应用屏幕编码参数', {
          activity,
          source: `${plan.sourceWidth}x${plan.sourceHeight}`,
          outputLimit: `${plan.outputWidth}x${plan.outputHeight}`,
          scaleResolutionDownBy: plan.scaleResolutionDownBy,
          requestedFps: plan.fps,
          configuredMaxBitrate: null,
          parameters: producer.rtpSender?.getParameters(),
        });
      }).catch(error => {
        console.warn('[media-diag] 应用屏幕编码参数失败', error);
      });
    } catch (error) {
      console.warn('[media-diag] 读取屏幕编码参数失败', error);
    }
  }, []);

  /**
   * mediasoup 不读取视频像素，因此在发送端把画面缩到 160×90，每秒比较一次
   * 亮度变化。连续静止后降到 15fps；滚动/普通操作用 30fps；大面积变化时才
   * 使用用户选择的最高 60fps。采样只有约 1.4 万像素，开销远低于视频编码。
   */
  const startScreenAnalysis = useCallback((stream: MediaStream, preset: ScreenPreset, maxFps: Fps, nativeResolution: boolean) => {
    stopScreenAnalysis();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(stream.getVideoTracks());
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    screenAnalysisVideo.current = video;
    screenAnalysisCanvas.current = canvas;
    video.play().catch(() => {});
    applyScreenActivity(preset, maxFps, 'active', false, nativeResolution);

    screenAnalysisTimer.current = setInterval(() => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const current = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const previous = previousScreenSample.current;
        previousScreenSample.current = current;
        if (!previous || previous.length !== current.length) return;

        let changed = 0;
        let sampled = 0;
        // 每隔一个像素采样；通过 RGB 的近似亮度差过滤编码噪点和光标闪烁。
        for (let index = 0; index < current.length; index += 8) {
          const nowLuma = current[index] * 3 + current[index + 1] * 6 + current[index + 2];
          const oldLuma = previous[index] * 3 + previous[index + 1] * 6 + previous[index + 2];
          if (Math.abs(nowLuma - oldLuma) > 160) changed += 1;
          sampled += 1;
        }
        const changedRatio = sampled ? changed / sampled : 0;
        const next: ScreenActivity = changedRatio < 0.004
          ? 'static'
          : changedRatio > 0.12 ? 'motion' : 'active';

        if (activityCandidate.current.value === next) activityCandidate.current.count += 1;
        else activityCandidate.current = { value: next, count: 1 };

        // 动态画面立即升档；普通操作需连续2次；静止需连续4秒，防止频繁抖动。
        const required = next === 'motion' ? 1 : next === 'active' ? 2 : 4;
        if (activityCandidate.current.count >= required && screenActivityRef.current !== next)
          applyScreenActivity(preset, maxFps, next, false, nativeResolution);
      } catch { /* 采样失败不影响共享本身 */ }
    }, 1_000);
  }, [applyScreenActivity, stopScreenAnalysis]);

  const startScreenShare = useCallback(async (
    initPreset?: ScreenPreset, initFps?: Fps, initAudio?: boolean, initGameMode?: boolean,
    initNativeResolution?: boolean,
  ) => {
    if (!inVoice || isSharing) return;
    const preset     = initPreset  ?? screenPreset;
    const gameMode   = initGameMode ?? screenGameMode;
    const nativeResolution = initNativeResolution ?? screenNativeResolution;
    const currentFps: Fps = gameMode ? 60 : (initFps ?? fps);
    const audio      = initAudio   ?? shareAudio;
    if (initPreset  !== undefined) setScreenPreset(initPreset);
    if (initFps     !== undefined || gameMode) setFps(currentFps);
    if (initAudio   !== undefined) setShareAudio(initAudio);
    if (initGameMode !== undefined) setScreenGameMode(initGameMode);
    if (initNativeResolution !== undefined) setScreenNativeResolution(initNativeResolution);

    // System-audio sharing must use the native process-exclusion bridge so
    // Cove's own voice and sound-pack playback can never enter the stream.
    // There is intentionally no full-system/browser fallback.
    if (audio && !window.coveScreenAudio) {
      window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
      return;
    }

    const initialActivity: ScreenActivity = gameMode ? 'motion' : 'active';
    let acquiredStream: MediaStream | null = null;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // 桌面源保持原始尺寸，720p/1080p 由 RTP 编码缩放统一控制。
        video: { frameRate: { ideal: currentFps, max: currentFps } },
        // The native Windows bridge supplies the filtered system audio as a
        // separate track. Chromium's global loopback track is never requested,
        // because it would include Cove's own playback.
        audio: false,
      });
      acquiredStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('没有取得屏幕视频轨道');
      videoTrack.contentHint = gameMode ? 'motion' : 'detail';
      const captureConstraints = await applyScreenCaptureConstraints(videoTrack, {
        fps: currentFps,
        strictFrameRate: gameMode,
      });
      const trackSettings = videoTrack.getSettings();
      const initialPlan = createScreenEncodingPlan({
        preset,
        maxFps: currentFps,
        activity: initialActivity,
        sourceWidth: trackSettings.width,
        sourceHeight: trackSettings.height,
        nativeResolution,
      });
      console.info('[media-diag] 屏幕采集已开始', {
        requested: {
          preset,
          outputLimit: `${initialPlan.outputWidth}x${initialPlan.outputHeight}`,
          fps: currentFps,
          gameMode,
        },
        constraintMode: captureConstraints.mode,
        strictConstraintError: captureConstraints.strictError
          ? String(captureConstraints.strictError) : null,
        settings: trackSettings,
        constraints: videoTrack.getConstraints(),
        capabilities: videoTrack.getCapabilities(),
      });
      localScreenRef.current = stream;
      setLocalScreen(stream);
      videoCounterPrev.current = null;
      remoteLossPrev.current = null;

      const negotiatedCodecs = deviceRef.current?.rtpCapabilities.codecs ?? [];
      const codecCandidates = ['video/av1', 'video/vp9']
        .map(mimeType => negotiatedCodecs.find(codec => codec.mimeType.toLowerCase() === mimeType))
        .filter((codec): codec is NonNullable<typeof codec> => Boolean(codec));

      // 直接发送实际应用采集约束的轨道。旧实现 clone() 后继续只约束原轨道，
      // 会让 Producer 的轨道停留在 Chromium 自行选择的低采集帧率。
      let producer: Producer | null = null;
      let lastProduceError: unknown = null;
      for (const codec of [...codecCandidates, undefined]) {
        try {
          producer = await sendTransport.current!.produce({
            track: videoTrack,
            appData: {
              type: 'screen',
              adaptation: gameMode ? 'game' : 'content',
              preset,
              nativeResolution,
              maxFps: currentFps,
              outputWidth: initialPlan.outputWidth,
              outputHeight: initialPlan.outputHeight,
              preferredCodec: codec?.mimeType ?? 'auto',
            },
            encodings: [toScreenRtpEncoding(initialPlan)],
            // 初始带宽估计（kbps），不是上限；与 SFU 启动估计一致，之后由拥塞控制调整。
            codecOptions: { videoGoogleStartBitrate: 10_000 },
            ...(codec ? { codec } : {}),
            stopTracks: false,
            disableTrackOnPause: false,
            zeroRtpOnPause: true,
          });
          console.info(`[screen share] 编码器：${codec?.mimeType ?? '浏览器自动选择'}`);
          break;
        } catch (error) {
          lastProduceError = error;
          console.warn(`[screen share] ${codec?.mimeType ?? '自动 codec'} 编码失败，尝试回退`, error);
        }
      }
      if (!producer) throw lastProduceError ?? new Error('没有可用的屏幕共享视频编码器');
      screenProducer.current = producer;
      if (!screenDemandActiveRef.current) producer.pause();
      applyScreenActivity(preset, currentFps, initialActivity, gameMode, nativeResolution);
      if (gameMode) stopScreenAnalysis();
      else startScreenAnalysis(stream, preset, currentFps, nativeResolution);

      // Electron's global `loopback` source captures Cove's own voice and
      // sound-pack playback as well as other desktop audio. The Windows client
      // therefore uses only the native process-loopback capture in exclude
      // mode (Cove's process tree is removed at the WASAPI level).
      if (audio) {
        const bridge = window.coveScreenAudio;
        if (!bridge) throw new Error('无法启动排除 Cove 音频的系统捕获。');
        let pipeline: ApplicationAudioPipeline | null = null;
        let unsubscribe: (() => void) | null = null;
        try {
          // Keep the captured pipeline in a stable closure. Do not clear this
          // local after transferring ownership to the ref: the IPC listener
          // remains active for the whole share and must continue forwarding
          // every PCM chunk to the same MediaStream destination.
          const audioPipeline = new ApplicationAudioPipeline(screenShareVolumeRef.current);
          pipeline = audioPipeline;
          await audioPipeline.resume();
          unsubscribe = bridge.onChunk(chunk => audioPipeline.pushPcm(chunk));
          const capture = await bridge.start();
          if (!capture?.ok) throw new Error(capture?.error ?? '无法启动排除 Cove 音频的系统捕获。');

          const ap = await sendTransport.current!.produce({
            track: audioPipeline.track,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
            appData: { type: 'screen-audio' },
            disableTrackOnPause: true,
            zeroRtpOnPause: true,
          });
          screenAudioPipeline.current = audioPipeline;
          screenAudioUnsubscribe.current = unsubscribe;
          unsubscribe = null;
          screenAudioProducer.current = ap;
          if (forceMutedRef.current || !screenDemandActiveRef.current) ap.pause();
        } catch (e) {
          unsubscribe?.();
          pipeline?.close();
          await bridge.stop().catch(() => false);
          console.warn('[screen share] 排除 Cove 后的系统音频发布失败:', e);
          window.alert('屏幕画面已开始共享，但系统音频发布失败。请停止共享后重试。');
        }
      }

      setIsSharing(true);

      // 用户在浏览器 UI 点"停止共享"
      stream.getVideoTracks()[0].onended = () => stopScreenShare();
    } catch (e) {
      console.error('[screen share]', e);
      stopScreenAnalysis();
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
      screenAudioUnsubscribe.current?.();
      screenAudioUnsubscribe.current = null;
      screenAudioPipeline.current?.close();
      screenAudioPipeline.current = null;
      await window.coveScreenAudio?.stop();
      acquiredStream?.getTracks().forEach(track => track.stop());
      if (localScreenRef.current === acquiredStream) localScreenRef.current = null;
      setLocalScreen(null);
      setIsSharing(false);
      setScreenEncodingPlan(null);
      if (!(e instanceof DOMException && e.name === 'NotAllowedError'))
        window.alert(`无法开始屏幕共享：${e instanceof Error ? e.message : String(e)}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId, inVoice, isSharing, screenPreset, fps, shareAudio, screenGameMode, screenNativeResolution, applyScreenActivity, startScreenAnalysis, stopScreenAnalysis]);

  const stopScreenShare = useCallback(() => {
    stopScreenAnalysis();
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
    screenAudioUnsubscribe.current?.();
    screenAudioUnsubscribe.current = null;
    screenAudioPipeline.current?.close();
    screenAudioPipeline.current = null;
    void window.coveScreenAudio?.stop();
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    localScreenRef.current = null;
    setLocalScreen(null);
    setIsSharing(false);
    screenDemandActiveRef.current = false;
    setScreenViewerCount(0);
    setScreenActivity('active');
    screenActivityRef.current = 'active';
    setScreenEncodingPlan(null);
    videoCounterPrev.current = null;
    remoteLossPrev.current = null;
    if (!watchingScreenPeerRef.current) setStats(EMPTY_STATS);
  }, [clearAvailableScreens, clearRemoteApplicationAudios, socket, stopScreenAnalysis]);

  const stopApplicationAudioShare = useCallback(() => {
    const producer = applicationAudioProducer.current;
    if (producer) {
      socket.emit('ms:close-producer', { producerId: producer.id });
      producer.close();
      applicationAudioProducer.current = null;
    }
    applicationAudioUnsubscribe.current?.();
    applicationAudioUnsubscribe.current = null;
    applicationAudioPipeline.current?.close();
    applicationAudioPipeline.current = null;
    void window.coveApplicationAudio?.stop();
    setIsApplicationAudioSharing(false);
    setApplicationAudioLabel(null);
  }, [socket]);

  const startApplicationAudioShare = useCallback(async (source: ApplicationAudioSource) => {
    if (!inVoice || applicationAudioProducer.current) return;
    const bridge = window.coveApplicationAudio;
    if (!bridge) {
      window.alert('应用音频共享仅可在 Windows 桌面版中使用。');
      return;
    }
    let pipeline: ApplicationAudioPipeline | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      pipeline = new ApplicationAudioPipeline(applicationAudioShareVolumeRef.current);
      await pipeline.resume();
      unsubscribe = bridge.onChunk(chunk => pipeline?.pushPcm(chunk));
      const capture = await bridge.start(source.id);
      if (!capture.ok) throw new Error(capture.error ?? '无法开始应用音频捕获。');
      const producer = await sendTransport.current!.produce({
        track: pipeline.track,
        codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
        appData: { type: 'application-audio', label: source.name, processId: source.processId },
        disableTrackOnPause: true,
        zeroRtpOnPause: true,
      });
      applicationAudioPipeline.current = pipeline;
      applicationAudioUnsubscribe.current = unsubscribe;
      applicationAudioProducer.current = producer;
      if (forceMutedRef.current) producer.pause();
      setApplicationAudioLabel(source.name);
      setIsApplicationAudioSharing(true);
    } catch (error) {
      unsubscribe?.();
      pipeline?.close();
      await bridge.stop().catch(() => false);
      console.error('[application-audio] 分享失败', error);
      window.alert(`无法共享应用音频：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [inVoice]);

  const toggleShareAudio = useCallback(() => setShareAudio(p => !p), []);

  return {
    inVoice, isJoining, isMuted, isForceMuted, isSharing,
    screenPreset, fps, shareAudio, screenGameMode, screenNativeResolution,
    isApplicationAudioSharing, applicationAudioLabel, applicationAudioShareVolume,
    screenActivity, screenEncodingPlan, screenViewerCount,
    voiceMembers,
    localScreen,
    remoteScreen,        // { socketId, stream: MediaStream } | null
    availableScreens,
    remoteApplicationAudios,
    watchingScreenPeerId: watchingScreenPeer,
    isWatchingScreen: !!watchingScreenPeer,
    joinVoice, leaveVoice, toggleMute,
    startScreenShare, stopScreenShare,
    startApplicationAudioShare, stopApplicationAudioShare, setApplicationAudioShareVolume,
    watchScreen, stopWatchingScreen, toggleShareAudio,
    // 新增：实时统计 + 音量
    stats, statsEnabled, toggleStats, exportMediaDiagnostics,
    speakingLevels,      // socketId → 0~1
    memberVolumes, setMemberVolume, toggleMemberMute,
    screenReceiveVolume, setScreenReceiveVolume,
    screenShareVolume, setScreenShareVolume,
    applicationAudioReceiveVolumes, setApplicationAudioReceiveVolume,
    audioInputDevices, audioOutputDevices,
    selectedAudioInputId, selectedAudioOutputId,
    audioDevicesRefreshing, audioInputSwitching, audioDeviceError,
    refreshAudioDevices, selectAudioInput, selectAudioOutput,
    playPresenceTone,
    localSocketId: socket.id,
  };
}
