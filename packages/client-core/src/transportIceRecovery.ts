import type { IceRestartCapability, IceRestartRequest, IceRestartResponse } from '@cove/contracts';
import { request, type AcknowledgedTransport } from './request';

export interface RestartableMediaTransport {
  readonly id: string;
  readonly closed: boolean;
  readonly connectionState: string;
  restartIce(options: { iceParameters: {
    usernameFragment: string; password: string; iceLite?: boolean;
  } }): Promise<void>;
}
export interface IceRecoveryRegistration {
  key: string;
  transport: RestartableMediaTransport;
  capability: unknown;
  ownerSocketId: string | undefined;
  isCurrent: () => boolean;
  isActive?: () => boolean;
  onFailure: (code: string) => void;
}
interface Round {
  attempts: number;
  requested: boolean;
  deadline: ReturnType<typeof setTimeout>;
  wake?: ReturnType<typeof setTimeout>;
}
interface Entry extends IceRecoveryRegistration {
  capability: IceRestartCapability;
  everConnected: boolean;
  sequence: number;
  pendingSequence?: number;
  busy: boolean;
  requests: number[];
  round?: Round;
}
interface Options {
  roomId: string;
  signal: AcknowledgedTransport & { readonly id?: string };
  requestRestart?: (payload: IceRestartRequest) => Promise<IceRestartResponse>;
  onEvent?: (event: string, detail: { key: string; attempt?: number; reason?: string }) => void;
  now?: () => number;
}
const terminalCodes = new Set(['BAD_REQUEST', 'NOT_CONNECTED', 'TRANSPORT_NOT_FOUND',
  'SESSION_MISMATCH', 'SESSION_EXPIRED', 'TRANSPORT_CLOSED', 'ICE_DISCONNECTED',
  'DTLS_FAILED', 'DTLS_CLOSED', 'STALE_SEQUENCE', 'INVALID_SEQUENCE', 'RATE_LIMITED', 'UNSUPPORTED']);

export function readIceRestartCapability(value: unknown): IceRestartCapability | null {
  const capability = value as Partial<IceRestartCapability> | null;
  return capability?.version === 1 && typeof capability.sessionId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(capability.sessionId) ? capability as IceRestartCapability : null;
}

