import { Server, type Socket } from 'socket.io';

import { peers } from '../media/ms';

import { type VoicePresenceAction } from './voicePresence';

import { Room } from '../../models';

export interface RegisterVoiceSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly stmtGetRoom: { get: (id: string) => Room | undefined };
  readonly roomMembers: Map<string, Set<string>>;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly socketAvatarPayload: <T>(socket: Socket, payload: T) => T;
  readonly currentVoiceList: (
    roomId: string,
  ) => {
    socketId: string;
    userId: string;
    username: string;
    avatarUrl: string | null;
    isMuted: boolean;
  }[];
  readonly selfMutedVoiceMembers: Set<string>;
  readonly publicUserId: (socketId: string) => string;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly announceVoicePresence: (
    roomId: string,
    socketId: string,
    username: string,
    action: VoicePresenceAction,
    audience: Iterable<string>,
  ) => void;
  readonly broadcastVoiceList: (roomId: string) => void;
  readonly broadcastVoiceCounts: () => void;
  readonly handleVoiceLeave: (socketId: string, roomId: string) => void;
  readonly isSocketMuted: (roomId: string, socketId: string) => boolean;
  readonly pausePeerMicrophone: (socketId: string, paused: boolean) => void;
}

export function registerVoiceSocketHandlers(deps: RegisterVoiceSocketHandlersDependencies) {
  // ── Voice member tracking (UI only) ───────────────────────────────────────

  deps.socket.on(
    'voice:join',
    (roomId: string, cb?: (response: { ok: true } | { error: string }) => void) => {
      if (!deps.stmtGetRoom.get(roomId) || !deps.roomMembers.get(roomId)?.has(deps.socket.id)) {
        cb?.({ error: '尚未加入该频道，无法加入语音' });
        return;
      }
      if (!deps.voiceRooms.has(roomId)) deps.voiceRooms.set(roomId, new Set());
      const members = deps.voiceRooms.get(roomId)!;
      if (members.has(deps.socket.id)) {
        deps.socket.emit(
          'voice:members-updated',
          deps.socketAvatarPayload(deps.socket, deps.currentVoiceList(roomId)),
        );
        cb?.({ ok: true });
        return;
      }
      const existing = [...members];
      deps.selfMutedVoiceMembers.delete(deps.socket.id);

      deps.socket.emit(
        'voice:existing-members',
        deps.socketAvatarPayload(
          deps.socket,
          existing.map((id) => ({
            socketId: id,
            userId: deps.publicUserId(id),
            username: deps.userNames.get(id) ?? id,
            avatarUrl: deps.userAvatars.get(id) ?? null,
          })),
        ),
      );

      existing.forEach((mid) =>
        deps.emitAvatarPayload(
          'voice:user-joined',
          {
            socketId: deps.socket.id,
            username: deps.userNames.get(deps.socket.id) ?? deps.socket.id,
            avatarUrl: deps.userAvatars.get(deps.socket.id) ?? null,
          },
          mid,
        ),
      );

      members.add(deps.socket.id);

      // 旧版客户端会先创建麦克风 Producer、再发送 voice:join。
      // 这时 ms:produce 无法把新流广播给尚未登记进 voiceRooms 的发送方，
      // 因而已经在语音中的成员不会收到这一路音频。加入语音时补发已有
      // 麦克风 Producer，使新旧客户端都不依赖事件到达顺序。
      const peer = peers.get(deps.socket.id);
      for (const producer of peer?.producers.values() ?? []) {
        const producerAppData = producer.appData as Record<string, unknown>;
        if (producer.closed || producer.kind !== 'audio' || producerAppData.type !== 'mic')
          continue;
        for (const mid of existing) {
          deps.io.to(mid).emit('ms:new-producer', {
            producerId: producer.id,
            peerId: deps.socket.id,
            kind: producer.kind,
            appData: producer.appData,
          });
        }
      }

      deps.announceVoicePresence(
        roomId,
        deps.socket.id,
        deps.userNames.get(deps.socket.id) ?? deps.socket.id,
        'join',
        members,
      );
      deps.broadcastVoiceList(roomId);
      deps.broadcastVoiceCounts();
      cb?.({ ok: true });
    },
  );

  deps.socket.on('voice:leave', (roomId: string) => {
    deps.handleVoiceLeave(deps.socket.id, roomId);
  });

  deps.socket.on('voice:mute-state', ({ roomId, muted }: { roomId: string; muted: boolean }) => {
    const voiceMembers = deps.voiceRooms.get(roomId);
    if (!voiceMembers?.has(deps.socket.id) || !deps.roomMembers.get(roomId)?.has(deps.socket.id))
      return;

    if (muted) deps.selfMutedVoiceMembers.add(deps.socket.id);
    else deps.selfMutedVoiceMembers.delete(deps.socket.id);

    const effectivelyMuted = muted || deps.isSocketMuted(roomId, deps.socket.id);
    deps.pausePeerMicrophone(deps.socket.id, effectivelyMuted);
    deps.broadcastVoiceList(roomId);
  });
  return {};
}
