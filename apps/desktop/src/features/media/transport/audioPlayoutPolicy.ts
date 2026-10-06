export const INITIAL_AUDIO_PLAYOUT_TARGET_MS = 40;

const TARGETS_MS = [20, 40, 80, 120] as const;
const SAMPLE_INTERVAL_MS = 1_000;
const MAX_STATS_WINDOW_MS = 3_000;
const MIN_INCREASE_INTERVAL_MS = 2_500;
const MIN_DECREASE_INTERVAL_MS = 12_000;
const CLEAN_WINDOWS_TO_DECREASE = 8;

export type AudioPlayoutMode = 'adaptive' | 'native' | 'legacy';
export type AudioLatencyProfile = 'adaptive' | 'legacy';

interface AudioPlayoutStorage {
  getItem(key: string): string | null;
}

export function resolveAudioPlayoutMode(
  profile?: AudioLatencyProfile,
  storage?: AudioPlayoutStorage,
): AudioPlayoutMode {
  if (profile === 'legacy') return 'legacy';

  let legacy = false;
  let native = false;
  try {
    legacy = storage?.getItem('cove:legacy-audio-playout') === '1';
    native = storage?.getItem('cove:adaptive-audio-playout') === '1';
  } catch {
    // Denied storage keeps the managed adaptive policy.
  }
  if (legacy) return 'legacy';
  if (native) return 'native';
  return 'adaptive';
}

export function readAudioPlayoutMode(): AudioPlayoutMode {
  let profile: AudioLatencyProfile | undefined;
  let storage: AudioPlayoutStorage | undefined;
  try {
    if (typeof window !== 'undefined') {
      profile = (window as Window & { coveAudioLatencyProfile?: AudioLatencyProfile })
        .coveAudioLatencyProfile;
      storage = window.localStorage;
    }
  } catch {
    // The profile can still select legacy mode when local storage is denied.
  }
  return resolveAudioPlayoutMode(profile, storage);
}

interface AudioStatsSnapshot {
  timestamp: number;
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  concealedSamples: number;
  concealmentEvents: number;
  totalSamplesReceived: number;
}

type WindowHealth = 'clean' | 'degraded' | 'severe' | 'unknown';

interface WindowAssessment {
  health: WindowHealth;
  baseline: AudioStatsSnapshot | null;
}

interface StatsEntry {
  type?: unknown;
  kind?: unknown;
  mediaType?: unknown;
  timestamp?: unknown;
  packetsLost?: unknown;
  packetsReceived?: unknown;
  jitter?: unknown;
  concealedSamples?: unknown;
  concealmentEvents?: unknown;
  totalSamplesReceived?: unknown;
}

interface AudioPlayoutReceiver {
  jitterBufferTarget?: number | null;
  playoutDelayHint?: number | null;
}

