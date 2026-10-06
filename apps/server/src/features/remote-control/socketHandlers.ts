import { Server, type Socket } from 'socket.io';

import {
  REMOTE_CONTROL_REQUEST_TTL_MS,
  RemoteControlRegistry,
  sanitizeRemoteControlInput,
  type RemoteControlRequest,
  type RemoteControlSession,
} from './remoteControl';

export interface RegisterRemoteControlSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly roomMembers: Map<string, Set<string>>;
  readonly remoteControlCapabilities: Set<string>;
  readonly isSharingScreen: (socketId: string, roomId: string) => boolean;
  readonly isRemoteControlAllowed: (roomId: string, sharerSocketId: string) => boolean;
  readonly remoteControls: RemoteControlRegistry;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly userNames: Map<string, string>;
  readonly publicUserId: (socketId: string) => string;
  readonly emitRemoteRequestCancelled: (request: RemoteControlRequest, reason: string) => void;
  readonly emitRemoteControlStopped: (session: RemoteControlSession, reason: string) => void;
}

export function registerRemoteControlSocketHandlers(
  deps: RegisterRemoteControlSocketHandlersDependencies,
) {
  // ── Remote control ────────────────────────────────────────────────────────

  deps.socket.on(
    'remote-control:request',
    (
      { roomId, sharerSocketId }: { roomId?: string; sharerSocketId?: string },
      cb?: (result: {
        ok: boolean;
        requestId?: string;
        expiresAt?: number;
        error?: string;
      }) => void,
    ) => {
      const members = roomId ? deps.roomMembers.get(roomId) : undefined;
      if (
        !roomId ||
        !sharerSocketId ||
        !members?.has(deps.socket.id) ||
        !members.has(sharerSocketId)
      ) {
        cb?.({ ok: false, error: '双方必须在同一频道中' });
        return;
      }
      if (
        !deps.remoteControlCapabilities.has(deps.socket.id) ||
        !deps.remoteControlCapabilities.has(sharerSocketId)
      ) {
        cb?.({ ok: false, error: '双方都需要使用支持远程控制的 Windows 客户端' });
        return;
      }
      if (!deps.isSharingScreen(sharerSocketId, roomId)) {
        cb?.({ ok: false, error: '目标成员当前没有共享屏幕' });
        return;
      }
      if (!deps.isRemoteControlAllowed(roomId, sharerSocketId)) {
        cb?.({ ok: false, error: '共享者已关闭远程控制' });
        return;
      }
      const created = deps.remoteControls.createRequest(roomId, deps.socket.id, sharerSocketId);
      if (!created.ok) {
        cb?.({ ok: false, error: created.error });
        return;
      }
      const request = created.value;
      deps.io.to(sharerSocketId).emit('remote-control:requested', {
        requestId: request.requestId,
        roomId,
        controllerSocketId: deps.socket.id,
        controllerName: deps.userNames.get(deps.socket.id) ?? '成员',
        controllerUserId: deps.publicUserId(deps.socket.id),
        expiresAt: request.expiresAt,
      });
      setTimeout(() => {
        const expired = deps.remoteControls.expireRequest(request.requestId);
        if (expired) deps.emitRemoteRequestCancelled(expired, '远程控制请求已超时');
      }, REMOTE_CONTROL_REQUEST_TTL_MS + 50);
      cb?.({ ok: true, requestId: request.requestId, expiresAt: request.expiresAt });
    },
  );

  deps.socket.on(
    'remote-control:cancel',
    (
      { requestId }: { requestId?: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      if (!requestId) {
        cb?.({ ok: false, error: '请求不存在' });
        return;
      }
      const cancelled = deps.remoteControls.cancelRequest(requestId, deps.socket.id);
      if (!cancelled.ok) {
        cb?.({ ok: false, error: cancelled.error });
        return;
      }
      deps.emitRemoteRequestCancelled(cancelled.value, '远程控制请求已取消');
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'remote-control:respond',
    (
      { requestId, accepted }: { requestId?: string; accepted?: boolean },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      if (!requestId || typeof accepted !== 'boolean') {
        cb?.({ ok: false, error: '确认信息无效' });
        return;
      }
      const pending = deps.remoteControls.getRequest(requestId);
      if (!pending || pending.sharerSocketId !== deps.socket.id) {
        cb?.({ ok: false, error: '远程控制请求不存在或已过期' });
        return;
      }
      const members = deps.roomMembers.get(pending.roomId);
      if (!deps.isRemoteControlAllowed(pending.roomId, pending.sharerSocketId)) {
        const cancelled = deps.remoteControls.respond(requestId, deps.socket.id, false);
        if (cancelled.ok)
          deps.emitRemoteRequestCancelled(cancelled.value.request, '共享者已关闭远程控制');
        cb?.({ ok: false, error: '共享者已关闭远程控制' });
        return;
      }
      if (
        !members?.has(pending.controllerSocketId) ||
        !members.has(pending.sharerSocketId) ||
        !deps.isSharingScreen(pending.sharerSocketId, pending.roomId)
      ) {
        const rejected = deps.remoteControls.respond(requestId, deps.socket.id, false);
        if (rejected.ok)
          deps.emitRemoteRequestCancelled(rejected.value.request, '共享状态已变化，请重新申请');
        cb?.({ ok: false, error: '共享状态已变化，请重新申请' });
        return;
      }
      const response = deps.remoteControls.respond(requestId, deps.socket.id, accepted);
      if (!response.ok) {
        cb?.({ ok: false, error: response.error });
        return;
      }
      const { request, session } = response.value;
      if (!session) {
        deps.io.to(request.controllerSocketId).emit('remote-control:request-result', {
          requestId,
          accepted: false,
          error: '共享者已拒绝远程控制',
        });
        cb?.({ ok: true });
        return;
      }
      deps.io.to(session.controllerSocketId).emit('remote-control:started', {
        sessionId: session.sessionId,
        roomId: session.roomId,
        role: 'controller',
        sharerSocketId: session.sharerSocketId,
        sharerName: deps.userNames.get(session.sharerSocketId) ?? '共享者',
        sharerUserId: deps.publicUserId(session.sharerSocketId),
      });
      deps.io.to(session.sharerSocketId).emit('remote-control:started', {
        sessionId: session.sessionId,
        roomId: session.roomId,
        role: 'sharer',
        controllerSocketId: session.controllerSocketId,
        controllerName: deps.userNames.get(session.controllerSocketId) ?? '成员',
        controllerUserId: deps.publicUserId(session.controllerSocketId),
      });
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'remote-control:input',
    ({ sessionId, input }: { sessionId?: string; input?: unknown }) => {
      if (!sessionId) return;
      const safeInput = sanitizeRemoteControlInput(input);
      if (!safeInput) return;
      const session = deps.remoteControls.authorizeInput(
        sessionId,
        deps.socket.id,
        Date.now(),
        safeInput,
      );
      if (!session) return;
      if (!deps.isRemoteControlAllowed(session.roomId, session.sharerSocketId)) {
        const stopped = deps.remoteControls.stop(session.sessionId, deps.socket.id);
        if (stopped.ok) deps.emitRemoteControlStopped(stopped.value, '共享者已关闭远程控制');
        return;
      }
      const members = deps.roomMembers.get(session.roomId);
      if (
        !members?.has(session.controllerSocketId) ||
        !members.has(session.sharerSocketId) ||
        !deps.isSharingScreen(session.sharerSocketId, session.roomId)
      ) {
        const stopped = deps.remoteControls.stop(session.sessionId, deps.socket.id);
        if (stopped.ok) deps.emitRemoteControlStopped(stopped.value, '共享状态已变化');
        return;
      }
      deps.io.to(session.sharerSocketId).emit('remote-control:input', {
        sessionId: session.sessionId,
        input: safeInput,
      });
    },
  );

  deps.socket.on(
    'remote-control:stop',
    (
      { sessionId }: { sessionId?: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      if (!sessionId) {
        cb?.({ ok: false, error: '会话不存在' });
        return;
      }
      const stopped = deps.remoteControls.stop(sessionId, deps.socket.id);
      if (!stopped.ok) {
        cb?.({ ok: false, error: stopped.error });
        return;
      }
      deps.emitRemoteControlStopped(stopped.value, '远程控制已结束');
      cb?.({ ok: true });
    },
  );
  return {};
}
