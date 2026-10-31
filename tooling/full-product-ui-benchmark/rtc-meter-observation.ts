type Channel = 'voice' | 'shared';
type Levels = Record<string, number>;
type Store = { getLevels(channel: Channel): Levels;
  subscribe(channel: Channel, key: string, callback: () => void): () => void;
  subscriptionCount(): number };

/** Own only harness subscriptions. Never modify/clear the actual meter store. */
export function createRtcMeterObservation(observe: (levels: Levels | undefined) => void) {
  let rtc: any = null, store: Store | null = null, stopped = false;
  let mode: 'react-state' | 'external-store' = 'react-state', notifications = 0, registrations = 0;
  const subscriptions = new Map<string, () => void>(), seenStores = new Set<Store>();
  const unsubscribeOwned = () => { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); };
  const onChange = () => {
    if (stopped || !store) return;
    notifications++;
    // Read the actual public getter after atomic store publication. Shared
    // notifications may coalesce with voice; unchanged voice values stay equal.
    observe(rtc?.speakingLevels);
  };
  const storeSubscriptions = () => {
    let total = 0;
    for (const seen of seenStores) {
      const count = seen.subscriptionCount();
      if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid meter subscription diagnostic');
      total += count;
    }
    return total;
  };
  return {
    update(controller: any) {
      if (stopped) return;
      rtc = controller?.rtc;
      const candidate = rtc?.audioMeters;
      if (candidate && (typeof candidate.getLevels !== 'function' || typeof candidate.subscribe !== 'function' ||
          typeof candidate.subscriptionCount !== 'function')) throw Error('Incomplete product meter store contract');
      const next: Store | null = candidate ?? null;
      if (next !== store) { unsubscribeOwned(); store = next; }
      mode = store ? 'external-store' : 'react-state';
      if (!store) { observe(rtc?.speakingLevels); return; }
      seenStores.add(store);
      const keys = new Set<string>();
      const add = (key: unknown) => { if (typeof key === 'string' && key.length) keys.add(key); };
      // Subscribe before the first RMS publication, even when both maps are empty.
      add(rtc?.localSocketId);
      for (const member of controller?.roomMembers ?? []) add(member?.socketId);
      for (const member of rtc?.voiceMembers ?? []) add(member?.socketId);
      for (const channel of ['voice', 'shared'] as const) for (const key of Object.keys(store.getLevels(channel))) add(key);
      const wanted = new Set<string>();
      for (const channel of ['voice', 'shared'] as const) for (const key of keys) {
        const subscription = channel + ':' + key;
        wanted.add(subscription);
        if (!subscriptions.has(subscription)) {
          subscriptions.set(subscription, store.subscribe(channel, key, onChange)); registrations++;
        }
      }
      for (const [key, stop] of subscriptions) if (!wanted.has(key)) { stop(); subscriptions.delete(key); }
      observe(rtc?.speakingLevels);
    },
    stop() { if (stopped) return; stopped = true; unsubscribeOwned(); },
    snapshot() { return { observationMode: mode, activeHarnessMeterSubscriptions: subscriptions.size,
      meterStoreNotifications: notifications, harnessMeterSubscriptionRegistrations: registrations,
      meterStoreSubscriptions: storeSubscriptions(), meterObservationStopped: stopped }; },
    resources() { return { meterStoreSubscriptions: storeSubscriptions(), harnessMeterSubscriptions: subscriptions.size }; },
  };
}