interface AudioPlayoutTrack {
  readyState?: string;
  addEventListener?(event: 'ended', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(event: 'ended', listener: () => void): void;
}

export interface AudioPlayoutConsumer {
  id: string;
  kind?: string;
  closed?: boolean;
  track?: AudioPlayoutTrack;
  rtpReceiver?: AudioPlayoutReceiver;
  observer?: {
    on?(event: 'close', listener: () => void): unknown;
    off?(event: 'close', listener: () => void): unknown;
  };
  getStats(): Promise<{ values?: () => IterableIterator<StatsEntry> }>;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}

interface PlayoutTargetControl {
  set(milliseconds: number): boolean;
  clear(): void;
}

interface PolicyMember {
  consumer: AudioPlayoutConsumer;
  kind: string;
  control: PlayoutTargetControl | null;
  previous: AudioStatsSnapshot | null;
  stopped: boolean;
  unbind: () => void;
}

interface PolicyGroup {
  id: string;
  synchronized: boolean;
  members: Map<string, PolicyMember>;
  managed: boolean;
  targetMs: number;
  stableWindows: number;
  lastTargetChangeAt: number;
}

export interface AudioPlayoutPolicyOptions {
  now?: () => number;
  sampleIntervalMs?: number;
  minIncreaseIntervalMs?: number;
  minDecreaseIntervalMs?: number;
  cleanWindowsToDecrease?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function monotonicNow(): number {
  const performanceObject = globalThis.performance;
  return typeof performanceObject?.now === 'function'
    ? performanceObject.now.call(performanceObject)
    : Date.now();
}

function readAudioStats(report: { values?: () => IterableIterator<StatsEntry> }): AudioStatsSnapshot | null {
  let entries: StatsEntry[];
  try {
    entries = report?.values ? Array.from(report.values()) : [];
  } catch {
    return null;
  }
  const inbound = entries
    .filter((entry) => entry.type === 'inbound-rtp' && (entry.kind ?? entry.mediaType) === 'audio')
    .sort((left, right) => (finiteNumber(right.timestamp) ?? 0) - (finiteNumber(left.timestamp) ?? 0))[0];
  if (!inbound) return null;

  const timestamp = finiteNumber(inbound.timestamp);
  const packetsLost = finiteNumber(inbound.packetsLost);
  const packetsReceived = finiteNumber(inbound.packetsReceived);
  const jitter = finiteNumber(inbound.jitter);
  const concealedSamples = finiteNumber(inbound.concealedSamples);
  const concealmentEvents = finiteNumber(inbound.concealmentEvents);
  const totalSamplesReceived = finiteNumber(inbound.totalSamplesReceived);
  if (
    timestamp == null || packetsLost == null || packetsReceived == null || jitter == null ||
    concealedSamples == null || concealmentEvents == null || totalSamplesReceived == null
  ) return null;

  return {
    timestamp,
    packetsLost,
    packetsReceived,
    jitterMs: jitter * 1_000,
    concealedSamples,
    concealmentEvents,
    totalSamplesReceived,
  };
}

function assessWindow(
  previous: AudioStatsSnapshot | null,
  current: AudioStatsSnapshot | null,
): WindowAssessment {
  if (!current) return { health: 'unknown', baseline: null };
  if (!previous) return { health: 'unknown', baseline: current };

  const elapsedMs = current.timestamp - previous.timestamp;
  if (elapsedMs <= 0) return { health: 'unknown', baseline: previous };
  if (elapsedMs > MAX_STATS_WINDOW_MS) return { health: 'unknown', baseline: current };

  const counterPairs: [number, number][] = [
    [previous.packetsLost, current.packetsLost],
    [previous.packetsReceived, current.packetsReceived],
    [previous.concealedSamples, current.concealedSamples],
    [previous.concealmentEvents, current.concealmentEvents],
    [previous.totalSamplesReceived, current.totalSamplesReceived],
  ];
  if (counterPairs.some(([before, after]) => after < before))
    return { health: 'unknown', baseline: current };

  const received = current.packetsReceived - previous.packetsReceived;
  const lost = current.packetsLost - previous.packetsLost;
  const packetWindow = received + lost;
  const sampleWindow = current.totalSamplesReceived - previous.totalSamplesReceived;
  const concealed = current.concealedSamples - previous.concealedSamples;
  const concealmentEvents = current.concealmentEvents - previous.concealmentEvents;
  const lossRatio = packetWindow > 0 ? lost / packetWindow : null;
  const concealmentRatio = sampleWindow > 0 ? concealed / sampleWindow : null;
  const jitterRiseMs = current.jitterMs - previous.jitterMs;

  if (packetWindow >= 20 && lossRatio != null && (
    lossRatio >= 0.08 || current.jitterMs >= 80 || concealmentRatio != null && concealmentRatio >= 0.05
  )) return { health: 'severe', baseline: current };

  if (
    packetWindow >= 20 && lossRatio != null && lossRatio >= 0.02 ||
    current.jitterMs >= 25 || jitterRiseMs >= 12 ||
    concealmentEvents > 0 || concealmentRatio != null && concealmentRatio >= 0.01
  ) return { health: 'degraded', baseline: current };

  if (
    packetWindow >= 20 && lossRatio === 0 && sampleWindow > 0 && concealed === 0 &&
    concealmentEvents === 0 && current.jitterMs <= 12 && jitterRiseMs <= 5
  ) return { health: 'clean', baseline: current };

  // Sparse, missing, stale, or borderline samples are neither proof of health nor
  // enough evidence to raise the target. In particular they cannot lower it.
  return { health: 'unknown', baseline: current };
}

function createTargetControl(receiver: AudioPlayoutReceiver | undefined): PlayoutTargetControl | null {
  if (!receiver) return null;
  let activeApi: 'jitterBufferTarget' | 'playoutDelayHint' | null = null;
  const trySet = (api: 'jitterBufferTarget' | 'playoutDelayHint', milliseconds: number) => {
    try {
      if (api === 'jitterBufferTarget') receiver.jitterBufferTarget = milliseconds;
      else receiver.playoutDelayHint = milliseconds / 1_000;
      activeApi = api;
      return true;
    } catch {
      return false;
    }
  };
  return {
    set(milliseconds) {
      if (activeApi === 'jitterBufferTarget') return trySet('jitterBufferTarget', milliseconds);
      if (activeApi === 'playoutDelayHint') return trySet('playoutDelayHint', milliseconds);
      if ('jitterBufferTarget' in receiver && trySet('jitterBufferTarget', milliseconds)) return true;
      if ('playoutDelayHint' in receiver && trySet('playoutDelayHint', milliseconds)) return true;
      return false;
    },
    clear() {
      try {
        if (activeApi === 'jitterBufferTarget') receiver.jitterBufferTarget = null;
        else if (activeApi === 'playoutDelayHint') receiver.playoutDelayHint = null;
      } catch {
        // Keep the user agent's last accepted value if it no longer accepts reset.
      }
      activeApi = null;
    },
  };
}

export class AudioPlayoutPolicy {
  private readonly groups = new Map<string, PolicyGroup>();
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly minIncreaseIntervalMs: number;
  private readonly minDecreaseIntervalMs: number;
  private readonly cleanWindowsToDecrease: number;
  private readonly schedule: typeof globalThis.setInterval;
  private readonly cancel: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private sampling = false;
  private disposed = false;

