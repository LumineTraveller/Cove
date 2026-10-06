import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnnotationAck,
  AnnotationGetTarget,
  AnnotationLaserEvent,
  AnnotationPermission,
  AnnotationPoint,
  AnnotationState,
  AnnotationStroke,
  AnnotationStrokeEvent,
  AnnotationTarget,
  AnnotationTool,
} from '@cove/contracts';
import type { Socket } from 'socket.io-client';

import { preferNewerAnnotationState, upsertAnnotationStroke } from './annotationModel';

const DRAW_INTERVAL_MS = 1000 / 30;
const MAX_POINTS_PER_CHUNK = 64;
const MAX_POINTS_PER_STROKE = 2_048;
const MAX_STROKES_PER_SESSION = 400;
const MAX_POINTS_PER_SESSION = 16_000;
const ACK_TIMEOUT_MS = 10_000;
const LASER_EXPIRY_MS = 2_500;
const ALLOWED_KEY = 'cove_annotations_allowed';

function savedAnnotationAllowance() {
  try { return localStorage.getItem(ALLOWED_KEY) !== 'false'; } catch { return true; }
}

type AnnotationSocket = Socket<
  import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
  import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
>;

export type AnnotationPendingAction =
  | 'starting'
  | 'request'
  | 'permission'
  | 'remote-control'
  | 'respond'
  | 'clear';

export interface UseScreenAnnotationsOptions {
  socket: AnnotationSocket;
  roomId: string;
  sharerSocketId: string;
  /** Current video producer id. Null while the screen generation is inactive. */
  sessionId: string | null;
  self: boolean;
  active: boolean;
}

interface AnnotationScope {
  generation: number;
  connectionGeneration: number;
  key: string;
  target: AnnotationTarget;
  socket: AnnotationSocket;
  self: boolean;
}

interface PendingStroke {
  id: string;
  tool: AnnotationTool;
  color: string;
  width: number;
  points: AnnotationPoint[];
  unsent: AnnotationPoint[];
  echoedPoints: number;
  sentPoints: number;
  timer: ReturnType<typeof setTimeout> | null;
  final: boolean;
}

/**
 * Owns one screen producer's annotation session. Tool exit is local; the room's
 * annotation session remains enabled until the screen producer itself ends.
 */
