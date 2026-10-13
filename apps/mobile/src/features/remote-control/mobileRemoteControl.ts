import {
  isRemoteKeyCode,
  isRemotePoint,
  MOBILE_REMOTE_POINTER_INTERVAL_MS,
  remoteShortcut,
  remoteWheel,
  remoteCharacterKeys,
  textToRemoteInputs,
  type RemoteControlInput,
  type RemoteMouseButton,
  type RemotePoint,
} from './remoteInput';

type Listener = (...args: any[]) => void;
interface InputEngine {
  transport?: { writable: boolean };
  writeBuffer?: readonly unknown[];
  on(event: 'drain' | 'upgrade', listener: () => void): unknown;
  off(event: 'drain' | 'upgrade', listener: () => void): unknown;
}
export interface MobileRemoteSocket {
  id?: string;
  connected: boolean;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  emit(event: string, ...args: any[]): unknown;
  io?: { engine?: InputEngine };
}
export interface MobileRemoteSession {
  sessionId: string;
  roomId: string;
  role: 'controller';
  requestId: string;
  sharerSocketId: string;
  sharerUserId?: string;
  sharerName?: string;
}
export interface MobileRemotePending {
  targetSocketId: string;
  requestId?: string;
  expiresAt?: number;
}
export interface MobileRemoteState {
  session: MobileRemoteSession | null;
  pending: MobileRemotePending | null;
  error: string | null;
}

/** Synchronous controller authorization: React renders cannot revive a cancelled
 * request or leave an input pressed. Android never activates a receiver bridge. */
export class MobileRemoteControl {
  private state: MobileRemoteState = {
    session: null,
    pending: null,
    error: null,
  };
  private target: string | null = null;
  private allowed = false;
  private generation = 0;
  private inputGeneration = 0;
  private inputEnabled = true;
  private disposed = false;
  private connected: boolean;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMove: Extract<RemoteControlInput, { type: 'pointer' }> | null =
    null;
  private lastMoveAt = -Infinity;
  private waitingEngine: InputEngine | null = null;
  private readonly keys = new Set<string>();
  private readonly buttons = new Map<RemoteMouseButton, RemotePoint>();
  private readonly heldEdges: (
    | { type: 'key'; code: string }
    | { type: 'button'; button: RemoteMouseButton }
  )[] = [];
  private typing = false;
  private earlyStart: MobileRemoteSession | null = null;
  private earlyResult: { requestId: string; error?: string } | null = null;

