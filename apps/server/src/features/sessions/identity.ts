import { createHash } from 'crypto';

import { Room, StoredRoom } from '../../models';

export interface CreateIdentityServiceDependencies {
  readonly userClientIds: Map<string, string>;
}

export function createIdentityService(deps: CreateIdentityServiceDependencies) {
  function publicUserId(socketId: string): string {
    const stableId = deps.userClientIds.get(socketId) ?? `socket:${socketId}`;
    // 房主凭据本身绝不能广播；只暴露不可逆摘要供客户端保存个人音量。
    return publicUserIdForStableId(stableId);
  }

  function publicUserIdForStableId(stableId: string): string {
    return createHash('sha256').update(stableId).digest('hex').slice(0, 24);
  }

  function toPublicRoom({ ownerId, ...room }: StoredRoom): Room {
    return {
      ...room,
      ownerUserId: ownerId ? publicUserIdForStableId(ownerId) : null,
      hasPassword: !!room.hasPassword,
    };
  }
  return { publicUserId, publicUserIdForStableId, toPublicRoom };
}