  constructor(
    private readonly mode: AudioPlayoutMode = 'adaptive',
    options: AudioPlayoutPolicyOptions = {},
  ) {
    this.now = options.now ?? monotonicNow;
    this.intervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.minIncreaseIntervalMs = options.minIncreaseIntervalMs ?? MIN_INCREASE_INTERVAL_MS;
    this.minDecreaseIntervalMs = options.minDecreaseIntervalMs ?? MIN_DECREASE_INTERVAL_MS;
    this.cleanWindowsToDecrease = options.cleanWindowsToDecrease ?? CLEAN_WINDOWS_TO_DECREASE;
    this.schedule = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.cancel = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  }

  watch(
    consumer: AudioPlayoutConsumer,
    groupId: string,
    kind: string,
    synchronizedGroup = false,
  ): () => void {
    if (this.disposed || consumer.closed || consumer.track?.readyState === 'ended') return () => {};
    if (this.mode === 'native') return () => {};

    const control = createTargetControl(consumer.rtpReceiver);
    if (this.mode === 'legacy') {
      if (kind === 'audio') control?.set(80);
      return () => control?.clear();
    }
    if (kind !== 'audio' && !synchronizedGroup) return () => {};

    let group = this.groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        synchronized: synchronizedGroup,
        members: new Map(),
        managed: true,
        targetMs: INITIAL_AUDIO_PLAYOUT_TARGET_MS,
        stableWindows: 0,
        lastTargetChangeAt: Number.NEGATIVE_INFINITY,
      };
      this.groups.set(groupId, group);
    }

    const member: PolicyMember = {
      consumer,
      kind,
      control,
      previous: null,
      stopped: false,
      unbind: () => {},
    };
    const stop = () => this.unwatch(group!, member);
    member.unbind = this.bindCleanup(consumer, stop);
    group.members.set(consumer.id, member);

    const hasAudioMember = [...group.members.values()].some((member) => member.kind === 'audio');
    const shouldApplyTarget = !group.synchronized || hasAudioMember;
    if (group.managed && shouldApplyTarget && !this.applyGroupTarget(group, group.targetMs, false))
      this.disableGroup(group);
    this.syncTimer();
    return stop;
  }

  async sampleNow(): Promise<void> {
    if (this.disposed || this.sampling) return;
    this.sampling = true;
    try {
      const groups = [...this.groups.values()].filter((group) => group.managed);
      await Promise.all(groups.map(async (group) => {
        const audioMembers = [...group.members.values()].filter((member) => member.kind === 'audio');
        if (!audioMembers.length || this.disposed) return;
        const assessments = await Promise.all(audioMembers.map((member) => this.sampleMember(member)));
        if (this.disposed || this.groups.get(group.id) !== group || !group.managed) return;
        if (assessments.some((assessment) => assessment.health === 'severe')) {
          this.increaseTarget(group, 120);
        } else if (assessments.some((assessment) => assessment.health === 'degraded')) {
          this.increaseTarget(group, group.targetMs < 80 ? 80 : 120);
        } else if (assessments.length && assessments.every((assessment) => assessment.health === 'clean')) {
          this.decreaseTarget(group);
        } else {
          group.stableWindows = 0;
        }
      }));
    } finally {
      this.sampling = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer != null) this.cancel(this.timer);
    this.timer = null;
    for (const group of this.groups.values()) {
      for (const member of [...group.members.values()]) this.unwatch(group, member);
    }
    this.groups.clear();
  }