  constructor(
    private readonly options: {
      roomId: string;
      socket: MobileRemoteSocket;
      onState: (state: MobileRemoteState) => void;
      now?: () => number;
    },
  ) {
    this.connected = options.socket.connected;
    const socket = options.socket;
    socket.on('remote-control:started', this.onStarted);
    socket.on('remote-control:stopped', this.onStopped);
    socket.on('remote-control:request-result', this.onRequestResult);
    socket.on('disconnect', this.onDisconnect);
    socket.on('connect', this.onConnect);
  }
  get snapshot() {
    return this.state;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private canConnect() {
    return !this.disposed && this.connected && this.options.socket.connected;
  }
  private publish(next: Partial<MobileRemoteState>) {
    this.state = { ...this.state, ...next };
    if (!this.disposed) this.options.onState(this.state);
  }
  setTarget(targetSocketId: string | null, allowed: boolean) {
    if (this.target !== targetSocketId || (this.allowed && !allowed))
      this.stop();
    this.target = targetSocketId;
    this.allowed = allowed;
  }
  /** Pause local input without discarding the approved remote session. Gesture
   * ownership on resume remains with the video surface: only a new touch starts. */
  setInputEnabled(enabled: boolean) {
    if (this.inputEnabled === enabled) return;
    this.inputEnabled = enabled;
    this.inputGeneration++;
    this.clearMoveWait();
    this.pendingMove = null;
    this.lastMoveAt = -Infinity;
    if (!enabled) this.releaseHeldInputs();
  }
  private releaseHeldInputs() {
    for (const edge of [...this.heldEdges].reverse()) {
      if (edge.type === 'key') {
        if (this.keys.has(edge.code))
          this.emitInput({ type: 'key', code: edge.code, down: false });
      } else {
        const point = this.buttons.get(edge.button);
        if (point)
          this.emitInput({
            type: 'button',
            button: edge.button,
            down: false,
            ...point,
          });
      }
    }
    this.keys.clear();
    this.buttons.clear();
    this.heldEdges.length = 0;
  }
  request(targetSocketId = this.target): boolean {
    if (
      !this.canConnect() ||
      !this.allowed ||
      !targetSocketId ||
      targetSocketId !== this.target ||
      targetSocketId === this.options.socket.id ||
      this.state.pending ||
      this.state.session
    )
      return false;
    const generation = ++this.generation;
    this.earlyResult = null;
    this.earlyStart = null;
    this.publish({ pending: { targetSocketId }, error: null });
    this.ackTimer = setTimeout(() => {
      if (generation === this.generation && this.state.pending) {
        this.stop();
        this.publish({ error: '远控请求确认超时，请重试' });
      }
    }, 8000);
    this.options.socket.emit(
      'remote-control:request',
      { roomId: this.options.roomId, sharerSocketId: targetSocketId },
      (reply?: {
        ok?: boolean;
        requestId?: string;
        expiresAt?: number;
        error?: string;
      }) => {
        if (generation !== this.generation || !this.canConnect()) {
          if (reply?.ok && reply.requestId && this.options.socket.connected)
            this.options.socket.emit('remote-control:cancel', {
              requestId: reply.requestId,
            });
          return;
        }
        this.clearAck();
        if (this.state.session) return;
        if (!reply?.ok || !reply.requestId) {
          this.stop();
          this.publish({
            error: reply?.error ?? '服务器未接受手机远控请求，需配套服务器支持',
          });
          return;
        }
        if (this.earlyResult?.requestId === reply.requestId) {
          const error = this.earlyResult.error;
          this.stop();
          this.publish({ error: error ?? '远控请求已结束' });
          return;
        }
        this.publish({
          pending: {
            targetSocketId,
            requestId: reply.requestId,
            expiresAt: reply.expiresAt,
          },
        });
        if (this.earlyStart) {
          const started = this.earlyStart;
          this.earlyStart = null;
          this.onStarted(started);
          if (this.state.session) return;
        }
        const remaining =
          typeof reply.expiresAt === 'number' &&
          Number.isFinite(reply.expiresAt)
            ? Math.max(0, Math.min(30000, reply.expiresAt - this.now()))
            : 30000;
        this.expiryTimer = setTimeout(() => {
          if (generation !== this.generation || !this.state.pending) return;
          this.stop();
          this.publish({ error: '远控请求已超时' });
        }, remaining + 100);
      },
    );
    return true;
  }
  private readonly onStarted = (raw: any) => {
    if (
      !raw ||
      raw.roomId !== this.options.roomId ||
      typeof raw.sessionId !== 'string'
    )
      return;
    if (
      this.state.session?.sessionId === raw.sessionId &&
      raw.role === 'controller'
    )
      return;
    if (!this.canConnect()) return;
    if (
      raw.role !== 'controller' ||
      typeof raw.requestId !== 'string' ||
      !this.allowed ||
      !this.state.pending ||
      raw.sharerSocketId !== this.target ||
      raw.sharerSocketId !== this.state.pending.targetSocketId
    ) {
      this.options.socket.emit('remote-control:stop', {
        sessionId: raw.sessionId,
      });
      if (raw.role !== 'controller') {
        this.stop();
        this.publish({ error: '手机仅支持作为远控控制端' });
      }
      return;
    }
    if (!this.state.pending.requestId) {
      this.earlyStart = raw;
      return;
    }
    if (raw.requestId !== this.state.pending.requestId) {
      this.options.socket.emit('remote-control:stop', {
        sessionId: raw.sessionId,
      });
      return;
    }
    this.clearRequestTimers();
    this.publish({
      session: raw as MobileRemoteSession,
      pending: null,
      error: null,
    });
  };
  private readonly onStopped = (raw: {
    sessionId?: string;
    reason?: string;
  }) => {
    if (
      !raw ||
      !this.state.session ||
      raw.sessionId !== this.state.session.sessionId
    )
      return;
    this.stop(false);
    this.publish({ error: raw.reason ?? '远程控制已结束' });
  };
  private readonly onRequestResult = (raw: {
    requestId?: string;
    accepted?: boolean;
    error?: string;
  }) => {
    if (!raw?.requestId || raw.accepted !== false || !this.state.pending)
      return;
    if (!this.state.pending.requestId) {
      this.earlyResult = { requestId: raw.requestId, error: raw.error };
      return;
    }
    if (raw.requestId !== this.state.pending.requestId) return;
    this.stop(false);
    this.publish({ error: raw.error ?? '远控请求已结束' });
  };
  private readonly onDisconnect = () => {
    this.connected = false;
    const wasActive = !!(this.state.pending || this.state.session);
    this.stop(false);
    if (wasActive) this.publish({ error: '连接已断开，远控已停止' });
  };
  private readonly onConnect = () => {
    this.connected = true;
  };
  private clearAck() {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }
  private clearRequestTimers() {
    this.clearAck();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
  private emitInput(input: RemoteControlInput) {
    if (!this.canConnect() || !this.allowed || !this.state.session)
      return false;
    this.options.socket.emit('remote-control:input', {
      sessionId: this.state.session.sessionId,
      input,
    });
    return true;
  }
  send(input: RemoteControlInput): boolean {
    if (
      !this.inputEnabled ||
      !this.canConnect() ||
      !this.allowed ||
      !this.state.session
    )
      return false;
    if (input.type === 'key') {
      if (!isRemoteKeyCode(input.code) || typeof input.down !== 'boolean')
        return false;
      if (input.down ? this.keys.has(input.code) : !this.keys.has(input.code))
        return false;
    } else {
      if (!isRemotePoint(input)) return false;
      if (
        input.type === 'button' &&
        (!['left', 'right', 'middle'].includes(input.button) ||
          typeof input.down !== 'boolean' ||
          (input.down
            ? this.buttons.has(input.button)
            : !this.buttons.has(input.button)))
      )
        return false;
      if (
        input.type === 'wheel' &&
        (!Number.isFinite(input.deltaX) ||
          !Number.isFinite(input.deltaY) ||
          Math.abs(input.deltaX) > 1200 ||
          Math.abs(input.deltaY) > 1200)
      )
        return false;
    }
    if (input.type === 'pointer') {
      for (const button of this.buttons.keys())
        this.buttons.set(button, { x: input.x, y: input.y });
      this.pendingMove = input;
      this.flushMove();
      return true;
    }
    this.flushMove(true);
    const sent = this.emitInput(input);
    if (!sent) return false;
    if (input.type === 'key') {
      if (input.down) {
        this.keys.add(input.code);
        this.heldEdges.push({ type: 'key', code: input.code });
      } else {
        this.keys.delete(input.code);
        const index = this.heldEdges.findIndex(
          edge => edge.type === 'key' && edge.code === input.code,
        );
        if (index >= 0) this.heldEdges.splice(index, 1);
      }
    } else if (input.type === 'button') {
      if (input.down) {
        this.buttons.set(input.button, { x: input.x, y: input.y });
        this.heldEdges.push({ type: 'button', button: input.button });
      } else {
        this.buttons.delete(input.button);
        const index = this.heldEdges.findIndex(
          edge => edge.type === 'button' && edge.button === input.button,
        );
        if (index >= 0) this.heldEdges.splice(index, 1);
      }
    }
    return true;
  }
  pointer(point: RemotePoint) {
    return this.send({ type: 'pointer', ...point });
  }
  button(button: RemoteMouseButton, down: boolean, point: RemotePoint) {
    return this.send({ type: 'button', button, down, ...point });
  }
  click(point: RemotePoint, button: RemoteMouseButton = 'left') {
    if (!this.button(button, true, point)) return false;
    return this.button(button, false, point);
  }
  wheel(point: RemotePoint, deltaX: number, deltaY: number) {
    const input = remoteWheel(point, deltaX, deltaY);
    return input ? this.send(input) : false;
  }
  key(code: string, down: boolean) {
    return this.send({ type: 'key', code, down });
  }
  shortcut(codes: readonly string[]) {
    if (!this.inputEnabled) return false;
    const inputs = remoteShortcut(codes);
    if (!inputs.length || codes.some(code => this.keys.has(code))) return false;
    for (const input of inputs) if (!this.send(input)) return false;
    return true;
  }
  async typeText(text: string): Promise<boolean> {
    if (!this.inputEnabled) return false;
    if (!textToRemoteInputs(text)) {
      this.publish({
        error: '当前远控协议仅支持英文、数字和常用英文标点（最多256字）',
      });
      return false;
    }
    if (
      this.typing ||
      this.keys.size ||
      !this.canConnect() ||
      !this.state.session
    )
      return false;
    const generation = this.generation;
    const inputGeneration = this.inputGeneration;
    this.typing = true;
    try {
      for (const character of text.replace(/\r\n?/g, '\n')) {
        if (
          generation !== this.generation ||
          inputGeneration !== this.inputGeneration ||
          !this.inputEnabled ||
          !this.shortcut(remoteCharacterKeys(character)!)
        )
          return false;
        // At most 125 key edges/s for shifted text, leaving the shared input
        // budget available for pointer traffic. Cancellation revokes each step.
        await new Promise<void>(resolve => setTimeout(resolve, 32));
      }
      return (
        generation === this.generation &&
        inputGeneration === this.inputGeneration &&
        this.inputEnabled
      );
    } finally {
      this.typing = false;
    }
  }
  private readonly onTransportReady = () => {
    this.flushMove();
  };
  private clearMoveWait() {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.waitingEngine?.off('drain', this.onTransportReady);
    this.waitingEngine?.off('upgrade', this.onTransportReady);
    this.waitingEngine = null;
  }
  private flushMove(force = false) {
    const move = this.pendingMove;
    if (!move) return;
    if (
      !this.inputEnabled ||
      !this.canConnect() ||
      !this.state.session ||
      !this.allowed
    ) {
      this.pendingMove = null;
      this.clearMoveWait();
      return;
    }
    const engine = this.options.socket.io?.engine;
    if (
      !force &&
      engine &&
      (engine.transport?.writable === false ||
        (engine.writeBuffer?.length ?? 0) > 0)
    ) {
      if (this.waitingEngine !== engine) {
        this.clearMoveWait();
        this.waitingEngine = engine;
        engine.on('drain', this.onTransportReady);
        engine.on('upgrade', this.onTransportReady);
      }
      return;
    }
    const remaining =
      MOBILE_REMOTE_POINTER_INTERVAL_MS - (this.now() - this.lastMoveAt);
    if (!force && remaining > 0) {
      if (!this.moveTimer)
        this.moveTimer = setTimeout(() => {
          this.moveTimer = null;
          this.flushMove();
        }, remaining);
      return;
    }
    this.clearMoveWait();
    this.pendingMove = null;
    this.lastMoveAt = this.now();
    this.emitInput(move);
  }
  cancel() {
    this.stop();
  }
  stop(notifyServer = true) {
    const { session, pending } = this.state;
    if (notifyServer && this.canConnect() && session) {
      this.flushMove(true);
      this.releaseHeldInputs();
      this.options.socket.emit('remote-control:stop', {
        sessionId: session.sessionId,
      });
    } else if (notifyServer && this.canConnect() && pending?.requestId)
      this.options.socket.emit('remote-control:cancel', {
        requestId: pending.requestId,
      });
    this.generation++;
    this.inputGeneration++;
    this.clearRequestTimers();
    this.clearMoveWait();
    this.pendingMove = null;
    this.lastMoveAt = -Infinity;
    this.earlyResult = null;
    if (this.earlyStart && notifyServer && this.options.socket.connected)
      this.options.socket.emit('remote-control:stop', {
        sessionId: this.earlyStart.sessionId,
      });
    this.earlyStart = null;
    this.keys.clear();
    this.buttons.clear();
    this.heldEdges.length = 0;
    this.publish({ session: null, pending: null });
  }
  dispose() {
    this.stop();
    this.disposed = true;
    const socket = this.options.socket;
    socket.off('remote-control:started', this.onStarted);
    socket.off('remote-control:stopped', this.onStopped);
    socket.off('remote-control:request-result', this.onRequestResult);
    socket.off('disconnect', this.onDisconnect);
    socket.off('connect', this.onConnect);
  }
}
