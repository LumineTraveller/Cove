import { Server } from 'socket.io';

import { peers } from './ms';

import { summarizeRtpStat, summarizeTransportStat } from './mediaDiagnostics';

import { OnDemandMediaType } from '../../models';

export interface CreateMediaServiceDependencies {
  readonly isSocketMuted: (roomId: string, socketId: string) => boolean;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function createMediaService(deps: CreateMediaServiceDependencies) {
  function onDemandMediaType(value: unknown): OnDemandMediaType | null {
    return value === 'screen' || value === 'screen-audio' ? value : null;
  }

  function findProducerOwner(producerId: string) {
    for (const [socketId, peer] of peers) {
      const producer = peer.producers.get(producerId);
      if (producer) return { socketId, peer, producer };
    }
    return null;
  }

  async function mediaDiagnosticsForPeer(socketId: string) {
    const peer = peers.get(socketId);
    if (!peer)
      return { timestamp: Date.now(), role: 'idle', transports: {}, producers: [], consumers: [] };

    const transportStats = async (transport: typeof peer.sendTransport) => {
      if (!transport || transport.closed) return null;
      try {
        const [stat] = await transport.getStats();
        return summarizeTransportStat(stat as unknown as Record<string, unknown>);
      } catch {
        return null;
      }
    };

    const producers = await Promise.all(
      [...peer.producers.values()]
        .filter((producer) => (producer.appData as Record<string, unknown>).type === 'screen')
        .map(async (producer) => {
          let stats: ReturnType<typeof summarizeRtpStat>[] = [];
          try {
            stats = (await producer.getStats()).map((stat) =>
              summarizeRtpStat(stat as unknown as Record<string, unknown>),
            );
          } catch {
            /* producer may close while the snapshot is collected */
          }
          return {
            id: producer.id,
            kind: producer.kind,
            sourceType: 'screen',
            paused: producer.paused,
            score: producer.score,
            stats,
          };
        }),
    );

    const consumers = await Promise.all(
      [...peer.consumers.values()]
        .filter((consumer) => {
          const owner = findProducerOwner(consumer.producerId);
          return (
            (owner?.producer.appData as Record<string, unknown> | undefined)?.type === 'screen'
          );
        })
        .map(async (consumer) => {
          let stats: ReturnType<typeof summarizeRtpStat>[] = [];
          try {
            stats = (await consumer.getStats()).map((stat) =>
              summarizeRtpStat(stat as unknown as Record<string, unknown>),
            );
          } catch {
            /* consumer may close while the snapshot is collected */
          }
          return {
            id: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            paused: consumer.paused,
            producerPaused: consumer.producerPaused,
            score: consumer.score,
            stats,
          };
        }),
    );

    return {
      timestamp: Date.now(),
      role: producers.length ? 'sender' : consumers.length ? 'receiver' : 'idle',
      transports: {
        send: await transportStats(peer.sendTransport),
        receive: await transportStats(peer.recvTransport),
      },
      producers,
      consumers,
    };
  }

  function syncOnDemandProducer(producerId: string) {
    const owner = findProducerOwner(producerId);
    if (!owner) return;
    const sourceType = onDemandMediaType((owner.producer.appData as Record<string, unknown>).type);
    if (!sourceType) return;

    let viewerCount = 0;
    for (const peer of peers.values()) {
      for (const consumer of peer.consumers.values()) {
        if (!consumer.closed && consumer.producerId === producerId) viewerCount += 1;
      }
    }
    const forceMuted =
      sourceType === 'screen-audio' &&
      !!owner.peer.roomId &&
      deps.isSocketMuted(owner.peer.roomId, owner.socketId);
    const active = viewerCount > 0 && !forceMuted;
    if (active) owner.producer.resume().catch(() => {});
    else owner.producer.pause().catch(() => {});

    deps.io.to(owner.socketId).emit('screen:demand', {
      producerId,
      sourceType,
      active,
      viewerCount,
    });
    if (sourceType === 'screen' && owner.peer.roomId) {
      deps.io.to(owner.peer.roomId).emit('screen:viewers', {
        peerId: owner.socketId,
        viewerCount,
      });
    }
  }

  function closePeerConsumer(socketId: string, consumerId: string) {
    const peer = peers.get(socketId);
    const consumer = peer?.consumers.get(consumerId);
    if (!peer || !consumer) return;
    const producerId = consumer.producerId;
    consumer.close();
    peer.consumers.delete(consumerId);
    syncOnDemandProducer(producerId);
  }
  return {
    onDemandMediaType,
    findProducerOwner,
    mediaDiagnosticsForPeer,
    syncOnDemandProducer,
    closePeerConsumer,
  };
}
