import type { RegistrationResponse } from '@cove/contracts';
export type { RegistrationResponse } from '@cove/contracts';

type Acknowledgement = (error: Error | null, response?: RegistrationResponse) => void;

interface RegistrationOptions {
  maxAttempts?: number;
  isConnected: () => boolean;
  send: (acknowledge: Acknowledgement) => void;
  onPending: () => void;
  onSuccess: (response: RegistrationResponse) => void;
  onRejected: (response: RegistrationResponse) => void;
  onTransientError: (error: Error) => void;
  onExhausted?: (error: Error) => void;
}

export const SESSION_REGISTRATION_MAX_ATTEMPTS = 6;

/** A lost acknowledgement is not an authentication rejection. Retry on the
 * same connection, and never let callbacks from an old transport affect a new one. */
export function createSessionRegistration(options: RegistrationOptions) {
  let generation = 0;
  let inFlight = false;
  let completed = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const maxAttempts = options.maxAttempts ?? SESSION_REGISTRATION_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError('Registration maxAttempts must be a positive integer');

  const cancel = () => {
    generation += 1;
    inFlight = false;
    completed = false;
    attempts = 0;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const start = () => {
    if (!options.isConnected() || completed || inFlight || retryTimer !== null) return;
    const attempt = ++generation;
    attempts += 1;
    inFlight = true;
    options.onPending();
    if (attempt !== generation) return;
    options.send((error, response) => {
      if (attempt !== generation || !inFlight) return;
      inFlight = false;
      // Socket.IO may fail pending acknowledgements before emitting disconnect.
      // The transport's normal reconnect path will start the next registration.
      if (!options.isConnected()) return;
      if (error || typeof response?.ok !== 'boolean') {
        const failure = error ?? new Error('服务器未返回有效的登录登记确认');
        options.onTransientError(failure);
        // A callback may synchronously cancel this connection or start a new one.
        if (attempt !== generation) return;
        if (attempts >= maxAttempts) {
          completed = true;
          options.onExhausted?.(failure);
          return;
        }
        const delay = Math.min(2_500, 500 * 2 ** Math.min(attempts - 1, 3));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (attempt === generation) start();
        }, delay);
        return;
      }
      completed = true;
      if (response.ok) options.onSuccess(response);
      else options.onRejected(response);
    });
  };

  return { start, cancel };
}
