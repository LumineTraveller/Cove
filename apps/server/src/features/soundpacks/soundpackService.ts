import { Server } from 'socket.io';

import { peers } from '../media/ms';

import { SoundpackRecord, PublicSoundpack } from '../../models';

export interface CreateSoundpackServiceDependencies {
  readonly userClientIds: Map<string, string>;
  readonly userNames: Map<string, string>;
  readonly isRoomOwner: (roomId: string | undefined, socketId: string | undefined) => boolean;
  readonly publicUserIdForStableId: (stableId: string) => string;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function createSoundpackService(deps: CreateSoundpackServiceDependencies) {
  function toPublicSoundpack(
    pack: SoundpackRecord,
    requesterSocketId?: string,
    roomId?: string,
  ): PublicSoundpack {
    const requesterClientId = requesterSocketId
      ? deps.userClientIds.get(requesterSocketId)
      : undefined;
    const requesterName = requesterSocketId ? deps.userNames.get(requesterSocketId) : undefined;
    const ownsPack =
      !!requesterClientId &&
      (pack.uploaderId ? pack.uploaderId === requesterClientId : pack.uploader === requesterName);
    const canDelete = ownsPack || deps.isRoomOwner(roomId, requesterSocketId);
    return {
      id: pack.id,
      name: pack.name,
      filename: pack.filename,
      originalFilename: pack.originalFilename ?? pack.filename,
      uploader: pack.uploader,
      uploaderUserId: pack.uploaderId ? deps.publicUserIdForStableId(pack.uploaderId) : null,
      createdAt: pack.createdAt,
      sortOrder: pack.sortOrder,
      canDelete,
    };
  }

  function broadcastSoundpackAdded(pack: SoundpackRecord) {
    for (const targetSocket of deps.io.sockets.sockets.values()) {
      targetSocket.emit(
        'soundpack:added',
        toPublicSoundpack(pack, targetSocket.id, peers.get(targetSocket.id)?.roomId ?? undefined),
      );
    }
  }
  return { toPublicSoundpack, broadcastSoundpackAdded };
}
