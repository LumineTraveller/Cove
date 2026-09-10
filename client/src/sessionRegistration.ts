import type { UserProfile } from './types';

export interface RegistrationResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  profile?: UserProfile;
}

type Acknowledgement = (error: Error | null, response?: RegistrationResponse) => void;

interface RegistrationOptions {
  isConnected: () => boolean;
  send: (acknowledge: Acknowledgement) => void;
  onPending: () => void;
  onSuccess: (response: RegistrationResponse) => void;
  onRejected: (response: RegistrationResponse) => void;
  onTransientError: (error: Error) => void;
}

/** A lost acknowledgement is not an authentication rejection. Retry on the
 * same connection, and never let callbacks from an old transport affect a new one. */
export function createSessionRegistration(options: RegistrationOptions) {
  let generation = 0;
  let inFlight = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    generation += 1;
    inFlight = false;
    retryAttempt = 0;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const start = () => {
    if (!options.isConnected() || inFlight || retryTimer !== null) return;
    const attempt = ++generation;
    inFlight = true;
    options.onPending();
    options.send((error, response) => {
      if (attempt !== generation || !inFlight) return;
      inFlight = false;
      // Socket.IO may fail pending acknowledgements before emitting disconnect.
      // The transport's normal reconnect path will start the next registration.
      if (!options.isConnected()) return;
      if (error || typeof response?.ok !== 'boolean') {
        options.onTransientError(error ?? new Error('服务器未返回有效的登录登记确认'));
        const delay = Math.min(2_500, 500 * 2 ** Math.min(retryAttempt++, 3));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (attempt === generation) start();
        }, delay);
        return;
      }
      retryAttempt = 0;
      if (response.ok) options.onSuccess(response);
      else options.onRejected(response);
    });
  };

  return { start, cancel };
}
