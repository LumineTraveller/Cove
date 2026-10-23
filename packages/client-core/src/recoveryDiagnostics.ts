/** In-memory recovery metadata only. Never accept wire payloads or identities. */
export interface RecoveryDiagnosticEvent {
  recoveryId: string;
  channel: 'signal' | 'send' | 'receive' | 'screen';
  stage: 'begin' | 'request' | 'applying' | 'retry' | 'applied' | 'waiting' | 'connected' | 'retained' | 'cancelled' | 'failed' | 'fallback';
  atMs: number;
  elapsedMs: number;
  attempt?: number;
  reason?: string;
}
export interface RecoveryDiagnosticReport {
  schemaVersion: 1;
  limit: number;
  dropped: number;
  events: RecoveryDiagnosticEvent[];
}
const stages = new Set(['begin', 'request', 'applying', 'retry', 'applied', 'waiting', 'connected', 'retained', 'cancelled', 'failed', 'fallback']);
const channels = new Set(['signal', 'send', 'receive', 'screen']);
const reasons = new Set(['BAD_REQUEST', 'NOT_CONNECTED', 'TRANSPORT_NOT_FOUND', 'SESSION_MISMATCH',
  'SESSION_EXPIRED', 'TRANSPORT_CLOSED', 'ICE_DISCONNECTED', 'DTLS_FAILED', 'DTLS_CLOSED',
  'STALE_SEQUENCE', 'INVALID_SEQUENCE', 'BUSY', 'RATE_LIMITED', 'RESTART_FAILED', 'UNSUPPORTED',
  'INVALID_RESPONSE', 'ATTEMPTS_EXHAUSTED', 'DEADLINE_EXCEEDED', 'REQUEST_OR_APPLY_FAILED',
  'STATE_FAILED', 'STATE_DISCONNECTED', 'SIGNAL_TIMEOUT', 'MEDIA_TIMEOUT', 'REQUEST_FAILED', 'APPLY_FAILED', 'SESSION_NOT_RECOVERED',
  'CLIENT_DISCONNECT', 'SERVER_DISCONNECT', 'TRANSPORT_CLOSE', 'TRANSPORT_ERROR', 'PING_TIMEOUT', 'OWNER_TEARDOWN', 'OTHER']);
const reasonNames: Record<string, string> = {
  'io client disconnect': 'CLIENT_DISCONNECT', 'io server disconnect': 'SERVER_DISCONNECT',
  'transport close': 'TRANSPORT_CLOSE', 'transport error': 'TRANSPORT_ERROR', 'ping timeout': 'PING_TIMEOUT',
  'signal-timeout': 'SIGNAL_TIMEOUT', 'session-not-recovered': 'SESSION_NOT_RECOVERED',
};
const eventStages: Record<string, RecoveryDiagnosticEvent['stage']> = {
  'ice-restart-begin': 'begin', 'ice-restart-request': 'request', 'ice-restart-retry': 'retry',
  'ice-restart-applied': 'applied', 'ice-restart-connected': 'connected', 'ice-restart-failed': 'failed',
  'ice-restart-applying': 'applying',
  'ice-restart-cancelled': 'cancelled', 'ice-restart-signal-wait': 'waiting', 'ice-restart-fallback': 'fallback',
  'signal-disconnected': 'begin', 'signal-connected': 'connected',
  'signal-timeout-media-retained': 'retained', 'media-reset': 'fallback', 'recovered-session-left': 'cancelled',
  'legacy-transport-failed': 'begin', 'legacy-transport-fallback': 'fallback',
  'legacy-transport-connected': 'connected', 'legacy-transport-cancelled': 'cancelled',
  'owner-teardown': 'cancelled',
};
const bounded = (value: unknown, maximum = 86_400_000) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : 0;
const safeReason = (value: unknown) => typeof value === 'string' ?
  (reasons.has(value) ? value : Object.prototype.hasOwnProperty.call(reasonNames, value) ? reasonNames[value] : 'OTHER') : undefined;

