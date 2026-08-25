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
  DEFAULT_AUDIO_DEVICE_ID,
  loadAudioDeviceId,
  saveAudioDeviceId,
  toAudioDeviceOptions,
} from '../audioDevices';

// 普通模式下分辨率只决定上限，实际帧率和码率由本地画面变化检测自动选择；
// 游戏模式会固定使用所选分辨率档位的 60fps 最高码率配置。
export const SCREEN_PRESETS = {
  '540p':  { label: '540p 流畅',  width: 960,  height: 540,  staticBitrate: 350_000, activeBitrate:   600_000, motionBitrate60: 1_000_000 },
  '720p':  { label: '720p 均衡',  width: 1280, height: 720,  staticBitrate: 650_000, activeBitrate: 1_100_000, motionBitrate60: 1_800_000 },
  '1080p': { label: '1080p 清晰', width: 1920, height: 1080, staticBitrate: 1_100_000, activeBitrate: 2_000_000, motionBitrate60: 3_200_000 },
} as const;
export type ScreenPreset = keyof typeof SCREEN_PRESETS;
export type Fps = 30 | 60;
export type ScreenActivity = 'static' | 'active' | 'motion';

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
  codec: string | null;
}

const EMPTY_STATS: MediaStats = {
  rtt: null, fps: null, loss: null, bitrate: null, availableBitrate: null,
  jitter: null, width: null, height: null, droppedFrames: null,
  qualityLimitation: null, protocol: null, codec: null,
};

