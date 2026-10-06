export type VoicePresenceAction = 'join' | 'leave';

export interface VoicePresenceEvent {
  eventId: string;
  action: VoicePresenceAction;
  socketId: string;
  username: string;
  timestamp: number;
}

export function createVoicePresenceEvent(
  action: VoicePresenceAction,
  socketId: string,
  username: string,
  now = Date.now(),
  random = Math.random(),
): VoicePresenceEvent {
  return {
    eventId: `voice-${now.toString(36)}-${random.toString(36).slice(2, 9)}`,
    action,
    socketId,
    username,
    timestamp: now,
  };
}

export function voicePresenceMessage(username: string, action: VoicePresenceAction): string {
  return `[${username}] ${action === 'join' ? '加入' : '离开'}了语音`;
}
