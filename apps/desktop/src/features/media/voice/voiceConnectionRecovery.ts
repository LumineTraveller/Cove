import { DisconnectGrace } from '../../connection/disconnectGrace';
import { createMediaConnectionRecovery, shouldRetainMediaOnSignalTimeout } from '@cove/client-core';

export interface VoiceConnectionState {
  connected: boolean;
  recovered: boolean;
  socketId: string | undefined;
  voiceSocketId: string | undefined;
  active: boolean;
  joining: boolean;
  sendState: string | null;
  recvState: string | null;
}

interface VoiceConnectionRecoveryOptions {
  grace: DisconnectGrace;
  readState: () => VoiceConnectionState;
  resetVoice: (reason: string) => void;
  leaveRecoveredVoice: () => void;
  onError: (message: string) => void;
  onEvent: (event: string, reason?: string) => void;
}

/** Desktop adapter: recovery policy does not own the voice resources. */
export function createVoiceConnectionRecovery(options: VoiceConnectionRecoveryOptions) {
  return createMediaConnectionRecovery({
    grace: options.grace,
    readState: () => {
      const state = options.readState();
      return { ...state, mediaSocketId: state.voiceSocketId, pending: state.joining, established: state.active };
    },
    retainOnSignalTimeout: shouldRetainMediaOnSignalTimeout,
    resetMedia: options.resetVoice,
    leaveRecoveredSession: options.leaveRecoveredVoice,
    onSignalTimeout: () => options.onError('服务器连接中断超过 5 秒，连接恢复后可直接加入语音'),
    onEvent: options.onEvent,
  });
}
