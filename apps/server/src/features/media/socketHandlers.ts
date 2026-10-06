import { Server, type Socket } from 'socket.io';

import { router, webRtcServer, peers, getRoomProducers } from './ms';

import { OnDemandMediaType } from '../../models';
import { mediaGeneration, beginTransportRequest } from './mediaLifecycle';

export interface RegisterMediaSocketHandlersDependencies {
  readonly mediaRouter?: Pick<import('mediasoup').types.Router, 'createWebRtcTransport' | 'canConsume'>;
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly mediaDiagnosticsForPeer: (
    socketId: string,
  ) => Promise<
    | {
        timestamp: number;
        role: string;
        transports: { send?: undefined; receive?: undefined };
        producers: never[];
        consumers: never[];
      }
    | {
        timestamp: number;
        role: string;
        transports: {
          send: import('./mediaDiagnostics').TransportDiagnostic | null;
          receive: import('./mediaDiagnostics').TransportDiagnostic | null;
        };
        producers: {
          id: string;
          kind: import('mediasoup/node/lib/rtpParametersTypes').MediaKind;
          sourceType: string;
          paused: boolean;
          score: import('mediasoup/node/lib/ProducerTypes').ProducerScore[];
          stats: import('./mediaDiagnostics').RtpStreamDiagnostic[];
        }[];
        consumers: {
          id: string;
          producerId: string;
          kind: import('mediasoup/node/lib/rtpParametersTypes').MediaKind;
          paused: boolean;
          producerPaused: boolean;
          score: import('mediasoup/node/lib/ConsumerTypes').ConsumerScore;
          stats: import('./mediaDiagnostics').RtpStreamDiagnostic[];
        }[];
      }
  >;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly onDemandMediaType: (value: unknown) => OnDemandMediaType | null;
  readonly broadcastRoomMembers: (roomId: string) => void;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly isSharingScreen: (socketId: string, roomId: string) => boolean;
  readonly stopRemoteControlForSocket: (socketId: string, reason: string) => void;
  readonly endAnnotationSessionForSocket: (
    socketId: string,
    roomId?: string,
    sessionId?: string,
  ) => void;
  readonly isSocketMuted: (roomId: string, socketId: string) => boolean;
  readonly syncOnDemandProducer: (producerId: string) => void;
  readonly findProducerOwner: (
    producerId: string,
  ) => {
    socketId: string;
    peer: import('./ms').PeerInfo;
    producer: import('mediasoup/node/lib/ProducerTypes').Producer<
      import('mediasoup/node/lib/types').AppData
    >;
  } | null;
  readonly closePeerConsumer: (socketId: string, consumerId: string) => void;
}