  private async sampleMember(member: PolicyMember): Promise<WindowAssessment> {
    if (member.stopped || member.consumer.closed || member.consumer.track?.readyState === 'ended')
      return { health: 'unknown', baseline: member.previous };
    let current: AudioStatsSnapshot | null = null;
    try {
      current = readAudioStats(await member.consumer.getStats());
    } catch {
      // Missing/throwing stats are unknown; they must not count as healthy windows.
    }
    if (member.stopped || this.disposed) return { health: 'unknown', baseline: member.previous };
    const assessment = assessWindow(member.previous, current);
    member.previous = assessment.baseline;
    return assessment;
  }

  private increaseTarget(group: PolicyGroup, target: number): void {
    group.stableWindows = 0;
    if (target <= group.targetMs || this.now() - group.lastTargetChangeAt < this.minIncreaseIntervalMs)
      return;
    if (!this.applyGroupTarget(group, target, true)) this.disableGroup(group);
  }

  private decreaseTarget(group: PolicyGroup): void {
    group.stableWindows += 1;
    if (group.stableWindows < this.cleanWindowsToDecrease || group.targetMs <= 20) return;
    if (this.now() - group.lastTargetChangeAt < this.minDecreaseIntervalMs) return;
    const index = TARGETS_MS.indexOf(group.targetMs as (typeof TARGETS_MS)[number]);
    if (index <= 0) return;
    group.stableWindows = 0;
    if (!this.applyGroupTarget(group, TARGETS_MS[index - 1], true)) this.disableGroup(group);
  }

  private applyGroupTarget(group: PolicyGroup, targetMs: number, recordChange: boolean): boolean {
    for (const member of group.members.values()) {
      if (!member.control?.set(targetMs)) return false;
    }
    group.targetMs = targetMs;
    if (recordChange) {
      group.lastTargetChangeAt = this.now();
      group.stableWindows = 0;
    }
    return true;
  }

  private disableGroup(group: PolicyGroup): void {
    group.managed = false;
    group.stableWindows = 0;
    for (const member of group.members.values()) member.control?.clear();
    this.syncTimer();
  }

  private unwatch(group: PolicyGroup, member: PolicyMember): void {
    if (member.stopped) return;
    member.stopped = true;
    member.unbind();
    member.control?.clear();
    group.members.delete(member.consumer.id);
    if (group.synchronized && member.kind === 'audio' &&
      ![...group.members.values()].some((candidate) => candidate.kind === 'audio')) {
      for (const remaining of group.members.values())
        if (remaining.kind === 'video') remaining.control?.clear();
      group.targetMs = INITIAL_AUDIO_PLAYOUT_TARGET_MS;
      group.stableWindows = 0;
      group.lastTargetChangeAt = Number.NEGATIVE_INFINITY;
    }
    if (!group.members.size) this.groups.delete(group.id);
    this.syncTimer();
  }

  private bindCleanup(consumer: AudioPlayoutConsumer, stop: () => void): () => void {
    const events = ['close', 'transportclose', 'trackended'];
    for (const event of events) consumer.on?.(event, stop);
    consumer.observer?.on?.('close', stop);
    const track = consumer.track;
    track?.addEventListener?.('ended', stop, { once: true });
    return () => {
      for (const event of events) consumer.off?.(event, stop);
      consumer.observer?.off?.('close', stop);
      track?.removeEventListener?.('ended', stop);
    };
  }

  private syncTimer(): void {
    if (this.disposed) return;
    const needsTimer = [...this.groups.values()].some((group) =>
      group.managed && [...group.members.values()].some((member) => member.kind === 'audio'),
    );
    if (needsTimer && this.timer == null)
      this.timer = this.schedule(() => { void this.sampleNow(); }, this.intervalMs);
    else if (!needsTimer && this.timer != null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }
}
