import { type Server } from 'socket.io';

import {
  type AnnotationAck,
  type AnnotationConfigurePayload,
  type AnnotationGetTarget,
  type AnnotationLaserEvent,
  type AnnotationPermission,
  type AnnotationPoint,
  type AnnotationRequest,
  type AnnotationRespondPayload,
  type AnnotationState,
  type AnnotationStroke,
  type AnnotationStrokeEvent,
  type AnnotationStrokeInput,
  type AnnotationTarget,
} from '@cove/contracts';

export const ANNOTATION_LIMITS = {
  strokes: 400,
  points: 16_000,
  pointsPerStroke: 2_048,
  pointsPerChunk: 128,
  requests: 64,
  drawEventsPerSecond: 90,
  laserEventsPerSecond: 50,
  configureEventsPerSecond: 20,
  snapshotRequestsPerSecond: 20,
  respondEventsPerSecond: 20,
  clearEventsPerSecond: 5,
  requestsPerMinute: 12,
} as const;

export interface AnnotationServiceDependencies {
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly roomMembers: Map<string, Set<string>>;
  readonly userNames: Map<string, string>;
  /** Returns the current screen producer id for this sharer, if any. */
  readonly currentScreenSessionId: (roomId: string, sharerSocketId: string) => string | null;
  /** Cancels and notifies all existing control requests and sessions for a socket. */
  readonly stopRemoteControlForSocket: (socketId: string, reason: string) => void;
  readonly now?: () => number;
}

type MutableAnnotationState = {
  roomId: string;
  sharerSocketId: string;
  sessionId: string;
  revision: number;
  enabled: boolean;
  permission: AnnotationPermission;
  remoteControlAllowed: boolean;
  strokes: AnnotationStroke[];
  grants: string[];
  requests: AnnotationRequest[];
};

type RateWindow = { startedAt: number; count: number };
type ServiceResult = { ack: AnnotationAck; broadcast?: boolean };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_COLOR = /^#[\da-f]{6}$/i;
const PERMISSIONS = new Set<AnnotationPermission>(['everyone', 'request', 'sharer']);
const MIN_WIDTH = 0.0005;
const MAX_WIDTH = 0.08;
const POINT_RATE_WINDOW_MS = 1_000;
const REQUEST_RATE_WINDOW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPoint(value: unknown): value is AnnotationPoint {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y <= 1
  );
}

function validStringId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function validTarget(
  value: unknown,
  allowMissingSession: boolean,
): value is AnnotationGetTarget | AnnotationTarget {
  if (!isRecord(value)) return false;
  if (!validStringId(value.roomId) || !validStringId(value.sharerSocketId)) return false;
  if (value.sessionId === undefined) return allowMissingSession;
  return validStringId(value.sessionId);
}

function stateSnapshot(state: MutableAnnotationState): AnnotationState {
  return {
    ...state,
    strokes: state.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    })),
    grants: [...state.grants],
    requests: state.requests.map((request) => ({ ...request })),
  };
}

function failure(code: NonNullable<AnnotationAck['error']>['code'], message: string): ServiceResult {
  return { ack: { ok: false, error: { code, message } } };
}

