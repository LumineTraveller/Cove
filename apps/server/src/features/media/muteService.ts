import { Server } from 'socket.io';

import { peers } from './ms';

export interface CreateMuteServiceDependencies {
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly isSocketMuted: (roomId: string, socketId: string) => boolean;
  readonly syncOnDemandProducer: (producerId: string) => void;
  readonly selfMutedVoiceMembers: Set<string>;
}

export function createMuteService(deps: CreateMuteServiceDependencies) {
  function emitForcedMuteState(socketId: string, roomId: string) {
    deps.io.to(socketId).emit('room:force-muted', {
      roomId,
      muted: deps.isSocketMuted(roomId, socketId),
    });
  }

  function pausePeerAudio(socketId: string, paused: boolean) {
    const peer = peers.get(socketId);
    if (!peer) return;
    for (const [producerId, producer] of peer.producers) {
      if (producer.kind !== 'audio') continue;
      const sourceType = (producer.appData as Record<string, unknown>).type;
      if (paused) producer.pause().catch(() => {});
      else if (sourceType === 'screen-audio') deps.syncOnDemandProducer(producerId);
      else if (sourceType === 'mic' && deps.selfMutedVoiceMembers.has(socketId))
        producer.pause().catch(() => {});
      else producer.resume().catch(() => {});
    }
  }

  function pausePeerMicrophone(socketId: string, paused: boolean) {
    const peer = peers.get(socketId);
    if (!peer) return;
    for (const producer of peer.producers.values()) {
      if (producer.kind !== 'audio') continue;
      const sourceType = (producer.appData as Record<string, unknown>).type;
      if (sourceType !== 'mic') continue;
      if (paused) producer.pause().catch(() => {});
      else producer.resume().catch(() => {});
    }
  }

  function isSharingScreen(socketId: string, roomId: string): boolean {
    const peer = peers.get(socketId);
    if (!peer || peer.roomId !== roomId) return false;
    return [...peer.producers.values()].some(
      (producer) =>
        !producer.closed && (producer.appData as Record<string, unknown>).type === 'screen',
    );
  }
  return { emitForcedMuteState, pausePeerAudio, pausePeerMicrophone, isSharingScreen };
}
