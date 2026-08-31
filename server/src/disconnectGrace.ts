export const DISCONNECT_GRACE_MS = 7_500;

// Each failing channel gets its own deadline; repeated notifications never extend it.
export class DisconnectGrace {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  fail(key: string, onExpired: () => void) {
    if (this.timers.has(key)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      onExpired();
    }, DISCONNECT_GRACE_MS));
  }

  recover(key: string) {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  cancel(key: string) {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
