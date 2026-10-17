import type { Server } from 'socket.io';
import { SoundpackRecord, PublicSoundpack } from '../../models';
import { SoundpackAccessError, type SoundpackAccess } from './soundpackAccess';

export interface CreateSoundpackServiceDependencies {
  readonly userClientIds: Map<string, string>;
  readonly isRoomOwner: (roomId: string | undefined, socketId: string | undefined) => boolean;
  readonly publicUserIdForStableId: (stableId: string) => string;
  readonly roomMembers: Map<string, Set<string>>;
  readonly access: SoundpackAccess;
  readonly io: Server;
}

export function createSoundpackService(deps: CreateSoundpackServiceDependencies) {
  function toPublicSoundpack(pack: SoundpackRecord, requesterSocketId: string, roomId: string): PublicSoundpack {
    if (!pack.roomId || pack.roomId !== roomId)
      throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包不存在');
    const requesterClientId = deps.userClientIds.get(requesterSocketId);
    return {
      id: pack.id, roomId: pack.roomId, name: pack.name, filename: pack.filename,
      originalFilename: pack.originalFilename ?? pack.filename, uploader: pack.uploader,
      uploaderUserId: pack.uploaderId ? deps.publicUserIdForStableId(pack.uploaderId) : null,
      createdAt: pack.createdAt, sortOrder: pack.sortOrder,
      canDelete: (!!requesterClientId && pack.uploaderId === requesterClientId) || deps.isRoomOwner(pack.roomId, requesterSocketId),
    };
  }

  function broadcastSoundpackEvent(roomId: string, event: string, payload: unknown | ((socketId: string) => unknown)) {
    for (const socketId of deps.roomMembers.get(roomId) ?? []) {
      const socket = deps.io.sockets.sockets.get(socketId);
      if (!socket) continue;
      try { deps.access.socketRoomActor(socket, roomId); }
      catch { continue; }
      socket.emit(event, typeof payload === 'function' ? payload(socketId) : payload);
    }
  }

  function broadcastSoundpackAdded(pack: SoundpackRecord) {
    if (pack.roomId) broadcastSoundpackEvent(pack.roomId, 'soundpack:added',
      (socketId: string) => toPublicSoundpack(pack, socketId, pack.roomId!));
  }
  return { toPublicSoundpack, broadcastSoundpackAdded, broadcastSoundpackEvent };
}
