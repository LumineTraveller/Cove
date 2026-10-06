import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import { Room, Message } from '../../models';

export interface RegisterChatSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly stmtGetRoom: { get: (id: string) => Room | undefined };
  readonly roomMembers: Map<string, Set<string>>;
  readonly userNames: Map<string, string>;
  readonly publicUserId: (socketId: string) => string;
  readonly stmtInsertMsg: BetterSqlite3.Statement<unknown[], unknown>;
  readonly userClientIds: Map<string, string>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function registerChatSocketHandlers(deps: RegisterChatSocketHandlersDependencies) {
  // ── Messages ──────────────────────────────────────────────────────────────

  deps.socket.on('message:send', ({ roomId, content }: { roomId: string; content: string }) => {
    if (
      !content?.trim() ||
      !deps.stmtGetRoom.get(roomId) ||
      !deps.roomMembers.get(roomId)?.has(deps.socket.id)
    )
      return;
    const msg: Message = {
      id: Math.random().toString(36).slice(2, 9),
      roomId,
      author: deps.userNames.get(deps.socket.id) ?? 'Unknown',
      authorUserId: deps.publicUserId(deps.socket.id),
      content: content.trim(),
      type: 'chat',
      timestamp: Date.now(),
    };
    deps.stmtInsertMsg.run(
      msg.id,
      msg.roomId,
      msg.author,
      deps.userClientIds.get(deps.socket.id) ?? null,
      msg.content,
      msg.type,
      msg.timestamp,
    );
    deps.io.to(roomId).emit('message:new', msg);
  });
  return {};
}
