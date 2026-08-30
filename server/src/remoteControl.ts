import { randomUUID } from 'crypto';

export const REMOTE_CONTROL_REQUEST_TTL_MS = 30_000;
const MAX_INPUTS_PER_SECOND = 240;

export type RemoteControlInput =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'button'; button: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number; x: number; y: number }
  | { type: 'key'; code: string; down: boolean };

export interface RemoteControlRequest {
  requestId: string;
  roomId: string;
  controllerSocketId: string;
  sharerSocketId: string;
  expiresAt: number;
}

export interface RemoteControlSession {
  sessionId: string;
  roomId: string;
  controllerSocketId: string;
  sharerSocketId: string;
  startedAt: number;
}

type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: string };

const finiteUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const SAFE_KEY_CODE = /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;

export function sanitizeRemoteControlInput(value: unknown): RemoteControlInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.type === 'pointer' && finiteUnit(input.x) && finiteUnit(input.y))
    return { type: 'pointer', x: input.x, y: input.y };
  if (
    input.type === 'button'
    && (input.button === 'left' || input.button === 'right' || input.button === 'middle')
    && typeof input.down === 'boolean'
    && finiteUnit(input.x)
    && finiteUnit(input.y)
  ) return { type: 'button', button: input.button, down: input.down, x: input.x, y: input.y };
  if (
    input.type === 'wheel'
    && typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) && Math.abs(input.deltaX) <= 1200
    && typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) && Math.abs(input.deltaY) <= 1200
    && finiteUnit(input.x)
    && finiteUnit(input.y)
  ) return { type: 'wheel', deltaX: input.deltaX, deltaY: input.deltaY, x: input.x, y: input.y };
  if (
    input.type === 'key'
    && typeof input.code === 'string'
    && SAFE_KEY_CODE.test(input.code)
    && typeof input.down === 'boolean'
  ) return { type: 'key', code: input.code, down: input.down };
  return null;
}

export class RemoteControlRegistry {
  private readonly requests = new Map<string, RemoteControlRequest>();
  private readonly sessions = new Map<string, RemoteControlSession>();
  private readonly inputWindows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly createId: () => string = randomUUID) {}

  createRequest(roomId: string, controllerSocketId: string, sharerSocketId: string, now = Date.now()): RegistryResult<RemoteControlRequest> {
    if (!roomId || !controllerSocketId || !sharerSocketId || controllerSocketId === sharerSocketId)
      return { ok: false, error: '远程控制请求无效' };
    if ([...this.sessions.values()].some(session =>
      session.controllerSocketId === controllerSocketId || session.sharerSocketId === controllerSocketId
      || session.controllerSocketId === sharerSocketId || session.sharerSocketId === sharerSocketId))
      return { ok: false, error: '当前已有远程控制会话' };
    for (const [requestId, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(requestId);
      else if (
        request.controllerSocketId === controllerSocketId || request.sharerSocketId === controllerSocketId
        || request.controllerSocketId === sharerSocketId || request.sharerSocketId === sharerSocketId
      )
        return { ok: false, error: '已有待确认的远程控制请求' };
    }
    const request: RemoteControlRequest = {
      requestId: this.createId(), roomId, controllerSocketId, sharerSocketId,
      expiresAt: now + REMOTE_CONTROL_REQUEST_TTL_MS,
    };
    this.requests.set(request.requestId, request);
    return { ok: true, value: request };
  }

  getRequest(requestId: string): RemoteControlRequest | undefined {
    return this.requests.get(requestId);
  }

  expireRequest(requestId: string, now = Date.now()): RemoteControlRequest | null {
    const request = this.requests.get(requestId);
    if (!request || request.expiresAt > now) return null;
    this.requests.delete(requestId);
    return request;
  }

  respond(requestId: string, responderSocketId: string, accepted: boolean, now = Date.now()): RegistryResult<{ request: RemoteControlRequest; session: RemoteControlSession | null }> {
    const request = this.requests.get(requestId);
    if (!request || request.expiresAt <= now) {
      if (request) this.requests.delete(requestId);
      return { ok: false, error: '远程控制请求已过期' };
    }
    if (request.sharerSocketId !== responderSocketId)
      return { ok: false, error: '只有共享者可以确认远程控制' };
    this.requests.delete(requestId);
    if (!accepted) return { ok: true, value: { request, session: null } };
    if ([...this.sessions.values()].some(session =>
      session.controllerSocketId === request.controllerSocketId || session.sharerSocketId === request.controllerSocketId
      || session.controllerSocketId === request.sharerSocketId || session.sharerSocketId === request.sharerSocketId))
      return { ok: false, error: '当前已有远程控制会话' };
    const session: RemoteControlSession = {
      sessionId: this.createId(), roomId: request.roomId,
      controllerSocketId: request.controllerSocketId,
      sharerSocketId: request.sharerSocketId,
      startedAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return { ok: true, value: { request, session } };
  }

  authorizeInput(sessionId: string, controllerSocketId: string, now = Date.now()): RemoteControlSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.controllerSocketId !== controllerSocketId) return null;
    const window = this.inputWindows.get(sessionId);
    if (!window || now - window.startedAt >= 1000) {
      this.inputWindows.set(sessionId, { startedAt: now, count: 1 });
      return session;
    }
    if (window.count >= MAX_INPUTS_PER_SECOND) return null;
    window.count += 1;
    return session;
  }

  stop(sessionId: string, participantSocketId: string): RegistryResult<RemoteControlSession> {
    const session = this.sessions.get(sessionId);
    if (!session || (session.controllerSocketId !== participantSocketId && session.sharerSocketId !== participantSocketId))
      return { ok: false, error: '远程控制会话不存在' };
    this.sessions.delete(sessionId);
    this.inputWindows.delete(sessionId);
    return { ok: true, value: session };
  }

  clearSocket(socketId: string): { requests: RemoteControlRequest[]; sessions: RemoteControlSession[] } {
    const requests: RemoteControlRequest[] = [];
    const sessions: RemoteControlSession[] = [];
    for (const [requestId, request] of this.requests) {
      if (request.controllerSocketId !== socketId && request.sharerSocketId !== socketId) continue;
      this.requests.delete(requestId);
      requests.push(request);
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.controllerSocketId !== socketId && session.sharerSocketId !== socketId) continue;
      this.sessions.delete(sessionId);
      this.inputWindows.delete(sessionId);
      sessions.push(session);
    }
    return { requests, sessions };
  }

  clearRoom(roomId: string): { requests: RemoteControlRequest[]; sessions: RemoteControlSession[] } {
    const requests: RemoteControlRequest[] = [];
    const sessions: RemoteControlSession[] = [];
    for (const [requestId, request] of this.requests) {
      if (request.roomId !== roomId) continue;
      this.requests.delete(requestId);
      requests.push(request);
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.roomId !== roomId) continue;
      this.sessions.delete(sessionId);
      this.inputWindows.delete(sessionId);
      sessions.push(session);
    }
    return { requests, sessions };
  }
}