export function registerMediaSocketHandlers(deps: RegisterMediaSocketHandlersDependencies) {
  function sessionIsCurrent(peer: import('./ms').PeerInfo, roomId: string, generation: number) {
    return deps.socket.connected && peers.get(deps.socket.id) === peer &&
      peer.roomId === roomId && mediaGeneration(peer) === generation;
  }

  // ── mediasoup 信令 ────────────────────────────────────────────────────────
  // 所有 ms:* 事件都带回调（callback），客户端用 socket.emitWithAck() 接收结果

  /** 1. 客户端请求 router 的编解码能力 */
  // 注意：客户端 emitAsync 不带 data 时，Socket.io 会把 ack 回调放在参数列表里，
  // 位置不固定。必须从 args 中找出函数本身，不能假定它是第一个参数。
  deps.socket.on('ms:capabilities', (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((caps: unknown) => void) | undefined;
    if (!cb) return;
    if (!router) {
      cb({ error: 'mediasoup 未就绪' });
      return;
    }
    cb(router.rtpCapabilities);
  });

  /** 媒体诊断快照：只返回当前连接自己的传输及屏幕流统计。 */
  deps.socket.on('ms:media-diagnostics', async (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as
      | ((snapshot: unknown) => void)
      | undefined;
    if (!cb) return;
    cb(await deps.mediaDiagnosticsForPeer(deps.socket.id));
  });

  /** 2. 创建 WebRTC transport（发送 or 接收） */
  deps.socket.on(
    'ms:screen-sharing-capabilities',
    (_data: unknown, cb: (data: unknown) => void) => {
      cb({ dedicatedTransport: true });
    },
  );

  deps.socket.on('ms:create-transport', async (data: unknown, cb: (params: unknown) => void) => {
    try {
      const peer = peers.get(deps.socket.id);
      if (!peer?.roomId) return cb({ error: '请先加入房间' });
      const request = data as { direction?: 'send' | 'recv'; purpose?: string };
      const direction = request?.direction ?? (!peer.sendTransport ? 'send' : 'recv');
      if (direction !== 'send' && direction !== 'recv') return cb({ error: 'invalid transport direction' });
      const isScreen = direction === 'send' && request?.purpose === 'screen';
      const roomId = peer.roomId;
      const generation = mediaGeneration(peer);
      const latestRequest = beginTransportRequest(peer, isScreen ? 'screen' : direction);
      if (isScreen && !deps.voiceRooms.get(peer.roomId)?.has(deps.socket.id))
        return cb({ error: '请先加入语音' });
      const transport = await (deps.mediaRouter ?? router).createWebRtcTransport({
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        // 按 10 Mbps 启动，减少高分辨率共享的爬升时间。这只是拥塞控制的
        // 初始估计而不是硬限速，后续仍会按接收端反馈自动升降。
        initialAvailableOutgoingBitrate: 10_000_000,
      });
      if (
        !sessionIsCurrent(peer, roomId, generation) || !latestRequest() ||
        (isScreen && !deps.voiceRooms.get(peer.roomId)?.has(deps.socket.id))
      ) {
        transport.close();
        return cb({ error: '语音会话已结束' });
      }

      // 存到 peer（前两次调用对应 send/recv，按顺序）
      // 客户端明确指定方向。兼容旧客户端：未指定时按调用顺序（首次=send）。
      const role = isScreen ? 'screen共享' : direction === 'send' ? 'send发送' : 'recv接收';
      if (isScreen) {
        peer.screenSendTransport?.close();
        peer.screenSendTransport = transport;
      } else if (direction === 'send') {
        peer.sendTransport?.close(); // 关掉重连前残留的旧通道，避免引用错位
        peer.sendTransport = transport;
      } else {
        peer.recvTransport?.close();
        peer.recvTransport = transport;
      }

      // ── 诊断日志：ICE / DTLS 连接状态 ──────────────────────────────────────
      transport.on('icestatechange', (state) => {
        console.log(`[ms-server] ${role}通道 ICE: ${state}  (${deps.socket.id.slice(0, 6)})`);
        if (state === 'disconnected' || state === 'closed')
          console.warn(
            `[ms-server] [WARN] ${role}通道 ICE ${state} - 客户端连不上服务器（检查 frp 端口/公网IP）`,
          );
      });
      transport.on('dtlsstatechange', (state) => {
        console.log(`[ms-server] ${role}通道 DTLS: ${state}  (${deps.socket.id.slice(0, 6)})`);
        if (state === 'connected') console.log(`[ms-server] [OK] ${role}通道握手成功，媒体可流通`);
        if (state === 'failed') console.error(`[ms-server] [ERROR] ${role}通道 DTLS 握手失败`);
        if (state === 'closed') {
          transport.close();
          // 通道关闭时清空引用，确保重新加入语音时能正确重建收发通道
          if (peer.sendTransport === transport) peer.sendTransport = null;
          if (peer.screenSendTransport === transport) peer.screenSendTransport = null;
          if (peer.recvTransport === transport) peer.recvTransport = null;
        }
      });
      // 选中的传输方式：udp = 理想，tcp = frp 没转发 UDP 时的回退
      transport.on('iceselectedtuplechange', (tuple) => {
        console.log(
          `[ms-server] ${role}通道 选用协议: ${tuple?.protocol?.toUpperCase()} ` +
            `(本地 ${tuple?.localAddress}:${tuple?.localPort} ← 远端 ${tuple?.remoteIp}:${tuple?.remotePort})`,
        );
        if (tuple?.protocol === 'tcp')
          console.warn(
            '[ms-server] [WARN] 走的是 TCP（说明 UDP 没通，frp 可能只转发了 TCP；能用但延迟偏高）',
          );
      });

      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
        purpose: isScreen ? 'screen' : undefined,
      });
    } catch (e: unknown) {
      cb({ error: String(e) });
    }
  });

  /** 3. 完成 DTLS 握手 */
  deps.socket.on(
    'ms:connect-transport',
    async (
      { transportId, dtlsParameters }: { transportId: string; dtlsParameters: unknown },
      cb: (result?: { error: string }) => void,
    ) => {
      const peer = peers.get(deps.socket.id);
      if (!peer?.roomId) return cb({ error: '语音会话已结束' });
      const roomId = peer.roomId;
      const generation = mediaGeneration(peer);
      const transport =
        peer.sendTransport?.id === transportId
          ? peer.sendTransport
          : peer.screenSendTransport?.id === transportId
          ? peer.screenSendTransport
          : peer.recvTransport?.id === transportId
          ? peer.recvTransport
          : null;
      if (!transport || transport.closed) return cb({ error: 'transport not found' });
      try {
        await transport.connect({ dtlsParameters } as never);
        if (!sessionIsCurrent(peer, roomId, generation) || transport.closed)
          return cb({ error: '语音会话已结束' });
        cb();
      } catch (error) {
        cb({ error: String(error) });
      }
    },
  );

  // Closing screen capture must never close the microphone/receive transports.
  deps.socket.on('ms:close-screen-transport', ({ transportId }: { transportId: string }) => {
    const peer = peers.get(deps.socket.id);
    if (peer?.screenSendTransport?.id !== transportId) return;
    peer.screenSendTransport.close();
    peer.screenSendTransport = null;
  });

  /** 4. 开始发送媒体（produce） */
  deps.socket.on(
    'ms:produce',
    async (
      {
        transportId,
        kind,
        rtpParameters,
        appData,
      }: { transportId: string; kind: string; rtpParameters: unknown; appData: unknown },
      cb: (res: unknown) => void,
    ) => {
      const peer = peers.get(deps.socket.id);
      if (!peer?.roomId) return cb({ error: '语音会话已结束' });
      const roomId = peer.roomId;
      const generation = mediaGeneration(peer);
      const transport =
        peer.sendTransport?.id === transportId
          ? peer.sendTransport
          : peer.screenSendTransport?.id === transportId
          ? peer.screenSendTransport
          : null;
      if (!transport) return cb({ error: 'transport not found' });
      if (
        transport === peer.screenSendTransport &&
        !['screen', 'screen-audio'].includes((appData as { type?: string })?.type ?? '')
      ) {
        return cb({ error: '共享通道仅用于屏幕及共享音频' });
      }

      let createdProducer: import('mediasoup').types.Producer | undefined;
      try {
        const producer = await transport.produce({
          kind: kind as 'audio' | 'video',
          rtpParameters: rtpParameters as never,
          appData: appData as never,
        });
        createdProducer = producer;
        if (!sessionIsCurrent(peer, roomId, generation) || transport.closed) {
          producer.close();
          return cb({ error: '语音会话已结束' });
        }

        // 每个连接的同类来源只能保留一条。高延迟网络下重复点击“加入语音”
        // 可能并发发布两条 mic；关闭旧流可从服务端兜底避免双重播放。
        const producerAppData = producer.appData as Record<string, unknown>;
        const sourceType =
          typeof producerAppData.type === 'string' ? producerAppData.type : undefined;
        if (sourceType) {
          for (const [existingId, existing] of peer.producers) {
            const existingAppData = existing.appData as Record<string, unknown>;
            if (existingAppData.type !== sourceType) continue;
            existing.close();
            peer.producers.delete(existingId);
          }
        }
        peer.producers.set(producer.id, producer);

        if (sourceType === 'screen') {
          producer.on('score', (score) => {
            console.log(
              '[media-diag] producer-score',
              JSON.stringify({
                peerId: deps.socket.id.slice(0, 8),
                producerId: producer.id,
                score,
              }),
            );
          });
        }

        const demandType = deps.onDemandMediaType(sourceType);

        const producerRoomId = peer.roomId;
        if (producerRoomId) deps.broadcastRoomMembers(producerRoomId);
        producer.observer.on('close', () => {
          peer.producers.delete(producer.id);
          if (producerRoomId) deps.broadcastRoomMembers(producerRoomId);
          if (!demandType || !producerRoomId) return;
          if (demandType === 'screen')
            deps.endAnnotationSessionForSocket(deps.socket.id, producerRoomId, producer.id);
          deps.io.to(producerRoomId).emit('ms:producer-closed', {
            producerId: producer.id,
            peerId: deps.socket.id,
            sourceType: demandType,
          });
          if (demandType === 'screen') {
            // A new producer of the same source may replace this one in the
            // same event loop turn.  Defer the “ended” notice until replacement
            // registration has settled so viewers never see a stale message
            // during a normal screen-share update/reconnect.
            setTimeout(() => {
              if (deps.isSharingScreen(deps.socket.id, producerRoomId)) return;
              deps.stopRemoteControlForSocket(deps.socket.id, '屏幕共享已结束');
              deps.io.to(producerRoomId).emit('screen:viewers', {
                peerId: deps.socket.id,
                viewerCount: 0,
              });
            }, 0);
          }
        });

        producer.on('transportclose', () => peer.producers.delete(producer.id));

        // Install cleanup before any asynchronous pause: leave/replacement may
        // close this producer while the worker request is pending.
        if (demandType) await producer.pause();

        // 禁言必须由服务端兜底。即使成员篡改前端继续发布音频，SFU 也会暂停该流。
        if (
          producer.kind === 'audio' &&
          peer.roomId &&
          deps.isSocketMuted(peer.roomId, deps.socket.id)
        ) {
          await producer.pause();
        }

        if (!sessionIsCurrent(peer, roomId, generation) || transport.closed ||
            producer.closed || peer.producers.get(producer.id) !== producer) {
          producer.close();
          peer.producers.delete(producer.id);
          return cb({ error: '语音会话已结束' });
        }

        // 通知同房间其他人有新 producer
        if (roomId) {
          const voiceSet = deps.voiceRooms.get(roomId) ?? new Set();
          for (const mid of voiceSet) {
            if (mid !== deps.socket.id) {
              deps.io.to(mid).emit('ms:new-producer', {
                producerId: producer.id,
                peerId: deps.socket.id,
                kind: producer.kind,
                appData: producer.appData,
              });
            }
          }
        }

        cb({ producerId: producer.id });
        if (demandType) deps.syncOnDemandProducer(producer.id);
      } catch (e: unknown) {
        createdProducer?.close();
        if (createdProducer) peer.producers.delete(createdProducer.id);
        cb({ error: String(e) });
      }
    },
  );

  /** 5. 获取房间里当前所有人的 producer（新人加入时用） */
  deps.socket.on('ms:get-producers', (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((list: unknown) => void) | undefined;
    if (!cb) return;
    const peer = peers.get(deps.socket.id);
    if (!peer?.roomId) return cb([]);
    cb(getRoomProducers(peer.roomId, deps.socket.id));
  });

  /** 6. 开始接收某个 producer（consume） */
  deps.socket.on(
    'ms:consume',
    async (
      { producerId, rtpCapabilities }: { producerId: string; rtpCapabilities: unknown },
      cb: (res: unknown) => void,
    ) => {
      const peer = peers.get(deps.socket.id);
      const transport = peer?.recvTransport;
      if (!peer?.roomId || !transport || transport.closed) return cb({ error: 'no recv transport' });
      const roomId = peer.roomId;
      const generation = mediaGeneration(peer);

      const owner = deps.findProducerOwner(producerId);
      if (!owner || !peer.roomId || owner.peer.roomId !== peer.roomId)
        return cb({ error: 'producer is not in your room' });

      try {
        if (!(deps.mediaRouter ?? router).canConsume({ producerId, rtpCapabilities: rtpCapabilities as never }))
          return cb({ error: 'cannot consume' });
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities: rtpCapabilities as never,
          paused: true, // 客户端设置好之后再 resume
        });

        if (!sessionIsCurrent(peer, roomId, generation) || transport.closed ||
            peer.recvTransport !== transport || owner.peer.roomId !== roomId ||
            peers.get(owner.socketId) !== owner.peer || owner.producer.closed ||
            owner.peer.producers.get(producerId) !== owner.producer) {
          consumer.close();
          return cb({ error: '语音会话已结束' });
        }
        peer.consumers.set(consumer.id, consumer);

        const consumedSourceType = (owner.producer.appData as Record<string, unknown>).type;
        if (consumedSourceType === 'screen') {
          consumer.on('score', (score) => {
            console.log(
              '[media-diag] consumer-score',
              JSON.stringify({
                peerId: deps.socket.id.slice(0, 8),
                consumerId: consumer.id,
                producerId,
                score,
              }),
            );
          });
        }

        consumer.on('transportclose', () => {
          peer.consumers.delete(consumer.id);
          deps.syncOnDemandProducer(producerId);
        });
        consumer.on('producerclose', () => {
          peer.consumers.delete(consumer.id);
          deps.socket.emit('ms:consumer-closed', { consumerId: consumer.id });
        });

        cb({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          appData: consumer.appData,
        });
        deps.syncOnDemandProducer(producerId);
      } catch (e: unknown) {
        cb({ error: String(e) });
      }
    },
  );

  /** 7. 恢复 consumer（consume 后必须调用） */
  deps.socket.on(
    'ms:resume-consumer',
    async ({ consumerId }: { consumerId: string }, cb?: (result?: { error: string }) => void) => {
      const peer = peers.get(deps.socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!peer?.roomId || !consumer || consumer.closed)
        return cb?.({ error: 'consumer not found' });
      const roomId = peer.roomId;
      const generation = mediaGeneration(peer);
      try {
        await consumer.resume();
        if (!sessionIsCurrent(peer, roomId, generation) || consumer.closed ||
            peer.consumers.get(consumerId) !== consumer)
          return cb?.({ error: '语音会话已结束' });
        cb?.();
      } catch (error) {
        cb?.({ error: String(error) });
      }
    },
  );

  /** 8. 主动停止接收（“停止观看共享”） */
  deps.socket.on(
    'ms:close-consumer',
    ({ consumerId }: { consumerId: string }, cb?: (result: { ok: boolean }) => void) => {
      deps.closePeerConsumer(deps.socket.id, consumerId);
      cb?.({ ok: true });
    },
  );

  /** 9. 关闭一个 producer（停止屏幕共享等） */
  deps.socket.on('ms:close-producer', ({ producerId }: { producerId: string }) => {
    const peer = peers.get(deps.socket.id);
    const producer = peer?.producers.get(producerId);
    if (!peer || !producer) return;
    producer.close();
    peer.producers.delete(producerId);
    if (peer.roomId) deps.broadcastRoomMembers(peer.roomId);
    // consumer 的 producerclose 事件会自动触发，通知对方
  });
  return {};
}
