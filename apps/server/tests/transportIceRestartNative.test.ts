import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createWorker } from 'mediasoup';
import { createPeer, peers, removePeer } from '../src/features/media/ms';
import { registerMediaSocketHandlers } from '../src/features/media/socketHandlers';
import { createMediaService } from '../src/features/media/mediaService';
import { createVoiceService } from '../src/features/voice/voiceService';

test('loopback Socket.IO/native worker ICE restart keeps RTP identities and rejects a late leave result', { timeout: 15_000 }, async t => {
  const worker = await createWorker({ logLevel: 'error' });
  t.after(() => worker.close());
  const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
  const http = createServer();
  const io = new Server(http, { connectionStateRecovery: { maxDisconnectionDuration: 5000, skipMiddlewares: false } });
  t.after(() => new Promise<void>(resolve => io.close(() => resolve())));
  const voiceRooms = new Map<string, Set<string>>([['room', new Set()]]);
  const media = createMediaService({ io, isSocketMuted: () => false });
  const voice = createVoiceService({ io, voiceRooms, publicUserId: id => id, userNames: new Map(), userAvatars: new Map(),
    isSocketMuted: () => false, selfMutedVoiceMembers: new Set(), emitAvatarPayload() {}, stopRemoteControlForSocket() {},
    removeAnnotationMember() {}, closePeerConsumer: media.closePeerConsumer, broadcastRoomMembers() {} });
  const mediaRouter = {
    canConsume: router.canConsume.bind(router),
    createWebRtcTransport: () => router.createWebRtcTransport({ listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 0 }] }),
  };
  let active!: Socket;
  io.on('connection', socket => {
    active = socket;
    const peer = peers.get(socket.id) ?? createPeer(socket.id);
    peer.roomId = 'room';
    voiceRooms.get('room')!.add(socket.id);
    socket.join('room');
    registerMediaSocketHandlers({ socket, io, voiceRooms, ...media, mediaRouter,
      broadcastRoomMembers() {}, isSharingScreen: () => false, stopRemoteControlForSocket() {}, isSocketMuted: () => false });
    socket.emit('test:ice-checkpoint');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const client = connect(`http://127.0.0.1:${(http.address() as any).port}`, {
    transports: ['websocket'], autoConnect: false, reconnectionDelay: 10, reconnectionDelayMax: 10, randomizationFactor: 0,
  });
  t.after(() => { client.disconnect(); if (client.id) removePeer(client.id); });
  const connected = once(client, 'test:ice-checkpoint'); client.connect(); await connected;
  const id = client.id!;
  t.after(() => removePeer(id));
  const peer = peers.get(id)!;
  const request = (event: string, data: unknown) => client.timeout(3000).emitWithAck(event, data);
  const send = await request('ms:create-transport', { direction: 'send' });
  const receive = await request('ms:create-transport', { direction: 'recv' });
  assert.equal(send.iceRestart?.version, 1);
  assert.equal(receive.iceRestart?.version, 1);
  const outgoing = peer.sendTransport!;
  const incoming = peer.recvTransport!;
  const codec = router.rtpCapabilities.codecs![0];
  const producer = await outgoing.produce({ kind: 'audio', paused: true, appData: { type: 'mic' },
    rtpParameters: { codecs: [{ mimeType: codec.mimeType, payloadType: codec.preferredPayloadType!, clockRate: codec.clockRate, channels: codec.channels }], encodings: [{ ssrc: 45454545 }] } });
  peer.producers.set(producer.id, producer);
  const consumer = await incoming.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: true });
  peer.consumers.set(consumer.id, consumer);
  let rotations = 0;
  const nativeRestart = outgoing.restartIce.bind(outgoing);
  outgoing.restartIce = async () => { rotations++; return nativeRestart(); };
  const payload = { transportId: outgoing.id, roomId: 'room', sessionId: send.iceRestart.sessionId, sequence: 1 };

  await t.test('real ICE credentials rotate once, duplicate ACK requests retain the same RTP resources and mute state', async () => {
    const previousUser = outgoing.iceParameters.usernameFragment;
    const result = await request('ms:restart-ice', payload);
    assert.equal(result.ok, true);
    assert.ok(result.iceParameters.usernameFragment !== previousUser, 'native ICE parameters must rotate');
    assert.ok(outgoing.iceParameters.usernameFragment === result.iceParameters.usernameFragment);
    const duplicate = await request('ms:restart-ice', payload);
    assert.ok(duplicate.iceParameters.usernameFragment === result.iceParameters.usernameFragment);
    assert.equal(rotations, 1);
    assert.equal(peer.sendTransport, outgoing);
    assert.equal(peer.recvTransport, incoming);
    assert.equal(peer.producers.get(producer.id), producer);
    assert.equal(peer.consumers.get(consumer.id), consumer);
    assert.equal(producer.paused, true);
    assert.equal(consumer.paused, true);
    const received = await request('ms:restart-ice', { transportId: incoming.id, roomId: 'room', sessionId: receive.iceRestart.sessionId, sequence: 1 });
    assert.equal(received.ok, true);
  });

  await t.test('a recovered real Socket reuses the completed sequence result without another native rotation', async () => {
    const disconnected = once(active, 'disconnect');
    const reconnected = once(client, 'connect');
    client.io.engine.close();
    await disconnected; await reconnected;
    assert.equal(client.recovered, true);
    assert.equal(client.id, id);
    assert.equal((await request('ms:restart-ice', payload)).ok, true);
    assert.equal(rotations, 1);
  });

  await t.test('voice leave invalidates a native rotation that completed while the application callback was held', async () => {
    let release!: () => void;
    let rotated!: () => void;
    const hasRotated = new Promise<void>(resolve => { rotated = resolve; });
    outgoing.restartIce = async () => {
      const parameters = await nativeRestart();
      rotated();
      await new Promise<void>(resolve => { release = resolve; });
      return parameters;
    };
    const pending = request('ms:restart-ice', { ...payload, sequence: 2 });
    await hasRotated;
    voice.handleVoiceLeave(id, 'room');
    assert.equal(peer.sendTransport, outgoing);
    assert.equal(outgoing.closed, false);
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_EXPIRED');
    assert.equal(result.iceParameters, undefined);
    assert.equal(producer.closed, true);
    assert.equal(consumer.closed, true);
  });
});
