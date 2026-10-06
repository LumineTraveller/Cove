/** Deadlines are per channel; repeated failures never extend an outage. */
export class DisconnectGrace {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly timeoutMs: number) {}
  fail(key: string, onExpired: () => void): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        onExpired();
      }, this.timeoutMs),
    );
  }
  recover(key: string): void {
    this.cancel(key);
  }
  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