/** A strategy owned by the existing media coordinator, never a capture/rejoin path. */
export function createTransportIceRecovery(options: Options) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  const requestRestart = options.requestRestart ?? ((payload: IceRestartRequest) =>
    request<IceRestartResponse>(options.signal, 'ms:restart-ice', payload, { timeoutMs: 2_500 }));
  let disposed = false;
  let signalReady = options.signal.connected;
  let signalEpoch = 0;
  const event = (entry: Entry, name: string, reason?: string) =>
    options.onEvent?.(name, { key: entry.key, attempt: entry.round?.attempts, reason });
  const current = (entry: Entry) => !disposed && entries.get(entry.key) === entry &&
    !entry.transport.closed && entry.isCurrent();
  const canSignal = (entry: Entry) => signalReady && options.signal.connected &&
    entry.ownerSocketId !== undefined && options.signal.id === entry.ownerSocketId;
  const clearRound = (entry: Entry) => {
    if (!entry.round) return;
    clearTimeout(entry.round.deadline);
    clearTimeout(entry.round.wake);
    entry.round = undefined;
  };
  const cancel = (key: string, transport?: RestartableMediaTransport) => {
    const entry = entries.get(key);
    if (!entry || (transport && entry.transport !== transport)) return;
    clearRound(entry);
    entries.delete(key);
    event(entry, 'ice-restart-cancelled');
  };
  const fail = (entry: Entry, reason: string) => {
    const active = current(entry) && (!entry.isActive || entry.isActive());
    clearRound(entry);
    entries.delete(entry.key);
    event(entry, 'ice-restart-failed', reason);
    if (active) { event(entry, 'ice-restart-fallback', reason); entry.onFailure(reason); }
  };
  const connected = (entry: Entry) => {
    clearRound(entry);
    event(entry, 'ice-restart-connected');
  };
  const schedule = (entry: Entry, delay: number) => {
    const round = entry.round;
    if (!round || round.wake) return;
    round.wake = setTimeout(() => {
      if (entry.round !== round) return;
      round.wake = undefined;
      void run(entry);
    }, delay);
  };
  const validResponse = (entry: Entry, response: IceRestartResponse, sequence: number) => {
    if (!response || response.ok !== true) return false;
    const ice = response.iceParameters;
    return response.transportId === entry.transport.id &&
      response.sessionId === entry.capability.sessionId && response.sequence === sequence &&
      typeof ice?.usernameFragment === 'string' && ice.usernameFragment.length > 0 && ice.usernameFragment.length <= 256 &&
      typeof ice.password === 'string' && ice.password.length > 0 && ice.password.length <= 256 &&
      (ice.iceLite === undefined || typeof ice.iceLite === 'boolean');
  };

  async function run(entry: Entry): Promise<void> {
    const round = entry.round;
    if (!round || entry.busy) return;
    if (!current(entry)) { cancel(entry.key, entry.transport); return; }
    if (entry.isActive && !entry.isActive()) { cancel(entry.key, entry.transport); return; }
    if (!canSignal(entry)) { event(entry, 'ice-restart-signal-wait'); return; }
    if (!round.requested && entry.transport.connectionState === 'connected') { connected(entry); return; }
    entry.requests = entry.requests.filter(at => now() - at < 30_000);
    if (round.attempts >= 3 || entry.requests.length >= 3) { fail(entry, 'ATTEMPTS_EXHAUSTED'); return; }
    entry.busy = true;
    round.attempts += 1;
    entry.requests.push(now());
    round.requested = true;
    const sequence = entry.pendingSequence ?? ++entry.sequence;
    entry.pendingSequence = sequence;
    const epoch = signalEpoch;
    let phase: 'request' | 'apply' = 'request';
    event(entry, 'ice-restart-request');
    try {
      const response = await requestRestart({
        transportId: entry.transport.id, roomId: options.roomId,
        sessionId: entry.capability.sessionId, sequence,
      });
      if (!current(entry) || entry.round !== round || epoch !== signalEpoch || !canSignal(entry)) return;
      if (response?.ok === false) {
        if (response.code === 'RESTART_FAILED') entry.pendingSequence = undefined;
        else if (response.code !== 'BUSY') {
          fail(entry, terminalCodes.has(response.code) ? response.code : 'INVALID_RESPONSE'); return;
        }
        event(entry, 'ice-restart-retry', response.code);
        return;
      }
      if (!validResponse(entry, response, sequence)) { fail(entry, 'INVALID_RESPONSE'); return; }
      phase = 'apply';
      event(entry, 'ice-restart-applying');
      // Once the worker has rotated credentials, synchronize the client even if
      // it briefly reports connected; dropping this ACK could leave stale ICE.
      await entry.transport.restartIce({ iceParameters: (response as Extract<IceRestartResponse, { ok: true }>).iceParameters });
      if (!current(entry) || entry.round !== round || epoch !== signalEpoch || !canSignal(entry)) return;
      entry.pendingSequence = undefined;
      event(entry, 'ice-restart-applied');
      if (entry.transport.connectionState === 'connected') connected(entry);
    } catch {
      // ACK loss is ambiguous. Reuse the same sequence on retry, including after
      // signal recovery; a late response is ignored by the request's deadline.
      if (current(entry) && entry.round === round) event(entry, 'ice-restart-retry', phase === 'apply' ? 'APPLY_FAILED' : 'REQUEST_FAILED');
    } finally {
      entry.busy = false;
      if (current(entry) && entry.round === round) schedule(entry, 2_000);
    }
  }

  function observe(registration: IceRecoveryRegistration, state: string): boolean {
    const capability = readIceRestartCapability(registration.capability);
    if (registration.transport.closed) { cancel(registration.key, registration.transport); return false; }
    if (disposed || !capability || typeof registration.transport.restartIce !== 'function' ||
        registration.transport.closed || !registration.isCurrent()) return false;
    const previous = entries.get(registration.key);
    if (previous && previous.transport !== registration.transport) cancel(previous.key, previous.transport);
    let entry = entries.get(registration.key);
    if (!entry) {
      entry = { ...registration, capability, everConnected: state === 'connected', sequence: 0, busy: false, requests: [] };
      entries.set(entry.key, entry);
      // A newly created owned transport proves a fresh explicit setup round.
      // It may follow an idle disconnect or a manual rejoin on a fresh socket;
      // that must not inherit the old signal suspension. Existing transports
      // can resume only through the coordinator's recovered-session branch.
      if (options.signal.connected && entry.ownerSocketId !== undefined && options.signal.id === entry.ownerSocketId)
        signalReady = true;
    }
    if (state === 'connected') {
      entry.everConnected = true;
      if (entry.round && !entry.busy && entry.pendingSequence === undefined) connected(entry);
      return true;
    }
    if (state === 'closed') { cancel(entry.key, entry.transport); return false; }
    if (!entry.everConnected || (entry.isActive && !entry.isActive())) return false;
    if (!entry.round && (state === 'failed' || state === 'disconnected')) {
      const owner = entry;
      const round: Round = {
        attempts: 0, requested: false,
        deadline: setTimeout(() => { if (owner.round === round) fail(owner, 'DEADLINE_EXCEEDED'); }, 20_000),
      };
      entry.round = round;
      event(entry, 'ice-restart-begin', state === 'failed' ? 'STATE_FAILED' : 'STATE_DISCONNECTED');
      schedule(entry, state === 'failed' ? 0 : 1_500);
    }
    return entry.round !== undefined;
  }
  const cancelAll = () => { for (const key of [...entries.keys()]) cancel(key); };
  return {
    observe, cancel, cancelAll,
    isRecovering: () => [...entries.values()].some(entry => entry.round !== undefined && current(entry) &&
      (!entry.isActive || entry.isActive())),
    onSignalLost: () => { signalReady = false; signalEpoch += 1; },
    onSessionRecovered: () => {
      if (disposed) return;
      signalReady = true;
      for (const entry of entries.values()) if (entry.round) schedule(entry, 0);
    },
    dispose: () => { disposed = true; signalReady = false; signalEpoch += 1; cancelAll(); },
  };
}
export type TransportIceRecovery = ReturnType<typeof createTransportIceRecovery>;
