import type { Server } from 'socket.io';
import type { RemoteControlSession } from '../remote-control/remoteControl';
import { peers } from './ms';

type ScreenProducer = { appData: Record<string, unknown> };
const replacing = new WeakMap<ScreenProducer, string>();

function sessionId(producer: ScreenProducer): string | undefined {
  const value = producer.appData.shareSessionId;
  return ['screen', 'screen-audio'].includes(String(producer.appData.type)) &&
    typeof value === 'string' && /^[a-z\d:_-]{1,128}$/i.test(value) ? value : undefined;
}

/** Only the owning producer's already registered publication may be replaced. */
export function markScreenReplacement(producer: ScreenProducer, requestedSession: unknown) {
  const id = sessionId(producer);
  if (id && requestedSession === id) replacing.set(producer, id);
}

export function screenProducerClosure(producer: ScreenProducer) {
  const id = sessionId(producer);
  return id ? { shareSessionId: id, replacing: replacing.get(producer) === id } : {};
}

export function screenPlaybackPolicy(peerId: string, producer: ScreenProducer & { id: string }) {
  return {
    peerId,
    producerId: producer.id,
    smoothPlayback: producer.appData.smoothPlayback === true,
    remoteControlActive: producer.appData.remoteControlActive === true,
  };
}

export function setScreenRemoteControlActive(io: Server, session: RemoteControlSession, active: boolean) {
  const { roomId, sharerSocketId } = session;
  const peer = peers.get(sharerSocketId);
  if (peer?.roomId !== roomId) return;
  const screen = [...peer.producers.values()].find(producer =>
    !producer.closed && producer.kind === 'video' && producer.appData.type === 'screen');
  if (!screen || screen.appData.remoteControlActive === active) return;
  screen.appData.remoteControlActive = active;
  io.to(roomId).emit('screen:playback-policy', screenPlaybackPolicy(sharerSocketId, screen));
}
