import type { RemoteControlInput } from './remoteControl';
import type { RemoteControlActivation } from '../electron/remote-control-activation';

export interface RemoteControlSession {
  sessionId: string;
  roomId: string;
  role: 'controller' | 'sharer';
  sharerSocketId?: string;
  controllerName?: string;
}

type Listener = (...args: any[]) => void;
interface SessionSocket {
  connected: boolean;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  emit(event: string, ...args: any[]): unknown;
}
interface InputBridge {
  setActive(sessionId: string | null): Promise<RemoteControlActivation>;
  sendInput(sessionId: string, input: RemoteControlInput): Promise<boolean>;
  onEmergencyStop(listener: (reason?: string) => void): () => void;
}

/** Own synchronous authorization state outside React's deferred render/effects. */
export class RemoteControlLifecycle {
  private current: RemoteControlSession | null = null;
  private pending: RemoteControlSession | null = null;
  private expectedRole: RemoteControlSession['role'] | null = null;
  private generation = 0;
  private connected: boolean;
  private disposed = false;
  private readonly removeEmergencyListener: (() => void) | undefined;

  constructor(private readonly options: {
    roomId: string;
    socket: SessionSocket;
    bridge?: InputBridge;
    onSession: (session: RemoteControlSession | null) => void;
    onNotice: (reason: string) => void;
  }) {
    this.connected = options.socket.connected;
    options.socket.on('remote-control:started', this.onStarted);
    options.socket.on('remote-control:input', this.onInput);
    options.socket.on('remote-control:stopped', this.onStopped);
    options.socket.on('disconnect', this.onDisconnect);
    options.socket.on('connect', this.onConnect);
    this.removeEmergencyListener = options.bridge?.onEmergencyStop(reason => {
      if ((this.current ?? this.pending)?.role === 'sharer')
        this.stop(true, reason ?? '已通过紧急快捷键终止远程控制');
    });
  }

  expectStart(role: RemoteControlSession['role']): boolean {
    if (!this.canUseConnection() || this.current || this.pending) return false;
    this.expectedRole = role;
    return true;
  }

  cancelExpectedStart() {
    this.expectedRole = null;
  }

  private canUseConnection() {
    return !this.disposed && this.connected && this.options.socket.connected;
  }

  private readonly onConnect = () => {
    // Socket.IO emits recovered packets before connect. Until this event they
    // cannot restore a remote-control session that disconnect revoked.
    this.connected = true;
  };

  private readonly onDisconnect = () => {
    this.connected = false;
    this.stop(false, '连接已断开，远程控制已停止');
  };

  private readonly onStarted = async (session: RemoteControlSession) => {
    if (session.roomId !== this.options.roomId || !this.canUseConnection()) return;
    if (this.expectedRole !== session.role) {
      // A start arriving after a local cancellation must not re-enable input.
      if (this.current?.sessionId !== session.sessionId && this.pending?.sessionId !== session.sessionId)
        this.options.socket.emit('remote-control:stop', { sessionId: session.sessionId });
      return;
    }
    this.expectedRole = null;
    const generation = ++this.generation;
    this.pending = session;
    let failure: string | null = null;
    if (session.role === 'sharer') {
      try {
        const activation = await this.options.bridge?.setActive(session.sessionId);
        if (!activation?.ok)
          failure = activation?.reason ?? '本机远程输入组件不可用，控制已终止';
      } catch {
        failure = '本机远程输入组件不可用，控制已终止';
      }
    }
    if (generation !== this.generation || !this.canUseConnection()) return;
    // 直接转发主进程给出的原因：只说“组件不可用”会掩盖
    // 「紧急停止快捷键被其他 Cove 实例占用」这类用户可自行解决的问题。
    if (failure !== null) { this.stop(true, failure); return; }
    this.pending = null;
    this.current = session;
    this.options.onSession(session);
  };

  private readonly onInput = ({ sessionId, input }: { sessionId: string; input: RemoteControlInput }) => {
    const session = this.current ?? this.pending;
    if (!this.canUseConnection() || session?.role !== 'sharer' || session.sessionId !== sessionId) return;
    // While the helper starts it accepts input only into its bounded ready queue.
    void this.options.bridge?.sendInput(sessionId, input).then(accepted => {
      if (!accepted) this.inputFailed(sessionId);
    }, () => this.inputFailed(sessionId));
  };

  private inputFailed(sessionId: string) {
    if ((this.current ?? this.pending)?.sessionId === sessionId)
      this.stop(true, '远程输入不可用，已停止控制');
  }

  private readonly onStopped = ({ sessionId, reason }: { sessionId: string; reason?: string }) => {
    if ((this.current ?? this.pending)?.sessionId === sessionId)
      this.stop(false, reason ?? '远程控制已结束');
  };

  send(input: RemoteControlInput) {
    if (!this.canUseConnection() || this.current?.role !== 'controller') return;
    this.options.socket.emit('remote-control:input', { sessionId: this.current.sessionId, input });
  }

  stop(notifyServer = true, reason?: string) {
    const session = this.current ?? this.pending;
    this.generation += 1;
    this.expectedRole = null;
    this.current = null;
    this.pending = null;
    if (session?.role === 'sharer') void this.options.bridge?.setActive(null).catch(() => {});
    if (session && notifyServer && this.canUseConnection())
      this.options.socket.emit('remote-control:stop', { sessionId: session.sessionId });
    if (!this.disposed) {
      this.options.onSession(null);
      if (session && reason) this.options.onNotice(reason);
    }
  }

  dispose() {
    this.stop();
    this.disposed = true;
    const socket = this.options.socket;
    socket.off('remote-control:started', this.onStarted);
    socket.off('remote-control:input', this.onInput);
    socket.off('remote-control:stopped', this.onStopped);
    socket.off('disconnect', this.onDisconnect);
    socket.off('connect', this.onConnect);
    this.removeEmergencyListener?.();
  }
}