export function createAnnotationService(deps: AnnotationServiceDependencies) {
  const states = new Map<string, MutableAnnotationState>();
  const rates = new Map<string, RateWindow>();
  const now = deps.now ?? Date.now;

  function stateKey(roomId: string, sharerSocketId: string, sessionId: string) {
    return `${roomId}\u0000${sharerSocketId}\u0000${sessionId}`;
  }

  function memberOfRoom(roomId: string, socketId: string) {
    return deps.roomMembers.get(roomId)?.has(socketId) === true;
  }

  function resolveTarget(
    target: unknown,
    requesterSocketId: string,
    allowMissingSession = false,
  ): { state: MutableAnnotationState | null; error?: AnnotationAck['error'] } {
    if (!validTarget(target, allowMissingSession))
      return { state: null, error: { code: 'invalid_payload', message: '批注目标格式无效' } };
    const normalized = target as AnnotationGetTarget;
    if (
      !memberOfRoom(normalized.roomId, requesterSocketId) ||
      !memberOfRoom(normalized.roomId, normalized.sharerSocketId)
    ) {
      return { state: null, error: { code: 'forbidden', message: '成员必须处于同一频道' } };
    }
    const currentSessionId = deps.currentScreenSessionId(normalized.roomId, normalized.sharerSocketId);
    if (!currentSessionId || (normalized.sessionId && normalized.sessionId !== currentSessionId)) {
      return { state: null, error: { code: 'invalid_target', message: '屏幕共享已结束或批注目标已变化' } };
    }
    const sessionId = currentSessionId;
    const key = stateKey(normalized.roomId, normalized.sharerSocketId, sessionId);
    let state = states.get(key) ?? null;
    if (!state && allowMissingSession) {
      state = {
        roomId: normalized.roomId,
        sharerSocketId: normalized.sharerSocketId,
        sessionId,
        revision: 0,
        enabled: false,
        permission: 'everyone',
        remoteControlAllowed: true,
        strokes: [],
        grants: [],
        requests: [],
      };
      states.set(key, state);
    }
    if (!state)
      return { state: null, error: { code: 'not_found', message: '批注会话不存在，请重新获取状态' } };
    return { state };
  }

  function snapshotResult(state: MutableAnnotationState): ServiceResult {
    return { ack: { ok: true, state: stateSnapshot(state), revision: state.revision } };
  }

  function emitState(state: MutableAnnotationState) {
    deps.io.to(state.roomId).emit('annotation:state', stateSnapshot(state));
  }

  function consumeRate(
    socketId: string,
    kind: 'draw' | 'laser' | 'configure' | 'request' | 'get' | 'respond' | 'clear',
    limit: number,
    windowMs: number,
  ) {
    const key = `${socketId}\u0000${kind}`;
    const current = now();
    let window = rates.get(key);
    if (!window || current - window.startedAt >= windowMs || current < window.startedAt) {
      window = { startedAt: current, count: 0 };
      rates.set(key, window);
    }
    if (window.count >= limit) return false;
    window.count += 1;
    return true;
  }

  function canDraw(state: MutableAnnotationState, socketId: string) {
    if (!state.enabled) return false;
    if (socketId === state.sharerSocketId) return true;
    if (state.permission === 'everyone') return true;
    if (state.permission === 'sharer') return false;
    return state.grants.includes(socketId);
  }

  function authorizedResult(state: MutableAnnotationState, socketId: string): ServiceResult | null {
    if (!state.enabled) return failure('disabled', '共享者尚未开启屏幕批注');
    if (!canDraw(state, socketId)) return failure('forbidden', '你没有在此屏幕上批注的权限');
    return null;
  }

  function validatedStroke(value: unknown): AnnotationStrokeInput | null {
    if (!isRecord(value)) return null;
    if (
      !validStringId(value.id) ||
      (value.tool !== 'pen' && value.tool !== 'eraser') ||
      typeof value.color !== 'string' ||
      !SAFE_COLOR.test(value.color) ||
      typeof value.width !== 'number' ||
      !Number.isFinite(value.width) ||
      value.width < MIN_WIDTH ||
      value.width > MAX_WIDTH ||
      !Array.isArray(value.points) ||
      value.points.length < 1 ||
      value.points.length > ANNOTATION_LIMITS.pointsPerChunk ||
      !value.points.every(validPoint)
    )
      return null;
    return {
      id: value.id,
      tool: value.tool,
      color: value.color.toUpperCase(),
      width: value.width,
      points: value.points.map((point) => ({ x: point.x, y: point.y })),
    };
  }

  function totalPoints(state: MutableAnnotationState) {
    return state.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  }

  function get(target: AnnotationGetTarget, requesterSocketId: string): AnnotationAck {
    const resolved = resolveTarget(target, requesterSocketId, true);
    if (!resolved.state) return { ok: false, error: resolved.error };
    if (
      !consumeRate(
        requesterSocketId,
        'get',
        ANNOTATION_LIMITS.snapshotRequestsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return { ok: false, error: { code: 'rate_limited', message: '批注状态获取过于频繁' } };
    return snapshotResult(resolved.state).ack;
  }

  function configure(payload: AnnotationConfigurePayload, requesterSocketId: string): ServiceResult {
    const resolved = resolveTarget(payload?.target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    if (requesterSocketId !== state.sharerSocketId)
      return failure('forbidden', '只有屏幕共享者可以修改批注设置');
    if (
      (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') ||
      (payload.remoteControlAllowed !== undefined && typeof payload.remoteControlAllowed !== 'boolean') ||
      (payload.permission !== undefined && !PERMISSIONS.has(payload.permission)) ||
      (payload.enabled === undefined &&
        payload.permission === undefined &&
        payload.remoteControlAllowed === undefined)
    )
      return failure('invalid_payload', '批注设置无效');
    if (
      !consumeRate(
        requesterSocketId,
        'configure',
        ANNOTATION_LIMITS.configureEventsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '批注设置操作过于频繁');

    const previousPermission = state.permission;
    const remoteControlDisabled =
      state.remoteControlAllowed && payload.remoteControlAllowed === false;
    let changed = false;
    if (payload.enabled !== undefined && payload.enabled !== state.enabled) {
      state.enabled = payload.enabled;
      changed = true;
      if (!payload.enabled) {
        state.requests = [];
        state.grants = [];
      }
    }
    if (payload.permission !== undefined && payload.permission !== state.permission) {
      state.permission = payload.permission;
      state.requests = [];
      state.grants = [];
      changed = true;
    }
    if (
      payload.remoteControlAllowed !== undefined &&
      payload.remoteControlAllowed !== state.remoteControlAllowed
    ) {
      state.remoteControlAllowed = payload.remoteControlAllowed;
      changed = true;
    }
    if (previousPermission !== state.permission && state.permission !== 'request') {
      state.requests = [];
      state.grants = [];
    }
    if (changed) state.revision += 1;
    if (remoteControlDisabled)
      deps.stopRemoteControlForSocket(state.sharerSocketId, '共享者已关闭远程控制');
    if (changed) emitState(state);
    return snapshotResult(state);
  }

  function request(target: AnnotationTarget, requesterSocketId: string): ServiceResult {
    const resolved = resolveTarget(target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    if (requesterSocketId === state.sharerSocketId)
      return failure('invalid_payload', '共享者不需要向自己申请批注权限');
    if (!state.enabled) return failure('disabled', '共享者尚未开启屏幕批注');
    if (state.permission === 'everyone' || state.grants.includes(requesterSocketId))
      return snapshotResult(state);
    if (state.permission === 'sharer')
      return failure('forbidden', '共享者当前只允许自己批注');
    if (
      !consumeRate(
        requesterSocketId,
        'request',
        ANNOTATION_LIMITS.requestsPerMinute,
        REQUEST_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '权限申请过于频繁，请稍后再试');
    if (state.requests.some((entry) => entry.socketId === requesterSocketId))
      return snapshotResult(state);
    if (state.requests.length >= ANNOTATION_LIMITS.requests)
      return failure('limit_reached', '当前待处理的批注申请过多');
    state.requests.push({
      socketId: requesterSocketId,
      username: (deps.userNames.get(requesterSocketId) ?? '成员').slice(0, 64),
    });
    state.revision += 1;
    emitState(state);
    return snapshotResult(state);
  }

  function respond(payload: AnnotationRespondPayload, requesterSocketId: string): ServiceResult {
    const resolved = resolveTarget(payload?.target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    if (requesterSocketId !== state.sharerSocketId)
      return failure('forbidden', '只有屏幕共享者可以处理批注申请');
    if (!validStringId(payload.requesterSocketId) || typeof payload.accepted !== 'boolean')
      return failure('invalid_payload', '申请处理信息无效');
    if (
      !consumeRate(
        requesterSocketId,
        'respond',
        ANNOTATION_LIMITS.respondEventsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '申请处理过于频繁');
    const requestIndex = state.requests.findIndex(
      (entry) => entry.socketId === payload.requesterSocketId,
    );
    if (requestIndex < 0) return failure('not_found', '批注申请不存在或已处理');
    if (!memberOfRoom(state.roomId, payload.requesterSocketId)) {
      state.requests.splice(requestIndex, 1);
      state.revision += 1;
      emitState(state);
      return failure('not_found', '申请者已离开频道');
    }
    state.requests.splice(requestIndex, 1);
    if (payload.accepted && !state.grants.includes(payload.requesterSocketId))
      state.grants.push(payload.requesterSocketId);
    state.revision += 1;
    emitState(state);
    return snapshotResult(state);
  }

  function draw(
    payload: { target: AnnotationTarget; stroke: AnnotationStrokeInput },
    requesterSocketId: string,
  ): ServiceResult {
    const resolved = resolveTarget(payload?.target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    const denied = authorizedResult(state, requesterSocketId);
    if (denied) return denied;
    const strokeInput = validatedStroke(payload.stroke);
    if (!strokeInput) return failure('invalid_payload', '批注笔画格式无效');
    if (
      !consumeRate(
        requesterSocketId,
        'draw',
        ANNOTATION_LIMITS.drawEventsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '批注发送过于频繁');

    const existing = state.strokes.find((stroke) => stroke.id === strokeInput.id);
    if (
      existing &&
      (existing.authorSocketId !== requesterSocketId ||
        existing.tool !== strokeInput.tool ||
        existing.color !== strokeInput.color ||
        existing.width !== strokeInput.width)
    )
      return failure('forbidden', '笔画编号已被其他成员使用');
    if (!existing && state.strokes.length >= ANNOTATION_LIMITS.strokes)
      return failure('limit_reached', '当前屏幕批注笔画过多，请先清空画布');
    if (
      (existing && existing.points.length + strokeInput.points.length > ANNOTATION_LIMITS.pointsPerStroke) ||
      totalPoints(state) + strokeInput.points.length > ANNOTATION_LIMITS.points
    )
      return failure('limit_reached', '当前屏幕批注点数过多，请先清空画布');

    const chunk: AnnotationStroke = {
      ...strokeInput,
      authorSocketId: requesterSocketId,
      points: strokeInput.points.map((point) => ({ ...point })),
    };
    if (existing) existing.points.push(...chunk.points);
    else state.strokes.push({ ...chunk, points: [...chunk.points] });
    state.revision += 1;
    const event: AnnotationStrokeEvent = {
      sessionId: state.sessionId,
      revision: state.revision,
      stroke: chunk,
    };
    deps.io.to(state.roomId).emit('annotation:stroke', event);
    return { ack: { ok: true, revision: state.revision } };
  }

  function laser(target: AnnotationTarget, point: unknown, requesterSocketId: string): ServiceResult {
    const resolved = resolveTarget(target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    const denied = authorizedResult(state, requesterSocketId);
    if (denied) return denied;
    if (point !== null && !validPoint(point))
      return failure('invalid_payload', '激光指示位置无效');
    if (
      !consumeRate(
        requesterSocketId,
        'laser',
        ANNOTATION_LIMITS.laserEventsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '激光指示发送过于频繁');
    const event: AnnotationLaserEvent = {
      sessionId: state.sessionId,
      authorSocketId: requesterSocketId,
      point:
        point === null
          ? null
          : { x: (point as AnnotationPoint).x, y: (point as AnnotationPoint).y },
    };
    deps.io.to(state.roomId).volatile.emit('annotation:laser', event);
    return { ack: { ok: true, revision: state.revision } };
  }

  function clear(target: AnnotationTarget, requesterSocketId: string): ServiceResult {
    const resolved = resolveTarget(target, requesterSocketId);
    if (!resolved.state) return { ack: { ok: false, error: resolved.error } };
    const state = resolved.state;
    const denied = authorizedResult(state, requesterSocketId);
    if (denied) return denied;
    if (
      !consumeRate(
        requesterSocketId,
        'clear',
        ANNOTATION_LIMITS.clearEventsPerSecond,
        POINT_RATE_WINDOW_MS,
      )
    )
      return failure('rate_limited', '清空画布操作过于频繁');
    state.strokes = [];
    state.revision += 1;
    emitState(state);
    return snapshotResult(state);
  }

  function remoteControlAllowed(roomId: string, sharerSocketId: string) {
    const sessionId = deps.currentScreenSessionId(roomId, sharerSocketId);
    if (!sessionId) return false;
    return states.get(stateKey(roomId, sharerSocketId, sessionId))?.remoteControlAllowed ?? true;
  }

  function endForSocket(sharerSocketId: string, roomId?: string, sessionId?: string) {
    for (const [key, state] of states) {
      if (
        state.sharerSocketId !== sharerSocketId ||
        (roomId !== undefined && state.roomId !== roomId) ||
        (sessionId !== undefined && state.sessionId !== sessionId)
      )
        continue;
      state.enabled = false;
      state.strokes = [];
      state.grants = [];
      state.requests = [];
      state.revision += 1;
      emitState(state);
      states.delete(key);
    }
  }

  function endForRoom(roomId: string) {
    for (const [key, state] of states) {
      if (state.roomId !== roomId) continue;
      state.enabled = false;
      state.strokes = [];
      state.grants = [];
      state.requests = [];
      state.revision += 1;
      emitState(state);
      states.delete(key);
    }
  }

  /** Called when a member actually leaves a room or disconnects, not when they close the annotation tool. */
  function removeMember(socketId: string, roomId?: string) {
    rates.forEach((_window, key) => {
      if (key.startsWith(`${socketId}\u0000`)) rates.delete(key);
    });
    for (const state of [...states.values()]) {
      if (roomId !== undefined && state.roomId !== roomId) continue;
      if (state.sharerSocketId === socketId) {
        endForSocket(socketId, state.roomId, state.sessionId);
        continue;
      }
      const beforeRequests = state.requests.length;
      const beforeGrants = state.grants.length;
      state.requests = state.requests.filter((entry) => entry.socketId !== socketId);
      state.grants = state.grants.filter((grant) => grant !== socketId);
      if (state.requests.length !== beforeRequests || state.grants.length !== beforeGrants) {
        state.revision += 1;
        emitState(state);
      }
    }
  }

  return {
    get,
    configure,
    request,
    respond,
    draw,
    laser,
    clear,
    remoteControlAllowed,
    endForSocket,
    endForRoom,
    removeMember,
    /** For focused unit tests and bounded runtime diagnostics. */
    sessionCount: () => states.size,
  };
}
