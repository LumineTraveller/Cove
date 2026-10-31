/** The experiment changes only the owning WebContents' background policy. */
export interface NativeScreenRendererActivityTarget {
  isDestroyed?(): boolean;
  getBackgroundThrottling?(): boolean;
  setBackgroundThrottling?(allowed: boolean): void;
}

interface ActivityLease {
  previous: boolean;
  holders: number;
}

// Share ownership across controller instances too. A retiring predecessor must
// not restore throttling while another capture still owns this same renderer.
const activities = new WeakMap<NativeScreenRendererActivityTarget, ActivityLease>();

/** Best effort: policy failures never become capture failures or slot credits. */
export function acquireNativeScreenRendererActivity(
  target: NativeScreenRendererActivityTarget,
): (() => void) | undefined {
  let activity: ActivityLease;
  try {
    if (target.isDestroyed?.() || typeof target.getBackgroundThrottling !== 'function' ||
        typeof target.setBackgroundThrottling !== 'function') return undefined;
    const existing = activities.get(target);
    if (existing) {
      activity = existing;
      activity.holders++;
    } else {
      const previous = target.getBackgroundThrottling();
      if (typeof previous !== 'boolean') return undefined;
      activity = { previous, holders: 1 };
      activities.set(target, activity);
      // Retain the known baseline even if a setter partially applies then throws.
      // Final release still attempts to restore that original policy.
      if (previous) {
        try { target.setBackgroundThrottling(false); } catch { /* Experimental policy only. */ }
      }
    }
  } catch { return undefined; }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activities.get(target) !== activity || --activity.holders !== 0) return;
    activities.delete(target);
    if (!activity.previous) return;
    try {
      if (!target.isDestroyed?.()) target.setBackgroundThrottling?.(activity.previous);
    } catch { /* A destroyed target or failed policy restore cannot break teardown. */ }
  };
}
