import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createWorker, type types as T } from 'mediasoup';
import { createPeer, peers, removePeer } from '../src/features/media/ms';
import { registerMediaSocketHandlers } from '../src/features/media/socketHandlers';
import { createMediaService } from '../src/features/media/mediaService';
import { createVoiceService } from '../src/features/voice/voiceService';

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>(r => { resolve = r; });
  return { promise, resolve };
}

test('native SFU allocations remain isolated across reordered ACKs, voice leave and socket recovery', { timeout: 20_000 }, async t => {
  const worker = await createWorker({ logLevel: 'error' });
  const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
  const http = createServer();
  const io = new Server(http, { connectionStateRecovery: { maxDisconnectionDuration: 5000, skipMiddlewares: false } });
  const voiceRooms = new Map<string, Set<string>>([['room', new Set()]]);
  const media = createMediaService({ io, isSocketMuted: () => false });
  const voice = createVoiceService({ io, voiceRooms, publicUserId: id => id, userNames: new Map(), userAvatars: new Map(), isSocketMuted: () => false, selfMutedVoiceMembers: new Set(), emitAvatarPayload() {}, stopRemoteControlForSocket() {}, removeAnnotationMember() {}, closePeerConsumer: media.closePeerConsumer, broadcastRoomMembers() {} });
  let active!: ServerSocket;
  let delayAllocation: ((transport: T.WebRtcTransport) => Promise<void>) | undefined;
  const mediaRouter = {
    canConsume: router.canConsume.bind(router),
    async createWebRtcTransport() {
      const transport = await router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }] });
      await delayAllocation?.(transport);
      return transport;
    },
  };
  io.on('connection', socket => {
    active = socket;
    const peer = peers.get(socket.id) ?? createPeer(socket.id);
    peer.roomId = 'room';
    voiceRooms.get('room')!.add(socket.id);
    socket.join('room');
    registerMediaSocketHandlers({ socket, io, voiceRooms, ...media, mediaRouter, broadcastRoomMembers() {}, isSharingScreen: () => false, stopRemoteControlForSocket() {}, isSocketMuted: () => false });
    socket.on('test:leave', (cb: () => void) => { voice.handleVoiceLeave(socket.id, 'room'); cb(); });
    socket.on('test:checkpoint', (cb: () => void) => { socket.emit('session:checkpoint'); cb(); });
    socket.emit('session:checkpoint');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const client = connect(`http://127.0.0.1:${(http.address() as any).port}`, { transports: ['websocket'], reconnectionDelay: 10, reconnectionDelayMax: 10, randomizationFactor: 0 });
  t.after(async () => {
    client.disconnect();
    for (const id of [...peers.keys()]) removePeer(id);
    worker.close();
    await new Promise<void>(resolve => io.close(() => resolve()));
  });
  await once(client, 'session:checkpoint');
  const request = (event: string, data: unknown) => client.timeout(3000).emitWithAck(event, data);
  const id = client.id!;
  const peer = peers.get(id)!;

  await t.test('older native allocation cannot close a newer live send transport', async () => {
    const allocated = deferred<T.WebRtcTransport>();
    const release = deferred<void>();
    let calls = 0;
    delayAllocation = async transport => { if (++calls === 1) { allocated.resolve(transport); await release.promise; } };
    const oldRequest = request('ms:create-transport', { direction: 'send' });
    const oldTransport = await allocated.promise;
    const fresh = await request('ms:create-transport', { direction: 'send' });
    release.resolve();
    const stale = await oldRequest;
    assert.ok(stale.error);
    assert.equal(oldTransport.closed, true);
    assert.equal(peer.sendTransport?.id, fresh.id);
    assert.equal(peer.sendTransport?.closed, false);
    delayAllocation = undefined;
  });

  const codec = router.rtpCapabilities.codecs!.find(c => c.mimeType.toLowerCase() === 'audio/opus')!;
  const rtpParameters = { codecs: [{ mimeType: codec.mimeType, payloadType: codec.preferredPayloadType!, clockRate: codec.clockRate, channels: codec.channels }], encodings: [{ ssrc: 12345678 }] };

  await t.test('native producer completed after voice leave is closed and never announced', async () => {
    const transport = peer.sendTransport!;
    const allocated = deferred<T.Producer>();
    const release = deferred<void>();
    const produce = transport.produce.bind(transport);
    transport.produce = (async (options: any) => {
      const result = await produce(options);
      allocated.resolve(result);
      await release.promise;
      return result;
    }) as typeof transport.produce;
    const publishing = request('ms:produce', { transportId: transport.id, kind: 'audio', rtpParameters, appData: { type: 'mic' } });
    const producer = await allocated.promise;
    await client.timeout(3000).emitWithAck('test:leave');
    voiceRooms.get('room')!.add(id);
    release.resolve();
    const result = await publishing;
    assert.ok(result.error);
    assert.equal(producer.closed, true);
    assert.equal(peer.producers.size, 0);
    transport.produce = produce;
  });

  await t.test('pending native consumer cannot survive leave/rejoin', async () => {
    const owner = createPeer('native-source');
    owner.roomId = 'room';
    const sourceTransport = await mediaRouter.createWebRtcTransport();
    owner.sendTransport = sourceTransport;
    const producer = await sourceTransport.produce({ kind: 'audio', rtpParameters, appData: { type: 'mic' } });
    owner.producers.set(producer.id, producer);
    await request('ms:create-transport', { direction: 'recv' });
    const transport = peer.recvTransport!;
    const allocated = deferred<T.Consumer>();
    const release = deferred<void>();
    const consume = transport.consume.bind(transport);
    transport.consume = (async (options: any) => {
      const result = await consume(options);
      allocated.resolve(result);
      await release.promise;
      return result;
    }) as typeof transport.consume;
    const consuming = request('ms:consume', { producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
    const consumer = await allocated.promise;
    await client.timeout(3000).emitWithAck('test:leave');
    voiceRooms.get('room')!.add(id);
    release.resolve();
    assert.ok((await consuming).error);
    assert.equal(consumer.closed, true);
    assert.equal(peer.consumers.size, 0);
    transport.consume = consume;
  });

  await t.test('allocation started on disconnected socket cannot overwrite its recovered session', async () => {
    await client.timeout(3000).emitWithAck('test:checkpoint');
    const current = peer.sendTransport;
    const allocated = deferred<T.WebRtcTransport>();
    const release = deferred<void>();
    delayAllocation = async transport => { allocated.resolve(transport); await release.promise; };
    client.emit('ms:create-transport', { direction: 'send' }, () => {});
    const stale = await allocated.promise;
    const closed = once(stale.observer, 'close');
    const disconnected = once(active, 'disconnect');
    const reconnected = once(client, 'connect');
    client.io.engine.close();
    await disconnected;
    await reconnected;
    assert.equal(client.recovered, true);
    release.resolve();
    await closed;
    assert.equal(peer.sendTransport, current);
    assert.equal(current?.closed, false);
    assert.equal(stale.closed, true);
    delayAllocation = undefined;
  });

  await t.test('short real Socket.IO outage recovers existing native transport and permits new publication', async () => {
    await client.timeout(3000).emitWithAck('test:checkpoint');
    const transport = peer.sendTransport!;
    const disconnected = once(active, 'disconnect');
    const reconnected = once(client, 'connect');
    client.io.engine.close();
    await disconnected;
    await reconnected;
    assert.equal(client.recovered, true);
    assert.equal(client.id, id);
    assert.equal(peers.get(id), peer);
    assert.equal(peer.sendTransport, transport);
    assert.equal(transport.closed, false);
    const result = await request('ms:produce', { transportId: transport.id, kind: 'audio', rtpParameters, appData: { type: 'mic' } });
    assert.equal(typeof result.producerId, 'string');
    assert.equal(peer.producers.get(result.producerId)?.closed, false);
  });
});
