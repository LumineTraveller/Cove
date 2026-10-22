import { randomUUID } from 'node:crypto';
import type { types as T } from 'mediasoup';
import type { IceRestartCapability, IceRestartRequest, IceRestartResponse } from '@cove/contracts';
import { peers, type PeerInfo } from './ms';
import { mediaGeneration } from './mediaLifecycle';

export type IceRestartCode = 'BAD_REQUEST' | 'NOT_CONNECTED' | 'TRANSPORT_NOT_FOUND' |
  'SESSION_MISMATCH' | 'SESSION_EXPIRED' | 'TRANSPORT_CLOSED' | 'ICE_DISCONNECTED' |
  'DTLS_FAILED' | 'DTLS_CLOSED' | 'STALE_SEQUENCE' | 'INVALID_SEQUENCE' | 'BUSY' |
  'RATE_LIMITED' | 'RESTART_FAILED' | 'UNSUPPORTED';
interface RestartState {
  peer: PeerInfo;
  roomId: string;
  generation: number;
  sessionId: string;
  latestSequence: number;
  latest?: Promise<IceRestartResponse>;
  pending: boolean;
  recent: number[];
}
const states = new WeakMap<T.WebRtcTransport, RestartState>();
const failure = (code: IceRestartCode): IceRestartResponse => ({ ok: false, code });

/** A transport's birth identity never changes, even if voice leave retains it. */
export function bindTransportIceRestart(peer: PeerInfo, roomId: string, transport: T.WebRtcTransport,
  generation = mediaGeneration(peer)): IceRestartCapability | undefined {
  if (typeof transport.restartIce !== 'function') return undefined;
  let state = states.get(transport);
  if (!state) {
    state = { peer, roomId, generation, sessionId: randomUUID(),
      latestSequence: 0, pending: false, recent: [] };
    states.set(transport, state);
  }
  return { version: 1 as const, sessionId: state.sessionId };
}

function requestFrom(data: unknown): IceRestartRequest | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.transportId !== 'string' || !value.transportId || value.transportId.length > 200 ||
    typeof value.roomId !== 'string' || !value.roomId || value.roomId.length > 200 ||
    typeof value.sessionId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.sessionId) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return undefined;
  return value as unknown as IceRestartRequest;
}

function birthFailure(transport: T.WebRtcTransport, state: RestartState, socketId: string): IceRestartCode | undefined {
  const peer = state.peer;
  if (peers.get(socketId) !== peer || peer.roomId !== state.roomId || mediaGeneration(peer) !== state.generation)
    return 'SESSION_EXPIRED';
  if (![peer.sendTransport, peer.recvTransport, peer.screenSendTransport].includes(transport))
    return 'SESSION_EXPIRED';
  if (transport.closed || transport.iceState === 'closed') return 'TRANSPORT_CLOSED';
  if (transport.dtlsState === 'failed') return 'DTLS_FAILED';
  if (transport.dtlsState === 'closed') return 'DTLS_CLOSED';
  if (transport.iceState === 'disconnected') return 'ICE_DISCONNECTED';
  return undefined;
}

/** One latest promise/result per transport; no request queue or history cache.
 * Caller connectivity is rechecked separately so a recovered Socket instance can
 * safely retrieve an ACK lost by its predecessor without another ICE rotation. */
export async function restartTransportIce(
  socket: { id: string; connected: boolean },
  data: unknown,
  now: () => number = Date.now,
): Promise<IceRestartResponse> {
  const request = requestFrom(data);
  if (!request) return failure('BAD_REQUEST');
  if (!socket.connected) return failure('NOT_CONNECTED');
  const peer = peers.get(socket.id);
  if (!peer) return failure('TRANSPORT_NOT_FOUND');
  const transport = [peer.sendTransport, peer.recvTransport, peer.screenSendTransport]
    .find(value => value?.id === request.transportId);
  if (!transport) return failure('TRANSPORT_NOT_FOUND');
  const state = states.get(transport);
  if (!state || typeof transport.restartIce !== 'function') return failure('UNSUPPORTED');
  const invalid = birthFailure(transport, state, socket.id);
  if (invalid) return failure(invalid);
  if (request.roomId !== state.roomId || request.sessionId !== state.sessionId)
    return failure('SESSION_MISMATCH');
  if (request.sequence < state.latestSequence) return failure('STALE_SEQUENCE');
  if (request.sequence > state.latestSequence + 1) return failure('INVALID_SEQUENCE');

  if (request.sequence !== state.latestSequence) {
    if (state.pending) return failure('BUSY');
    const at = now();
    state.recent = state.recent.filter(started => started > at - 30_000);
    if (state.recent.length >= 3) return failure('RATE_LIMITED');
    state.recent.push(at);
    state.latestSequence = request.sequence;
    state.pending = true;
    state.latest = (async (): Promise<IceRestartResponse> => {
      try {
        const iceParameters = await transport.restartIce();
        const invalidAfter = birthFailure(transport, state, socket.id);
        if (invalidAfter) return failure(invalidAfter);
        return { ok: true, transportId: transport.id, sessionId: state.sessionId,
          sequence: request.sequence, iceParameters };
      } catch {
        return failure('RESTART_FAILED');
      } finally {
        state.pending = false;
      }
    })();
  }
  const result = await state.latest!;
  if (!socket.connected) return failure('NOT_CONNECTED');
  const invalidAfter = birthFailure(transport, state, socket.id);
  return invalidAfter ? failure(invalidAfter) : result;
}
