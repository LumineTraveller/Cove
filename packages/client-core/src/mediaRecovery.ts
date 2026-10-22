import type { DisconnectGrace } from './disconnectGrace';
import type { TransportIceRecovery } from './transportIceRecovery';

/** Live resource state, read again at every asynchronous boundary. */
export interface MediaRecoveryState {
  recovered: boolean;
  socketId: string | undefined;
  mediaSocketId: string | undefined;
  active: boolean;
  pending: boolean;
  established: boolean;
  sendState: string | null;
  recvState: string | null;
}

export function hasRecoverableMediaTransport(...states: Array<string | null>): boolean {
  return states.some(state => state !== null && state !== 'failed' && state !== 'closed');
}

export function shouldRetainMediaOnSignalTimeout(state: MediaRecoveryState): boolean {
  return state.established && hasRecoverableMediaTransport(state.sendState, state.recvState);
}

export function isRecoveredMediaSession(state: MediaRecoveryState): boolean {
  return state.recovered && state.mediaSocketId !== undefined && state.mediaSocketId === state.socketId;
}

interface MediaConnectionRecoveryOptions {
  transportRecovery?: Pick<TransportIceRecovery, 'onSignalLost' | 'onSessionRecovered' | 'cancelAll' | 'isRecovering'>;
  grace: Pick<DisconnectGrace, 'fail' | 'recover'>;
  readState: () => MediaRecoveryState;
  retainOnSignalTimeout: (state: MediaRecoveryState) => boolean;
  resetMedia: (reason: string) => void;
  leaveRecoveredSession: () => void;
  onSignalLost?: () => void;
  onRecovered?: (state: MediaRecoveryState) => void;
  onSignalTimeout: () => void;
  onEvent?: (event: string, reason?: string) => void;
}

/** Owns signal deadlines only. Native/RTP resources remain platform-owned. */
export function createMediaConnectionRecovery(options: MediaConnectionRecoveryOptions) {
  let disposed = false;
  const reset = (reason: string) => {
    options.transportRecovery?.cancelAll();
    options.onEvent?.('media-reset', reason);
    options.resetMedia(reason);
  };
  const onDisconnect = (reason: string) => {
    if (disposed) return;
    options.onEvent?.('signal-disconnected', reason);
    if (reason === 'io client disconnect' || reason === 'io server disconnect') {
      reset(reason);
      return;
    }
    options.transportRecovery?.onSignalLost();
    const state = options.readState();
    if (!state.active && !state.pending) return;
    options.onSignalLost?.();
    options.grace.fail('signal', () => {
      if (disposed) return;
      const latest = options.readState();
      if (!latest.active && !latest.pending) return;
      if (options.retainOnSignalTimeout(latest) || options.transportRecovery?.isRecovering()) {
        options.onEvent?.('signal-timeout-media-retained');
        return;
      }
      reset('signal-timeout');
      options.onSignalTimeout();
    });
  };

  const onConnect = () => {
    if (disposed) return;
    options.grace.recover('signal');
    options.onEvent?.('signal-connected');
    const state = options.readState();
    if (!isRecoveredMediaSession(state)) {
      if (state.active || state.pending) reset('session-not-recovered');
    } else if (!state.established && !state.pending) {
      // Explicit leave and media failure take priority over signal recovery.
      options.onEvent?.('recovered-session-left');
      options.leaveRecoveredSession();
    } else {
      options.transportRecovery?.onSessionRecovered();
      options.onRecovered?.(state);
    }
  };

  return { onDisconnect, onConnect, dispose: () => {
    disposed = true;
    options.transportRecovery?.cancelAll();
    options.grace.recover('signal');
  } };
}