/** Revalidate at export boundaries too, rather than spreading arbitrary metadata. */
export function normalizeRecoveryDiagnostics(input: unknown): RecoveryDiagnosticReport {
  const source = input && typeof input === 'object' ? input as Partial<RecoveryDiagnosticReport> : {};
  const events: RecoveryDiagnosticEvent[] = [];
  if (Array.isArray(source.events)) for (const item of source.events.slice(-256)) {
    if (!item || typeof item !== 'object' || typeof item.recoveryId !== 'string' || !/^r[1-9]\d{0,8}$/.test(item.recoveryId) ||
      !channels.has(item.channel) || !stages.has(item.stage)) continue;
    events.push({ recoveryId: item.recoveryId, channel: item.channel, stage: item.stage,
      atMs: bounded(item.atMs, Number.MAX_SAFE_INTEGER), elapsedMs: bounded(item.elapsedMs),
      ...(Number.isInteger(item.attempt) && item.attempt! >= 1 && item.attempt! <= 3 ? { attempt: item.attempt } : {}),
      ...(safeReason(item.reason) ? { reason: safeReason(item.reason) } : {}),
    });
  }
  return { schemaVersion: 1, limit: Math.min(256, Math.max(1, bounded(source.limit, 256) || 256)),
    dropped: bounded(source.dropped, Number.MAX_SAFE_INTEGER), events };
}

export function createRecoveryDiagnostics(options: { now?: () => number; capacity?: number } = {}) {
  const now = options.now ?? Date.now;
  const started = now();
  const limit = Math.min(256, Math.max(1, bounded(options.capacity, 256) || 256));
  const events: RecoveryDiagnosticEvent[] = [];
  const active = new Map<string, { id: string; at: number; attempt?: number }>();
  const latest = new Map<string, { id: string; at: number; attempt?: number }>();
  let sequence = 0, dropped = 0, lastAt = 0, lastSignature = '';
  const record = (event: string, detail?: unknown) => {
    const stage = Object.prototype.hasOwnProperty.call(eventStages, event) ? eventStages[event] : undefined;
    if (!stage) return;
    const value = detail && typeof detail === 'object' ? detail as Record<string, unknown> : { reason: detail };
    const signal = !event.startsWith('ice-') && !event.startsWith('legacy-');
    const channel = signal ? 'signal' : value.key === 'recv' ? 'receive' :
      value.key === 'send' || value.key === 'screen' ? value.key : undefined;
    if (!channel) return;
    const at = lastAt = Math.max(lastAt, bounded(now() - started, Number.MAX_SAFE_INTEGER));
    let round = active.get(channel);
    if (stage === 'begin' && !round) {
      round = { id: `r${++sequence}`, at };
      active.set(channel, round); latest.set(channel, round);
    }
    if (!round) {
      if (stage !== 'fallback' && event !== 'recovered-session-left') return; // Normal connect/cleanup is not a recovery.
      round = latest.get(channel);
      if (!round) {
        round = { id: `r${++sequence}`, at };
        latest.set(channel, round);
      }
    }
    const attempt = Number.isInteger(value.attempt) && Number(value.attempt) >= 1 && Number(value.attempt) <= 3 ? Number(value.attempt) : round.attempt;
    if (attempt) round.attempt = attempt;
    const reason = safeReason(value.reason);
    const signature = JSON.stringify([round.id, channel, stage, attempt, reason]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    events.push({ recoveryId: round.id, channel, stage, atMs: at, elapsedMs: at - round.at,
      ...(attempt ? { attempt } : {}), ...(reason ? { reason } : {}) });
    if (events.length > limit) { events.shift(); dropped++; }
    if (['connected', 'cancelled', 'failed', 'fallback'].includes(stage)) active.delete(channel);
  };
  // Owners also retire legacy grace rounds, which have no ICE coordinator entry.
  // Idle teardown is silent and cannot create a recovery or affect media policy.
  const cancelActive = () => {
    for (const channel of [...active.keys()]) {
      record(channel === 'signal' ? 'owner-teardown' : 'legacy-transport-cancelled', {
        key: channel === 'receive' ? 'recv' : channel, reason: 'OWNER_TEARDOWN',
      });
    }
  };
  return { record, cancelActive, snapshot: (): RecoveryDiagnosticReport => normalizeRecoveryDiagnostics({ schemaVersion: 1, limit, dropped, events }) };
}
export type RecoveryDiagnostics = ReturnType<typeof createRecoveryDiagnostics>;
