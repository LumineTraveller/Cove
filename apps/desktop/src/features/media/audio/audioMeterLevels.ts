/** Preserve React state identity only when every own meter key/value is unchanged. */
export function reuseAudioMeterLevels(
  previous: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return next;
  return keys.every(key => Object.prototype.hasOwnProperty.call(previous, key) &&
    Object.is(previous[key], next[key])) ? previous : next;
}

export type AudioMeterChannel = 'voice' | 'shared';

export interface AudioMeterStore {
  publish(voice: Record<string, number>, shared: Record<string, number>): void;
  clear(): void;
  getLevels(channel: AudioMeterChannel): Record<string, number>;
  getLevel(channel: AudioMeterChannel, primaryKey: string, fallbackKey?: string): number;
  subscribe(channel: AudioMeterChannel, key: string, listener: () => void): () => void;
  /** Active registrations only; exposes no member or socket identifiers. */
  subscriptionCount(): number;
}

/** One useWebRTC instance owns one store; snapshots change only on exact changes. */
export function createAudioMeterStore(): AudioMeterStore {
  const empty: Record<string, number> = Object.freeze({});
  const levels: Record<AudioMeterChannel, Record<string, number>> = {
    voice: empty,
    shared: empty,
  };
  // Counts keep repeated subscriptions of one callback independently removable.
  const listeners: Record<AudioMeterChannel, Map<string, Map<() => void, number>>> = {
    voice: new Map(),
    shared: new Map(),
  };
  let subscriptionCount = 0;
  const owns = (snapshot: Record<string, number>, key: string) =>
    Object.prototype.hasOwnProperty.call(snapshot, key);
  const nextSnapshot = (previous: Record<string, number>, next: Record<string, number>) =>
    reuseAudioMeterLevels(previous, next) === previous
      ? previous
      : Object.freeze({ ...next });

  const publish = (voice: Record<string, number>, shared: Record<string, number>) => {
    const previousVoice = levels.voice;
    const previousShared = levels.shared;
    const nextVoice = nextSnapshot(previousVoice, voice);
    const nextShared = nextSnapshot(previousShared, shared);
    if (nextVoice === previousVoice && nextShared === previousShared) return;
    // Publish both channels before any subscriber can read either snapshot.
    levels.voice = nextVoice;
    levels.shared = nextShared;
    const pending = new Set<() => void>();
    const collect = (
      channel: AudioMeterChannel,
      previous: Record<string, number>,
      next: Record<string, number>,
    ) => {
      if (previous === next) return;
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      for (const key of keys) {
        if (owns(previous, key) === owns(next, key) && Object.is(previous[key], next[key]))
          continue;
        for (const listener of listeners[channel].get(key)?.keys() ?? []) pending.add(listener);
      }
    };
    collect('voice', previousVoice, nextVoice);
    collect('shared', previousShared, nextShared);
    for (const listener of pending) listener();
  };

  return {
    publish,
    clear: () => publish({}, {}),
    getLevels: channel => levels[channel],
    getLevel: (channel, primaryKey, fallbackKey) => {
      const snapshot = levels[channel];
      return (owns(snapshot, primaryKey) ? snapshot[primaryKey] : undefined) ??
        (fallbackKey !== undefined && owns(snapshot, fallbackKey) ? snapshot[fallbackKey] : undefined) ??
        0;
    },
    subscribe: (channel, key, listener) => {
      const bucket = listeners[channel].get(key) ?? new Map<() => void, number>();
      listeners[channel].set(key, bucket);
      bucket.set(listener, (bucket.get(listener) ?? 0) + 1);
      subscriptionCount += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscriptionCount -= 1;
        const count = bucket.get(listener) ?? 0;
        if (count > 1) bucket.set(listener, count - 1);
        else bucket.delete(listener);
        if (bucket.size === 0) listeners[channel].delete(key);
      };
    },
    subscriptionCount: () => subscriptionCount,
  };
}
