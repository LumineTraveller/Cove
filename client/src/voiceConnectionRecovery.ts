import { DisconnectGrace } from './utils/disconnectGrace';

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

/** Signalling and WebRTC have independent connections and failure deadlines. */
export function createVoiceConnectionRecovery(options: VoiceConnectionRecoveryOptions) {
  const onDisconnect = (reason: string) => {
    options.onEvent('signal-disconnected', reason);
    if (reason === 'io client disconnect' || reason === 'io server disconnect') {
      options.resetVoice(reason);
      return;
    }
    const state = options.readState();
    if (!state.active && !state.joining) return;
    options.grace.fail('signal', () => {
      const latest = options.readState();
      if (!latest.active && !latest.joining) return;
      // The server and renderer do not observe recovery at the same instant.
      // A late CONNECT packet must not make a signalling-only timeout destroy
      // working WebRTC. Transport failures retain their own five-second timers;
      // onConnect still rejects media belonging to a different server session.
      if (latest.active && latest.sendState === 'connected'
        && (latest.recvState === 'connected' || latest.recvState === 'new'
          || latest.recvState === 'connecting')) {
        options.onEvent('signal-timeout-media-retained');
        return;
      }
      options.resetVoice('signal-timeout');
      options.onError('服务器连接中断超过 5 秒，连接恢复后可直接加入语音');
    });
  };

  const onConnect = () => {
    options.grace.recover('signal');
    options.onEvent('signal-connected');
    const state = options.readState();
    if (state.voiceSocketId !== state.socketId || !state.recovered) {
      if (state.active || state.joining) options.resetVoice('session-not-recovered');
    } else if (!state.active && !state.joining) {
      // An explicit leave or failed media connection won the race with recovery.
      options.leaveRecoveredVoice();
    }
  };

  return { onDisconnect, onConnect, dispose: () => options.grace.recover('signal') };
}