function screenProfile(preset: ScreenPreset, maxFps: Fps, activity: ScreenActivity) {
  const profile = SCREEN_PRESETS[preset];
  if (activity === 'static') return { fps: 15, bitrate: profile.staticBitrate };
  if (activity === 'motion' && maxFps === 60)
    return { fps: 60, bitrate: profile.motionBitrate60 };
  return { fps: 30, bitrate: profile.activeBitrate };
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
interface ProcessedMicrophone {
  stream: MediaStream;
  context: AudioContext | null;
}

const MEMBER_VOLUME_KEY = 'cove_member_volumes_v1';
const SCREEN_RECEIVE_VOLUME_KEY = 'cove_screen_receive_volume_v1';
const SCREEN_SHARE_VOLUME_KEY = 'cove_screen_share_volume_v1';

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
        ? [[key, Math.max(0, Math.min(1, value))]]
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
  const [screenPreset, setScreenPreset] = useState<ScreenPreset>('720p');
  const [fps,          setFps]          = useState<Fps>(30);
  const [shareAudio,   setShareAudio]   = useState(false);
  const [screenGameMode, setScreenGameMode] = useState(false);
  const [screenActivity, setScreenActivity] = useState<ScreenActivity>('active');
  const [screenTargetBitrate, setScreenTargetBitrate] = useState(0);
  const [screenViewerCount, setScreenViewerCount] = useState(0);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [localScreen,  setLocalScreen]  = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [availableScreens, setAvailableScreens] = useState<AvailableScreen[]>([]);
  const [watchingScreenPeer, setWatchingScreenPeer] = useState<string | null>(null);
  const [screenReceiveVolume, setScreenReceiveVolumeState] = useState(() => loadNumber(SCREEN_RECEIVE_VOLUME_KEY, 1));
  const [screenShareVolume, setScreenShareVolumeState] = useState(() => loadNumber(SCREEN_SHARE_VOLUME_KEY, 1));
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
  // 本机针对每位远端成员的麦克风播放音量，1 = 100%。
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});

  // mediasoup-client 实例
  const deviceRef       = useRef<Device | null>(null);
  const sendTransport   = useRef<Transport | null>(null);
  const recvTransport   = useRef<Transport | null>(null);
  const audioProducer   = useRef<Producer | null>(null);
  const screenProducer  = useRef<Producer | null>(null);
  const screenAudioProducer = useRef<Producer | null>(null); // 共享屏幕时的系统音频
  const selfMutedRef    = useRef(false);
  const forceMutedRef   = useRef(false);
  const joiningRef      = useRef(false);
  const memberVolumesRef = useRef<Record<string, number>>({});
  const rememberedMemberVolumes = useRef<Record<string, number>>(loadMemberVolumes());
  const voiceMembersRef = useRef<VoiceMember[]>([]);
  const screenReceiveVolumeRef = useRef(screenReceiveVolume);
  const screenShareVolumeRef = useRef(screenShareVolume);
  const selectedAudioInputRef = useRef(selectedAudioInputId);
  const selectedAudioOutputRef = useRef(selectedAudioOutputId);
  // consumerId → { consumer, socketId, kind, sourceType }
  const consumers       = useRef<Map<string, { consumer: Consumer; socketId: string; kind: string; producerId: string; sourceType?: string }>>(new Map());
  // 同一个 producer 只允许创建一个 consumer；同时记录进行中的请求以避免信令竞态。
  const consumerByProducer = useRef<Map<string, string>>(new Map());
  const pendingProducers    = useRef<Set<string>>(new Set());
  // 音频播放元素，按 consumerId 存储（一个人可能同时有麦克风+系统音频两路）
  const audioEls        = useRef<Map<string, HTMLAudioElement>>(new Map());
  const screenStreams    = useRef<Map<string, MediaStream>>(new Map());
  const localAudioRef   = useRef<MediaStream | null>(null);
  const rawAudioRef     = useRef<MediaStream | null>(null);
  const micProcessingContext = useRef<AudioContext | null>(null);
  const localScreenRef  = useRef<MediaStream | null>(null);
  const screenAudioContext = useRef<AudioContext | null>(null);
  const screenAudioGain = useRef<GainNode | null>(null);
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
  const lossPrev        = useRef<{ lost: number; recv: number } | null>(null);
  const videoBytesPrev  = useRef<{ bytes: number; timestamp: number } | null>(null);

  const setMemberVolume = useCallback((socketId: string, userId: string, volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    memberVolumesRef.current = { ...memberVolumesRef.current, [socketId]: normalized };
    setMemberVolumes(memberVolumesRef.current);
    if (userId) {
      rememberedMemberVolumes.current = { ...rememberedMemberVolumes.current, [userId]: normalized };
      localStorage.setItem(MEMBER_VOLUME_KEY, JSON.stringify(rememberedMemberVolumes.current));
    }
    for (const [consumerId, entry] of consumers.current) {
      if (entry.socketId !== socketId || entry.kind !== 'audio' || entry.sourceType === 'screen-audio') continue;
      const element = audioEls.current.get(consumerId);
      if (element) element.volume = normalized;
    }
  }, []);

  const setScreenReceiveVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    screenReceiveVolumeRef.current = normalized;
    setScreenReceiveVolumeState(normalized);
    localStorage.setItem(SCREEN_RECEIVE_VOLUME_KEY, String(normalized));
    for (const [consumerId, entry] of consumers.current) {
      if (entry.sourceType !== 'screen-audio') continue;
      const element = audioEls.current.get(consumerId);
      if (element) element.volume = normalized;
    }
  }, []);

  const setScreenShareVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    screenShareVolumeRef.current = normalized;
    setScreenShareVolumeState(normalized);
    localStorage.setItem(SCREEN_SHARE_VOLUME_KEY, String(normalized));
    if (screenAudioGain.current) screenAudioGain.current.gain.value = normalized;
  }, []);

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
        if (s.codecId) {
          const codec = framesSrc?.get(String(s.codecId)) as AnyStat | undefined;
          if (codec?.mimeType) next.codec = String(codec.mimeType).replace(/^video\//i, '').toUpperCase();
        }

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
    if (screenAnalysisTimer.current) clearInterval(screenAnalysisTimer.current);
    if (screenAnalysisVideo.current) screenAnalysisVideo.current.srcObject = null;
    audioCtxRef.current?.close().catch(() => {});
    micProcessingContext.current?.close().catch(() => {});
    screenAudioContext.current?.close().catch(() => {});
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
        // 按 consumerId 存音频元素，麦克风和系统音频两路并存不互相覆盖
        const el = new Audio();
        el.autoplay = true;
        el.volume = sourceType === 'screen-audio'
          ? screenReceiveVolumeRef.current
          : memberVolumesRef.current[peerId] ?? 1;
        el.srcObject = stream;
        audioEls.current.set(consumer.id, el);
        applyAudioElementOutput(el, selectedAudioOutputRef.current).catch(error => {
          console.warn('[audio] 远端音频切换输出设备失败，使用系统默认设备', error);
        }).finally(() => el.play().catch(() => {
          const resume = () => { el.play(); document.removeEventListener('click', resume); };
          document.addEventListener('click', resume);
        }));
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
      return true;
    } catch (e) {
      console.error('[mediasoup] consume 失败:', e);
      return false;
    } finally {
      pendingProducers.current.delete(producerId);
    }
  }, [socket]);

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
  }, [closeLocalConsumer]);

  const watchScreen = useCallback(async (socketId?: string) => {
    const source = socketId
      ? availableScreensRef.current.get(socketId)
      : availableScreensRef.current.values().next().value as AvailableScreen | undefined;
    if (!source || watchingScreenPeerRef.current === source.socketId) return;
    if (watchingScreenPeerRef.current) stopWatchingScreen();

    watchingScreenPeerRef.current = source.socketId;
    setWatchingScreenPeer(source.socketId);
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
        if (entry.kind !== 'audio' || entry.sourceType === 'screen-audio') continue;
        const element = audioEls.current.get(consumerId);
        if (element) element.volume = nextVolumes[entry.socketId] ?? 1;
      }
      setVoiceMembers(list);
    };

    const onVoicePresence = ({ action }: { action: 'join' | 'leave' }) => {
      if (deviceRef.current) playPresenceTone(action);
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
      }
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
        if (active) screenProducer.current?.resume();
        else screenProducer.current?.pause();
      } else if (active && !forceMutedRef.current) screenAudioProducer.current?.resume();
      else screenAudioProducer.current?.pause();
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
      pendingScreenAudioByPeer.current.delete(socketId);
      removeAvailableScreen(socketId);
      if (watchingScreenPeerRef.current === socketId) {
        watchingScreenPeerRef.current = null;
        setWatchingScreenPeer(null);
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
  }, [socket, inVoice, consumeProducer, closeLocalConsumer, stopWatchingScreen, storeAvailableScreen, removeAvailableScreen, playPresenceTone]);

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
        if (screenDemandActiveRef.current) screenAudioProducer.current?.resume();
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
  }, [socket, roomId, inVoice, setupDevice, consumeProducer, storeAvailableScreen, createProcessedMicStream, refreshAudioDevices, requestMicrophone]);

  // ── 离开语音 ───────────────────────────────────────────────────────────────

  const leaveVoice = useCallback(() => {
    joiningRef.current = false;
    setIsJoining(false);
    audioProducer.current?.close();       audioProducer.current       = null;
    screenProducer.current?.close();      screenProducer.current      = null;
    screenAudioProducer.current?.close(); screenAudioProducer.current = null;
    sendTransport.current?.close();       sendTransport.current       = null;
    recvTransport.current?.close();       recvTransport.current       = null;
    deviceRef.current = null;

    localAudioRef.current?.getTracks().forEach(t => t.stop());
    localAudioRef.current = null;
    rawAudioRef.current?.getTracks().forEach(t => t.stop());
    rawAudioRef.current = null;
    micProcessingContext.current?.close().catch(() => {});
    micProcessingContext.current = null;
    screenAudioContext.current?.close().catch(() => {});
    screenAudioContext.current = null;
    screenAudioGain.current = null;
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
    screenStreams.current.clear();

    // 停止音量计和统计
    stopMeters();
    analysers.current.clear();
    lossPrev.current = null;
    videoBytesPrev.current = null;
    setStats(EMPTY_STATS);

    setRemoteScreen(null);
    clearAvailableScreens();
    pendingScreenAudioByPeer.current.clear();
    watchingScreenPeerRef.current = null;
    setWatchingScreenPeer(null);
    screenDemandActiveRef.current = false;
    setScreenViewerCount(0);
    setInVoice(false);
    voiceMembersRef.current = [];
    setVoiceMembers([]);
    selfMutedRef.current = false;
    setIsMuted(forceMutedRef.current);
    setIsSharing(false);
    socket.emit('voice:leave', roomId);
  }, [socket, roomId, stopMeters, clearAvailableScreens]);

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
  ) => {
    const producer = screenProducer.current;
    const track = localScreenRef.current?.getVideoTracks()[0];
    const target = screenProfile(preset, maxFps, activity);
    const contentHint = activity === 'motion' ? 'motion' : 'detail';
    screenActivityRef.current = activity;
    setScreenActivity(activity);
    setScreenTargetBitrate(target.bitrate);
    if (track) {
      track.contentHint = contentHint;
      track.applyConstraints({ frameRate: { max: target.fps } }).catch(() => {});
    }
    if (!producer) return;
    if (producer.track) producer.track.contentHint = contentHint;
    try {
      const params = producer.rtpSender?.getParameters();
      if (!params) return;
      if (params.encodings?.[0]) {
        params.encodings[0].maxBitrate = target.bitrate;
        params.encodings[0].maxFramerate = target.fps;
      }
      params.degradationPreference = activity === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      producer.rtpSender?.setParameters(params).catch(() => {});
    } catch { /* ignore */ }
  }, []);

  /**
   * mediasoup 不读取视频像素，因此在发送端把画面缩到 160×90，每秒比较一次
   * 亮度变化。连续静止后降到 15fps；滚动/普通操作用 30fps；大面积变化时才
   * 使用用户选择的最高 60fps。采样只有约 1.4 万像素，开销远低于视频编码。
   */
  const startScreenAnalysis = useCallback((stream: MediaStream, preset: ScreenPreset, maxFps: Fps) => {
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
    applyScreenActivity(preset, maxFps, 'active');

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
          applyScreenActivity(preset, maxFps, next);
      } catch { /* 采样失败不影响共享本身 */ }
    }, 1_000);
  }, [applyScreenActivity, stopScreenAnalysis]);

  const startScreenShare = useCallback(async (
    initPreset?: ScreenPreset, initFps?: Fps, initAudio?: boolean, initGameMode?: boolean,
  ) => {
    if (!inVoice || isSharing) return;
    const preset     = initPreset  ?? screenPreset;
    const gameMode   = initGameMode ?? screenGameMode;
    const currentFps: Fps = gameMode ? 60 : (initFps ?? fps);
    const audio      = initAudio   ?? shareAudio;
    if (initPreset  !== undefined) setScreenPreset(initPreset);
    if (initFps     !== undefined || gameMode) setFps(currentFps);
    if (initAudio   !== undefined) setShareAudio(initAudio);
    if (initGameMode !== undefined) setScreenGameMode(initGameMode);

    const { width, height } = SCREEN_PRESETS[preset];
    const initialActivity: ScreenActivity = gameMode ? 'motion' : 'active';
    const initialProfile = screenProfile(preset, currentFps, initialActivity);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: currentFps } },
        audio,
      });
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.contentHint = gameMode ? 'motion' : 'detail';
      await videoTrack.applyConstraints({
        width: { max: width },
        height: { max: height },
        frameRate: { max: currentFps },
      }).catch(() => {});
      console.log('[screen share] 实际采集参数:', videoTrack.getSettings());
      localScreenRef.current = stream;
      setLocalScreen(stream);
      videoBytesPrev.current = null;

      const preferredCodec = deviceRef.current?.rtpCapabilities.codecs?.find(
        codec => codec.mimeType.toLowerCase() === 'video/vp9',
      );
      // 发送端使用克隆轨道。无人观看时 Producer.pause() 只关闭发送轨道，
      // 本地预览和轻量画面采样仍能工作，不会变成黑屏。
      const senderVideoTrack = videoTrack.clone();
      senderVideoTrack.contentHint = gameMode ? 'motion' : 'detail';
      let producer: Producer;
      try {
        producer = await sendTransport.current!.produce({
          track:   senderVideoTrack,
          appData: { type: 'screen', adaptation: gameMode ? 'game' : 'content', preset, maxFps: currentFps },
          encodings: [{ maxBitrate: initialProfile.bitrate, maxFramerate: initialProfile.fps }],
          codecOptions: { videoGoogleStartBitrate: Math.round(initialProfile.bitrate / (gameMode ? 1000 : 2000)) },
          ...(preferredCodec ? { codec: preferredCodec } : {}),
          disableTrackOnPause: true,
          zeroRtpOnPause: true,
        });
      } catch (error) {
        senderVideoTrack.stop();
        throw error;
      }
      screenProducer.current = producer;
      if (!screenDemandActiveRef.current) producer.pause();
      applyScreenActivity(preset, currentFps, initialActivity);
      if (gameMode) stopScreenAnalysis();
      else startScreenAnalysis(stream, preset, currentFps);

      // 系统音频：getDisplayMedia 勾选了"共享音频"时会带 audio track，单独 produce
      const sysAudioTrack = stream.getAudioTracks()[0];
      if (audio && sysAudioTrack) {
        try {
          const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const context = new Ctx({ sampleRate: 48_000, latencyHint: 'interactive' });
          const sourceStream = new MediaStream([sysAudioTrack]);
          const source = context.createMediaStreamSource(sourceStream);
          const gain = context.createGain();
          gain.gain.value = screenShareVolumeRef.current;
          const destination = context.createMediaStreamDestination();
          source.connect(gain).connect(destination);
          await context.resume();
          screenAudioContext.current = context;
          screenAudioGain.current = gain;
          const outgoingAudioTrack = destination.stream.getAudioTracks()[0];
          const ap = await sendTransport.current!.produce({
            track: outgoingAudioTrack,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
            encodings: [{ maxBitrate: 96_000 }],
            appData: { type: 'screen-audio' },
            disableTrackOnPause: true,
            zeroRtpOnPause: true,
          });
          screenAudioProducer.current = ap;
          if (forceMutedRef.current || !screenDemandActiveRef.current) ap.pause();
        } catch (e) {
          screenAudioContext.current?.close().catch(() => {});
          screenAudioContext.current = null;
          screenAudioGain.current = null;
          console.warn('[screen share] 系统音频发布失败:', e);
          window.alert('屏幕画面已开始共享，但系统音频发布失败。请停止共享后重试。');
        }
      } else if (audio) {
        console.warn('[screen share] 请求了系统音频，但未取得音频轨道');
        window.alert('屏幕画面已开始共享，但没有取得系统音频。请确认使用 Windows 客户端并重新开始共享。');
      }

      setIsSharing(true);

      // 用户在浏览器 UI 点"停止共享"
      stream.getVideoTracks()[0].onended = () => stopScreenShare();
    } catch (e) {
      console.error('[screen share]', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId, inVoice, isSharing, screenPreset, fps, shareAudio, screenGameMode, applyScreenActivity, startScreenAnalysis, stopScreenAnalysis]);

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
    screenAudioContext.current?.close().catch(() => {});
    screenAudioContext.current = null;
    screenAudioGain.current = null;
    localScreenRef.current?.getTracks().forEach(t => t.stop());
    localScreenRef.current = null;
    setLocalScreen(null);
    setIsSharing(false);
    screenDemandActiveRef.current = false;
    setScreenViewerCount(0);
    setScreenActivity('active');
    screenActivityRef.current = 'active';
    setScreenTargetBitrate(0);
    videoBytesPrev.current = null;
  }, [socket, stopScreenAnalysis]);

  const toggleShareAudio = useCallback(() => setShareAudio(p => !p), []);

  return {
    inVoice, isJoining, isMuted, isForceMuted, isSharing,
    screenPreset, fps, shareAudio, screenGameMode,
    screenActivity, screenTargetBitrate, screenViewerCount,
    voiceMembers,
    localScreen,
    remoteScreen,        // { socketId, stream: MediaStream } | null
    availableScreens,
    watchingScreenPeerId: watchingScreenPeer,
    isWatchingScreen: !!watchingScreenPeer,
    joinVoice, leaveVoice, toggleMute,
    startScreenShare, stopScreenShare,
    watchScreen, stopWatchingScreen, toggleShareAudio,
    // 新增：实时统计 + 音量
    stats, statsEnabled, toggleStats,
    speakingLevels,      // socketId → 0~1
    memberVolumes, setMemberVolume,
    screenReceiveVolume, setScreenReceiveVolume,
    screenShareVolume, setScreenShareVolume,
    audioInputDevices, audioOutputDevices,
    selectedAudioInputId, selectedAudioOutputId,
    audioDevicesRefreshing, audioInputSwitching, audioDeviceError,
    refreshAudioDevices, selectAudioInput, selectAudioOutput,
    playPresenceTone,
    localSocketId: socket.id,
  };
}
