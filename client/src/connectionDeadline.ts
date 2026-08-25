export const INITIAL_CONNECTION_TIMEOUT_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface ConnectionDeadlineOptions {
  timeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelScheduled?: (timer: TimerHandle) => void;
}

export interface ConnectionDeadline {
  complete: () => void;
  cancel: () => void;
}

/**
 * Caps the initial server connection attempt so a bad address cannot trap the UI forever.
 * The injected timer functions keep this behavior deterministic in tests.
 */
export function createConnectionDeadline(
  onTimeout: () => void,
  options: ConnectionDeadlineOptions = {},
): ConnectionDeadline {
  const {
    timeoutMs = INITIAL_CONNECTION_TIMEOUT_MS,
    schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelScheduled = timer => clearTimeout(timer),
  } = options;

  let active = true;
  const timer = schedule(() => {
    if (!active) return;
    active = false;
    onTimeout();
  }, timeoutMs);

  const finish = () => {
    if (!active) return;
    active = false;
    cancelScheduled(timer);
  };

  return { complete: finish, cancel: finish };
}