export function useScreenAnnotations({
  socket,
  roomId,
  sharerSocketId,
  sessionId,
  self,
  active,
}: UseScreenAnnotationsOptions) {
  const [state, setState] = useState<AnnotationState | null>(null);
  const [ready, setReady] = useState(false);
  const [localActive, setLocalActiveState] = useState(false);
  const [optimisticStrokes, setOptimisticStrokes] = useState<AnnotationStroke[]>([]);
  const [laserPoints, setLaserPoints] = useState<Record<string, AnnotationPoint>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AnnotationPendingAction | null>(null);
  const [annotationsAllowed, setAnnotationsAllowedState] = useState(savedAnnotationAllowance);
  const initializedSession = useRef<string | null>(null);

  const scopeRef = useRef<AnnotationScope | null>(null);
  const generationRef = useRef(0);
  const stateRef = useRef<AnnotationState | null>(null);
  const readyRef = useRef(false);
  const localActiveRef = useRef(false);
  const pendingStrokesRef = useRef(new Map<string, PendingStroke>());
  const rejectedStrokeIdsRef = useRef(new Set<string>());
  const laserTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const bufferedEventsRef = useRef<AnnotationStrokeEvent[]>([]);
  const actionIdRef = useRef(0);
  const inputLimitHitRef = useRef(false);
  const acceptSnapshotRef = useRef<(scope: AnnotationScope, snapshot: AnnotationState) => void>(
    () => {},
  );
  const requestSnapshotRef = useRef<
    (scope: AnnotationScope) => Promise<AnnotationAck | null>
  >(async () => null);
  const flushStrokeRef = useRef<(scope: AnnotationScope, stroke: PendingStroke) => void>(() => {});
  const sendLaserRef = useRef<(scope: AnnotationScope, point: AnnotationPoint | null) => void>(
    () => {},
  );

  const updateReady = useCallback((value: boolean) => {
    readyRef.current = value;
    setReady(value);
  }, []);

  const updateLocalActive = useCallback((value: boolean) => {
    localActiveRef.current = value;
    setLocalActiveState(value);
  }, []);

  const refreshOptimisticStrokes = useCallback(() => {
    const confirmed = stateRef.current?.strokes ?? [];
    const socketId = scopeRef.current?.socket.id ?? 'local';
    const next: AnnotationStroke[] = [];
    for (const pending of pendingStrokesRef.current.values()) {
      const accepted = confirmed.find(
        (stroke) => stroke.id === pending.id && stroke.authorSocketId === socketId,
      );
      if (accepted)
        pending.echoedPoints = Math.max(
          pending.echoedPoints,
          Math.min(pending.points.length, accepted.points.length),
        );
      const tail = pending.points.slice(pending.echoedPoints);
      if (tail.length === 0) continue;
      const continuation =
        pending.echoedPoints > 0 ? pending.points[pending.echoedPoints - 1] : undefined;
      next.push({
        id: pending.id,
        authorSocketId: socketId,
        tool: pending.tool,
        color: pending.color,
        width: pending.width,
        points: continuation ? [continuation, ...tail] : tail,
      });
    }
    setOptimisticStrokes(next);
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    const valid = active && Boolean(roomId) && Boolean(sharerSocketId) && Boolean(sessionId);
    stateRef.current = null;
    bufferedEventsRef.current = [];
    for (const stroke of pendingStrokesRef.current.values())
      if (stroke.timer) clearTimeout(stroke.timer);
    pendingStrokesRef.current.clear();
    rejectedStrokeIdsRef.current.clear();
    for (const timer of laserTimersRef.current.values()) clearTimeout(timer);
    laserTimersRef.current.clear();
    scopeRef.current = null;
    inputLimitHitRef.current = false;
    readyRef.current = false;
    localActiveRef.current = false;
    setState(null);
    setReady(false);
    setLocalActiveState(false);
    setOptimisticStrokes([]);
    setLaserPoints({});
    setError(null);
    setPendingAction(null);
    if (!valid || !sessionId) return;

    const target: AnnotationTarget = { roomId, sharerSocketId, sessionId };
    const scope: AnnotationScope = {
      generation,
      connectionGeneration: 0,
      key: `${roomId}\u0000${sharerSocketId}\u0000${sessionId}\u0000${self ? 'self' : 'viewer'}`,
      target,
      socket,
      self,
    };
    scopeRef.current = scope;

    const isCurrent = () => scopeRef.current === scope;
    const cancelStrokeQueue = () => {
      for (const stroke of pendingStrokesRef.current.values())
        if (stroke.timer) clearTimeout(stroke.timer);
      pendingStrokesRef.current.clear();
      setOptimisticStrokes([]);
    };
    let lastLaserSentAt = 0;
    let queuedLaserPoint: AnnotationPoint | null = null;
    let laserFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLaserQueue = () => {
      queuedLaserPoint = null;
      if (laserFlushTimer) clearTimeout(laserFlushTimer);
      laserFlushTimer = null;
    };
    const clearAllLaserPoints = () => {
      clearLaserQueue();
      for (const timer of laserTimersRef.current.values()) clearTimeout(timer);
      laserTimersRef.current.clear();
      setLaserPoints({});
    };
    const emitLaser = (point: AnnotationPoint | null) => {
      if (!isCurrent() || !socket.connected) return;
      socket.volatile.emit('annotation:laser', { target, point });
      lastLaserSentAt = Date.now();
    };
    const flushLaserPoint = () => {
      laserFlushTimer = null;
      const point = queuedLaserPoint;
      queuedLaserPoint = null;
      if (!point || !isCurrent() || !canDrawNow(scope, stateRef.current, localActiveRef.current))
        return;
      emitLaser(point);
    };
    sendLaserRef.current = (candidate, point) => {
      if (candidate !== scope || !socket.connected) return;
      const socketId = socket.id;
      if (point === null) {
        clearLaserQueue();
        if (socketId)
          setLaserPoints((current) => {
            if (!(socketId in current)) return current;
            const next = { ...current };
            delete next[socketId];
            return next;
          });
        emitLaser(null);
        return;
      }
      if (!socketId || !canDrawNow(scope, stateRef.current, localActiveRef.current)) return;
      const normalized = normalizePoint(point);
      queuedLaserPoint = normalized;
      setLaserPoints((current) => ({ ...current, [socketId]: normalized }));
      const delay = lastLaserSentAt ? DRAW_INTERVAL_MS - (Date.now() - lastLaserSentAt) : 0;
      if (delay <= 0) flushLaserPoint();
      else if (!laserFlushTimer) laserFlushTimer = setTimeout(flushLaserPoint, delay);
    };
    const canSubmitPending = () => {
      const current = stateRef.current;
      if (!isCurrent() || !socket.connected || !current?.enabled) return false;
      if (self || current.permission === 'everyone') return true;
      return current.permission === 'request' && Boolean(socket.id && current.grants.includes(socket.id));
    };
    const maybeRetireFinalStrokes = () => {
      const confirmed = stateRef.current?.strokes ?? [];
      const socketId = socket.id;
      for (const [id, stroke] of pendingStrokesRef.current) {
        const accepted = confirmed.find(
          (item) => item.id === id && item.authorSocketId === socketId,
        );
        if (accepted)
          stroke.echoedPoints = Math.max(
            stroke.echoedPoints,
            Math.min(stroke.points.length, accepted.points.length),
          );
        if (
          stroke.final &&
          stroke.unsent.length === 0 &&
          stroke.echoedPoints >= stroke.points.length
        ) {
          if (stroke.timer) clearTimeout(stroke.timer);
          pendingStrokesRef.current.delete(id);
        }
      }
      refreshOptimisticStrokes();
    };

    const applyStrokeEvent = (event: AnnotationStrokeEvent, requestOnGap: boolean) => {
      if (!isCurrent() || event.sessionId !== sessionId) return;
      const current = stateRef.current;
      if (!current) {
        if (bufferedEventsRef.current.length < 200) bufferedEventsRef.current.push(event);
        return;
      }
      if (event.revision <= current.revision) return;
      const hasGap = event.revision > current.revision + 1;
      const next = {
        ...current,
        revision: event.revision,
        strokes: upsertAnnotationStroke(current.strokes, event.stroke),
      };
      stateRef.current = next;
      setState(next);
      maybeRetireFinalStrokes();
      if (hasGap && requestOnGap) void requestSnapshotRef.current(scope);
    };

    const applySnapshot = (incoming: AnnotationState) => {
      if (
        !isCurrent() ||
        incoming.roomId !== roomId ||
        incoming.sharerSocketId !== sharerSocketId ||
        incoming.sessionId !== sessionId
      )
        return;
      const current = stateRef.current;
      if (current && current.revision > incoming.revision) return;
      const next = preferNewerAnnotationState(current, incoming);
      stateRef.current = next;
      setState(next);
      updateReady(true);
      if (!next.enabled) updateLocalActive(false);
      const permissionsChanged = Boolean(
        current &&
          (current.permission !== next.permission ||
            current.grants.join('|') !== next.grants.join('|')),
      );
      if (!next.enabled || permissionsChanged) clearAllLaserPoints();
      const canStillDraw =
        self ||
        next.permission === 'everyone' ||
        (next.permission === 'request' && Boolean(socket.id && next.grants.includes(socket.id)));
      if (!next.enabled || !canStillDraw) cancelStrokeQueue();
      else maybeRetireFinalStrokes();

      const buffered = bufferedEventsRef.current
        .filter((event) => event.sessionId === sessionId && event.revision > next.revision)
        .sort((left, right) => left.revision - right.revision);
      bufferedEventsRef.current = [];
      for (const event of buffered) applyStrokeEvent(event, false);
    };
    acceptSnapshotRef.current = (candidate, snapshot) => {
      if (candidate === scope) applySnapshot(snapshot);
    };

    let inFlightGet: Promise<AnnotationAck | null> | null = null;
    let cancelInFlightGet: (() => void) | null = null;
    let connectionGeneration = 0;
    const requestSnapshot = (): Promise<AnnotationAck | null> => {
      if (!isCurrent() || !socket.connected) return Promise.resolve(null);
      if (inFlightGet) return inFlightGet;
      const requestGeneration = connectionGeneration;
      const getTarget: AnnotationGetTarget = { ...target };
      let resolveGet!: (ack: AnnotationAck | null) => void;
      let settled = false;
      const promise = new Promise<AnnotationAck | null>((resolve) => {
        resolveGet = resolve;
      });
      inFlightGet = promise;
      const finish = (ack: AnnotationAck | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (inFlightGet === promise) inFlightGet = null;
        if (cancelInFlightGet === cancel) cancelInFlightGet = null;
        resolveGet(ack);
      };
      const cancel = () => finish(null);
      cancelInFlightGet = cancel;
      const timeout = setTimeout(() => {
        if (isCurrent() && requestGeneration === connectionGeneration) {
          updateReady(false);
          setError('获取批注状态超时');
        }
        finish(null);
      }, ACK_TIMEOUT_MS);
      socket.emit('annotation:get', { target: getTarget }, (ack?: AnnotationAck) => {
        if (!isCurrent() || requestGeneration !== connectionGeneration) return finish(null);
        if (ack?.state) applySnapshot(ack.state);
        if (!ack?.ok) setError(ack?.error?.message ?? '无法获取批注状态');
        else setError(null);
        finish(ack ?? null);
      });
      return promise;
    };
    requestSnapshotRef.current = (candidate) =>
      candidate === scope ? requestSnapshot() : Promise.resolve(null);

    let lastDrawSentAt = 0;
    const scheduleStroke = (stroke: PendingStroke, delay: number) => {
      if (stroke.timer || !isCurrent()) return;
      stroke.timer = setTimeout(() => {
        stroke.timer = null;
        flushStroke(stroke);
      }, Math.max(0, delay));
    };

    const flushStroke = (stroke: PendingStroke) => {
      if (!isCurrent() || !pendingStrokesRef.current.has(stroke.id)) return;
      if (!canSubmitPending()) {
        cancelStrokeQueue();
        return;
      }
      if (stroke.unsent.length === 0) {
        maybeRetireFinalStrokes();
        return;
      }
      const wait = lastDrawSentAt ? DRAW_INTERVAL_MS - (Date.now() - lastDrawSentAt) : 0;
      if (wait > 0) {
        scheduleStroke(stroke, wait);
        return;
      }
      const points = stroke.unsent.splice(0, MAX_POINTS_PER_CHUNK);
      stroke.sentPoints += points.length;
      lastDrawSentAt = Date.now();
      const payload = {
        target,
        stroke: {
          id: stroke.id,
          tool: stroke.tool,
          color: stroke.color,
          width: stroke.width,
          points,
        },
      };
      const requestGeneration = scope.connectionGeneration;
      socket.emit('annotation:draw', payload, (ack?: AnnotationAck) => {
        if (!isCurrent() || requestGeneration !== scope.connectionGeneration) return;
        if (ack?.state) applySnapshot(ack.state);
        if (!ack?.ok) {
          const message = ack?.error?.message ?? '批注笔画发送失败';
          setError(message);
          rejectedStrokeIdsRef.current.delete(stroke.id);
          rejectedStrokeIdsRef.current.add(stroke.id);
          if (rejectedStrokeIdsRef.current.size > MAX_STROKES_PER_SESSION) {
            const oldest = rejectedStrokeIdsRef.current.values().next().value;
            if (oldest) rejectedStrokeIdsRef.current.delete(oldest);
          }
          if (stroke.timer) clearTimeout(stroke.timer);
          stroke.timer = null;
          pendingStrokesRef.current.delete(stroke.id);
          refreshOptimisticStrokes();
          if (
            ack?.error?.code === 'forbidden' ||
            ack?.error?.code === 'disabled' ||
            ack?.error?.code === 'not_found' ||
            ack?.error?.code === 'invalid_target'
          ) {
            updateLocalActive(false);
            cancelStrokeQueue();
          }
          void requestSnapshotRef.current(scope).finally(() => {
            if (isCurrent()) setError(message);
          });
          return;
        }
        if (!inputLimitHitRef.current) setError(null);
        maybeRetireFinalStrokes();
      });
      refreshOptimisticStrokes();
      if (stroke.unsent.length > 0) scheduleStroke(stroke, DRAW_INTERVAL_MS);
    };
    flushStrokeRef.current = (candidate, stroke) => {
      if (candidate === scope) flushStroke(stroke);
    };

    const onAnnotationState = (snapshot: AnnotationState) => applySnapshot(snapshot);
    const onAnnotationStroke = (event: AnnotationStrokeEvent) => applyStrokeEvent(event, true);
    const onAnnotationLaser = (event: AnnotationLaserEvent) => {
      if (!isCurrent() || event.sessionId !== sessionId || !event.authorSocketId) return;
      const previousTimer = laserTimersRef.current.get(event.authorSocketId);
      if (previousTimer) clearTimeout(previousTimer);
      setLaserPoints((current) => {
        if (event.point === null) {
          if (!(event.authorSocketId in current)) return current;
          const next = { ...current };
          delete next[event.authorSocketId];
          return next;
        }
        return { ...current, [event.authorSocketId]: event.point };
      });
      if (event.point === null) {
        laserTimersRef.current.delete(event.authorSocketId);
        return;
      }
      const timer = setTimeout(() => {
        if (!isCurrent() || laserTimersRef.current.get(event.authorSocketId) !== timer) return;
        laserTimersRef.current.delete(event.authorSocketId);
        setLaserPoints((current) => {
          if (!(event.authorSocketId in current)) return current;
          const next = { ...current };
          delete next[event.authorSocketId];
          return next;
        });
      }, LASER_EXPIRY_MS);
      laserTimersRef.current.set(event.authorSocketId, timer);
    };
    const onDisconnect = () => {
      if (!isCurrent()) return;
      scope.connectionGeneration += 1;
      actionIdRef.current += 1;
      setPendingAction(null);
      connectionGeneration += 1;
      cancelInFlightGet?.();
      updateReady(false);
      updateLocalActive(false);
      cancelStrokeQueue();
      clearAllLaserPoints();
    };
    const onConnect = () => {
      if (!isCurrent()) return;
      scope.connectionGeneration += 1;
      actionIdRef.current += 1;
      setPendingAction(null);
      connectionGeneration += 1;
      updateReady(false);
      updateLocalActive(false);
      cancelStrokeQueue();
      clearAllLaserPoints();
      void requestSnapshot();
    };

    socket.on('annotation:state', onAnnotationState);
    socket.on('annotation:stroke', onAnnotationStroke);
    socket.on('annotation:laser', onAnnotationLaser);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    if (socket.connected) void requestSnapshot();

    return () => {
      socket.off('annotation:state', onAnnotationState);
      socket.off('annotation:stroke', onAnnotationStroke);
      socket.off('annotation:laser', onAnnotationLaser);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      cancelStrokeQueue();
      clearAllLaserPoints();
      bufferedEventsRef.current = [];
      if (scopeRef.current === scope) scopeRef.current = null;
      if (acceptSnapshotRef.current) acceptSnapshotRef.current = () => {};
      requestSnapshotRef.current = async () => null;
      flushStrokeRef.current = () => {};
      sendLaserRef.current = () => {};
    };
  }, [
    active,
    roomId,
    sessionId,
    sharerSocketId,
    self,
    socket,
    updateLocalActive,
    updateReady,
    refreshOptimisticStrokes,
  ]);

  const performAction = useCallback(
    (event: string, payload: unknown, action: AnnotationPendingAction) => {
      const scope = scopeRef.current;
      if (!scope || !scope.socket.connected) {
        setError('连接已断开，无法操作批注');
        return Promise.resolve(null);
      }
      const connectionGeneration = scope.connectionGeneration;
      const actionId = ++actionIdRef.current;
      setPendingAction(action);
      inputLimitHitRef.current = false;
      setError(null);
      return new Promise<AnnotationAck | null>((resolve) => {
        let settled = false;
        const finish = (ack: AnnotationAck | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (scopeRef.current === scope && actionIdRef.current === actionId)
            setPendingAction(null);
          resolve(ack);
        };
        const timeout = setTimeout(() => {
          if (
            scopeRef.current === scope &&
            scope.connectionGeneration === connectionGeneration
          )
            setError('批注操作超时');
          finish(null);
        }, ACK_TIMEOUT_MS);
        scope.socket.emit(event, payload, (ack?: AnnotationAck) => {
          if (
            scopeRef.current !== scope ||
            scope.connectionGeneration !== connectionGeneration
          )
            return finish(null);
          if (ack?.state) acceptSnapshotRef.current(scope, ack.state);
          if (!ack?.ok) setError(ack?.error?.message ?? '批注操作失败');
          else setError(null);
          finish(ack ?? null);
        });
      });
    },
    [],
  );

  const start = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || !scope.socket.connected) {
      setError('批注会话尚未就绪');
      return;
    }
    let current = stateRef.current;
    if (!readyRef.current || !current) {
      const connectionGeneration = scope.connectionGeneration;
      setPendingAction('starting');
      const ack = await requestSnapshotRef.current(scope);
      if (
        scopeRef.current !== scope ||
        scope.connectionGeneration !== connectionGeneration ||
        !scope.socket.connected
      )
        return;
      setPendingAction(null);
      current = ack?.state ?? stateRef.current;
    }
    if (!current) {
      setError('无法获取批注状态');
      return;
    }
    if (scope.self) {
      if (!current.enabled) {
        setError('批注已关闭，请先在管理共享中开启批注');
        return;
      }
      updateLocalActive(true);
      setError(null);
      return;
    }

    if (!current.enabled) {
      setError('共享者尚未开启批注');
      return;
    }
    updateLocalActive(true);
    const socketId = scope.socket.id;
    const alreadyGranted = Boolean(socketId && current.grants.includes(socketId));
    const requestPending = Boolean(
      socketId && current.requests.some((request) => request.socketId === socketId),
    );
    if (current.permission === 'request' && !alreadyGranted && !requestPending) {
      await performAction('annotation:request', { target: scope.target }, 'request');
    }
  }, [performAction, updateLocalActive]);

  // Opening the room session is independent from taking over local mouse input.
  // The existing owner-only configure API retains room/producer validation.
  useEffect(() => {
    const scope = scopeRef.current;
    if (!self || !active || !ready || !state || !scope) return;
    const key = `${scope.key}\u0000${scope.connectionGeneration}`;
    if (initializedSession.current === key) return;
    initializedSession.current = key;
    if (state.revision !== 0 && state.permission === 'everyone') return;
    void performAction('annotation:configure', {
      target: scope.target, enabled: state.revision === 0 ? savedAnnotationAllowance() : state.enabled,
      permission: 'everyone',
    }, 'permission');
  }, [self, active, ready, state, performAction]);

  const setAnnotationsAllowed = useCallback(async (allowed: boolean) => {
    const scope = scopeRef.current;
    if (!scope?.self) return;
    const ack = await performAction('annotation:configure', {
      target: scope.target, enabled: allowed, permission: 'everyone',
    }, 'permission');
    if (!ack?.ok || scopeRef.current !== scope) return;
    setAnnotationsAllowedState(allowed);
    try { localStorage.setItem(ALLOWED_KEY, String(allowed)); } catch { /* Session still applies. */ }
  }, [performAction]);

  const exit = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) {
      updateLocalActive(false);
      return;
    }
    for (const stroke of pendingStrokesRef.current.values()) {
      stroke.final = true;
      flushStrokeRef.current(scope, stroke);
    }
    updateLocalActive(false);
    sendLaserRef.current(scope, null);
  }, [updateLocalActive]);

  const configurePermission = useCallback(
    async (permission: AnnotationPermission) => {
      const scope = scopeRef.current;
      if (!scope?.self) return;
      await performAction(
        'annotation:configure',
        { target: scope.target, permission },
        'permission',
      );
    },
    [performAction],
  );

  const setRemoteControlAllowed = useCallback(
    async (allowed: boolean) => {
      const scope = scopeRef.current;
      if (!scope?.self) return;
      await performAction(
        'annotation:configure',
        { target: scope.target, remoteControlAllowed: allowed },
        'remote-control',
      );
    },
    [performAction],
  );

  const respond = useCallback(
    async (requesterSocketId: string, accepted: boolean) => {
      const scope = scopeRef.current;
      if (!scope?.self) return;
      await performAction(
        'annotation:respond',
        { target: scope.target, requesterSocketId, accepted },
        'respond',
      );
    },
    [performAction],
  );

  const clear = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || !canDrawNow(scope, stateRef.current, localActiveRef.current)) return;
    await performAction('annotation:clear', { target: scope.target }, 'clear');
  }, [performAction]);

  const sendStroke = useCallback(
    (
      tool: AnnotationTool,
      color: string,
      width: number,
      points: readonly AnnotationPoint[],
      strokeId?: string,
      final = false,
    ): string | null => {
      const scope = scopeRef.current;
      if (!scope || !canDrawNow(scope, stateRef.current, localActiveRef.current)) return null;
      const id = strokeId?.trim() || createStrokeId();
      if (rejectedStrokeIdsRef.current.has(id)) return null;
      let stroke = pendingStrokesRef.current.get(id);
      if (!stroke) {
        stroke = {
          id,
          tool,
          color: normalizeColor(color),
          width: normalizeWidth(width),
          points: [],
          unsent: [],
          echoedPoints: 0,
          sentPoints: 0,
          timer: null,
          final: false,
        };
        const knownStrokeIds = new Set([
          ...(stateRef.current?.strokes ?? []).map((item) => item.id),
          ...pendingStrokesRef.current.keys(),
        ]);
        if (knownStrokeIds.size >= MAX_STROKES_PER_SESSION) {
          inputLimitHitRef.current = true;
          setError('批注已达到笔画数量上限，请清除后继续');
          return null;
        }
        pendingStrokesRef.current.set(id, stroke);
      }
      const nextPoints = normalizePoints(points);
      if (nextPoints.length > 0) {
        const current = stateRef.current;
        const confirmedById = new Map((current?.strokes ?? []).map((item) => [item.id, item]));
        let sessionPointCount = 0;
        for (const confirmed of current?.strokes ?? []) {
          sessionPointCount += Math.max(
            confirmed.points.length,
            pendingStrokesRef.current.get(confirmed.id)?.points.length ?? 0,
          );
        }
        for (const [pendingId, pending] of pendingStrokesRef.current) {
          if (!confirmedById.has(pendingId)) sessionPointCount += pending.points.length;
        }
        const allowedCount = Math.max(
          0,
          Math.min(
            MAX_POINTS_PER_STROKE - stroke.points.length,
            MAX_POINTS_PER_SESSION - sessionPointCount,
          ),
        );
        const acceptedPoints = nextPoints.slice(0, allowedCount);
        if (acceptedPoints.length < nextPoints.length) {
          inputLimitHitRef.current = true;
          setError('批注已达到点数上限，超出的笔画部分已忽略');
        }
        stroke.points.push(...acceptedPoints);
        stroke.unsent.push(...acceptedPoints);
      }
      stroke.final ||= final || !strokeId;
      refreshOptimisticStrokes();
      if (stroke.unsent.length > 0 || stroke.final) flushStrokeRef.current(scope, stroke);
      return id;
    },
    [refreshOptimisticStrokes],
  );

  const finishStroke = useCallback((strokeId: string) => {
    const scope = scopeRef.current;
    const stroke = pendingStrokesRef.current.get(strokeId);
    if (!scope || !stroke) return;
    stroke.final = true;
    flushStrokeRef.current(scope, stroke);
  }, []);

  const sendLaser = useCallback((point: AnnotationPoint | null) => {
    const scope = scopeRef.current;
    if (scope) sendLaserRef.current(scope, point);
  }, []);

  const currentState = state && state.sessionId === sessionId ? state : null;
  const permission = currentState?.permission ?? 'everyone';
  const socketId = socket.id;
  const granted = Boolean(socketId && currentState?.grants.includes(socketId));
  const canDraw = Boolean(
    active &&
      sessionId &&
      ready &&
      localActive &&
      socket.connected &&
      currentState?.enabled &&
      (self || permission === 'everyone' || (permission === 'request' && granted)),
  );
  const isRequestPending = Boolean(
    currentState?.requests.some((request) => request.socketId === socketId) ||
      pendingAction === 'request',
  );
  const remoteControlAllowed = currentState?.remoteControlAllowed ?? true;

  return {
    state: currentState,
    ready,
    localActive,
    start,
    exit,
    permission,
    canDraw,
    isRequestPending,
    remoteControlAllowed,
    annotationsAllowed: currentState?.enabled ?? annotationsAllowed,
    setAnnotationsAllowed,
    error,
    pendingAction,
    configurePermission,
    setRemoteControlAllowed,
    respond,
    clear,
    sendStroke,
    finishStroke,
    sendLaser,
    laserPoints,
    optimisticStrokes,
  };
}

function canDrawNow(
  scope: AnnotationScope,
  state: AnnotationState | null,
  localActive: boolean,
) {
  if (!scope.socket.connected || !localActive || !state?.enabled) return false;
  if (scope.self || state.permission === 'everyone') return true;
  return (
    state.permission === 'request' &&
    Boolean(scope.socket.id && state.grants.includes(scope.socket.id))
  );
}

function normalizePoints(points: readonly AnnotationPoint[]): AnnotationPoint[] {
  return points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map(normalizePoint);
}

function normalizePoint(point: AnnotationPoint): AnnotationPoint {
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

function normalizeWidth(width: number) {
  return Number.isFinite(width) ? clamp(width, 0.0005, 0.08) : 0.003;
}

function normalizeColor(color: string) {
  return /^#[\da-f]{6}$/i.test(color) ? color.toUpperCase() : '#FFFFFF';
}

function createStrokeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
