import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPeer, peers } from '../src/features/media/ms';
import { registerMediaSocketHandlers, type RegisterMediaSocketHandlersDependencies } from '../src/features/media/socketHandlers';
import { createVoiceService, type CreateVoiceServiceDependencies } from '../src/features/voice/voiceService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(t: any, overrides: Partial<RegisterMediaSocketHandlersDependencies> = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const socket = { id: 'media-lifecycle', connected: true, on: (event: string, fn: any) => handlers.set(event, fn), emit() {} };
  const peer = createPeer(socket.id);
  peer.roomId = 'room';
  const events: string[] = [];
  const io = { to: () => ({ emit: (event: string) => events.push(event) }), emit() {} };
  const voiceRooms = new Map([['room', new Set([socket.id, 'listener'])]]);
  const shared = { socket, io, voiceRooms, broadcastRoomMembers() {}, isSocketMuted: () => false, stopRemoteControlForSocket() {}, removeAnnotationMember() {}, endAnnotationSessionForSocket() {}, closePeerConsumer() {} };
  registerMediaSocketHandlers({ ...shared, onDemandMediaType: () => null, syncOnDemandProducer() {}, findProducerOwner: () => null, ...overrides } as unknown as RegisterMediaSocketHandlersDependencies);
  const voice = createVoiceService({ ...shared, selfMutedVoiceMembers: new Set(), userNames: new Map(), userAvatars: new Map(), publicUserId: (id: string) => id, emitAvatarPayload() {} } as unknown as CreateVoiceServiceDependencies);
  t.after(() => peers.delete(socket.id));
  return { handlers, socket, peer, events, voice, voiceRooms };
}

function producer(id = 'producer') {
  const result = Object.assign(new EventEmitter(), { id, kind: 'audio', appData: { type: 'mic' }, closed: false, observer: new EventEmitter(), pause: async () => {}, close() { result.closed = true; result.observer.emit('close'); } });
  return result;
}

test('a pending produce cannot resurrect media after leaving and rejoining voice', async t => {
  const s = setup(t);
  const pending = deferred<any>();
  s.peer.sendTransport = { id: 'send', closed: false, produce: () => pending.promise } as any;
  let result: any;
  const operation = s.handlers.get('ms:produce')!({ transportId: 'send', kind: 'audio', rtpParameters: {}, appData: { type: 'mic' } }, (r: any) => { result = r; });
  s.voice.handleVoiceLeave(s.socket.id, 'room');
  s.voiceRooms.get('room')!.add(s.socket.id);
  const stale = producer();
  pending.resolve(stale);
  await operation;
  assert.equal(stale.closed, true);
  assert.equal(s.peer.producers.size, 0);
  assert.ok(result.error);
  assert.equal(s.events.includes('ms:new-producer'), false);
});

test('produce paused for on-demand viewing cannot announce after voice leave', async t => {
  const s = setup(t);
  const pending = deferred<void>();
  const stale = producer();
  // A screen producer is paused asynchronously before it is announced.
  stale.appData.type = 'screen';
  stale.pause = () => pending.promise;
  registerMediaSocketHandlers({ socket: s.socket, io: { to: () => ({ emit: (event: string) => s.events.push(event) }) }, voiceRooms: s.voiceRooms, onDemandMediaType: () => 'screen', broadcastRoomMembers() {}, isSocketMuted: () => false, isSharingScreen: () => false, stopRemoteControlForSocket() {}, endAnnotationSessionForSocket() {}, syncOnDemandProducer() {} } as unknown as RegisterMediaSocketHandlersDependencies);
  s.peer.sendTransport = { id: 'send', closed: false, produce: async () => stale } as any;
  let result: any;
  const operation = s.handlers.get('ms:produce')!({ transportId: 'send', kind: 'video', rtpParameters: {}, appData: { type: 'screen' } }, (r: any) => { result = r; });
  await Promise.resolve();
  s.voice.handleVoiceLeave(s.socket.id, 'room');
  pending.resolve();
  await operation;
  assert.ok(result.error);
  assert.equal(s.events.includes('ms:new-producer'), false);
});

test('late consume/close requests after peer cleanup are safe', async t => {
  const s = setup(t);
  peers.delete(s.socket.id);
  let result: any;
  await s.handlers.get('ms:consume')!({ producerId: 'gone', rtpCapabilities: {} }, (r: any) => { result = r; });
  assert.ok(result.error);
  assert.doesNotThrow(() => s.handlers.get('ms:close-producer')!({ producerId: 'gone' }));
});

test('DTLS connection failure is reported to the requesting client', async t => {
  const s = setup(t);
  s.peer.sendTransport = { id: 'send', closed: false, connect: async () => { throw new Error('DTLS failed'); } } as any;
  let result: any;
  await s.handlers.get('ms:connect-transport')!({ transportId: 'send', dtlsParameters: {} }, (r: any) => { result = r; });
  assert.match(result?.error ?? '', /DTLS failed/);
});

test('successful publication still supports legacy produce before voice join', async t => {
  const s = setup(t);
  s.voiceRooms.get('room')!.delete(s.socket.id);
  const live = producer();
  s.peer.sendTransport = { id: 'send', closed: false, produce: async () => live } as any;
  let result: any;
  await s.handlers.get('ms:produce')!({ transportId: 'send', kind: 'audio', rtpParameters: {}, appData: { type: 'mic' } }, (r: any) => { result = r; });
  assert.deepEqual(result, { producerId: live.id });
  assert.equal(s.peer.producers.get(live.id), live);
  assert.equal(s.events.includes('ms:new-producer'), true);
});

test('disconnect while publish is pending discards the old socket operation', async t => {
  const s = setup(t);
  const pending = deferred<any>();
  s.peer.sendTransport = { id: 'send', closed: false, produce: () => pending.promise } as any;
  let result: any;
  const operation = s.handlers.get('ms:produce')!({ transportId: 'send', kind: 'audio', rtpParameters: {}, appData: { type: 'mic' } }, (r: any) => { result = r; });
  s.socket.connected = false;
  const stale = producer();
  pending.resolve(stale);
  await operation;
  assert.equal(stale.closed, true);
  assert.ok(result.error);
  assert.equal(s.peer.producers.size, 0);
});

test('failed initial screen pause cleans up the unacknowledged producer', async t => {
  const s = setup(t);
  const stale = producer();
  stale.appData.type = 'screen';
  stale.pause = async () => { throw new Error('worker pause failed'); };
  registerMediaSocketHandlers({ socket: s.socket, io: { to: () => ({ emit: (event: string) => s.events.push(event) }) }, voiceRooms: s.voiceRooms, onDemandMediaType: () => 'screen', broadcastRoomMembers() {}, isSocketMuted: () => false, isSharingScreen: () => false, stopRemoteControlForSocket() {}, endAnnotationSessionForSocket() {}, syncOnDemandProducer() {} } as unknown as RegisterMediaSocketHandlersDependencies);
  s.peer.sendTransport = { id: 'send', closed: false, produce: async () => stale } as any;
  let result: any;
  await s.handlers.get('ms:produce')!({ transportId: 'send', kind: 'video', rtpParameters: {}, appData: { type: 'screen' } }, (r: any) => { result = r; });
  assert.match(result.error, /worker pause failed/);
  assert.equal(stale.closed, true);
  assert.equal(s.peer.producers.size, 0);
  assert.equal(s.events.includes('ms:new-producer'), false);
});

function transport(id: string) {
  return Object.assign(new EventEmitter(), { id, closed: false, close() { this.closed = true; } });
}

test('out-of-order transport allocation never replaces the newest request', async t => {
  const first = deferred<any>();
  const second = deferred<any>();
  let calls = 0;
  const s = setup(t, { mediaRouter: { createWebRtcTransport: () => (++calls === 1 ? first.promise : second.promise) } as any });
  let oldResult: any;
  let newResult: any;
  const oldOperation = s.handlers.get('ms:create-transport')!({ direction: 'send' }, (r: any) => { oldResult = r; });
  const newOperation = s.handlers.get('ms:create-transport')!({ direction: 'send' }, (r: any) => { newResult = r; });
  const fresh = transport('new');
  second.resolve(fresh);
  await newOperation;
  const stale = transport('old');
  first.resolve(stale);
  await oldOperation;
  assert.equal(s.peer.sendTransport, fresh);
  assert.equal(fresh.closed, false);
  assert.equal(stale.closed, true);
  assert.ok(oldResult.error);
  assert.equal(newResult.id, 'new');
});

test('pending transport allocation is discarded after voice leave/rejoin', async t => {
  const pending = deferred<any>();
  const s = setup(t, { mediaRouter: { createWebRtcTransport: () => pending.promise } as any });
  let result: any;
  const operation = s.handlers.get('ms:create-transport')!({ direction: 'recv' }, (r: any) => { result = r; });
  s.voice.handleVoiceLeave(s.socket.id, 'room');
  s.voiceRooms.get('room')!.add(s.socket.id);
  const stale = transport('old');
  pending.resolve(stale);
  await operation;
  assert.equal(stale.closed, true);
  assert.equal(s.peer.recvTransport, null);
  assert.ok(result.error);
});

for (const action of ['leave', 'switch-room', 'replace-transport', 'owner-switch-room'] as const) {
  test(`pending consume is discarded after ${action}`, async t => {
    const pending = deferred<any>();
    const owner = createPeer('owner');
    owner.roomId = 'room';
    const source = producer();
    owner.producers.set(source.id, source as any);
    t.after(() => peers.delete('owner'));
    const s = setup(t, { mediaRouter: { canConsume: () => true } as any, findProducerOwner: () => ({ socketId: 'owner', peer: owner, producer: source as any }) });
    s.peer.recvTransport = { id: 'recv', closed: false, consume: () => pending.promise } as any;
    let result: any;
    const operation = s.handlers.get('ms:consume')!({ producerId: source.id, rtpCapabilities: {} }, (r: any) => { result = r; });
    if (action === 'leave') s.voice.handleVoiceLeave(s.socket.id, 'room');
    if (action === 'switch-room') s.peer.roomId = 'other';
    if (action === 'replace-transport') s.peer.recvTransport = transport('new-recv') as any;
    if (action === 'owner-switch-room') owner.roomId = 'other';
    const stale = Object.assign(transport('consumer'), { producerId: source.id });
    pending.resolve(stale);
    await operation;
    assert.equal(stale.closed, true);
    assert.equal(s.peer.consumers.size, 0);
    assert.ok(result.error);
  });
}

test('resume errors and missing consumer return failure ACKs', async t => {
  const s = setup(t);
  let result: any;
  await s.handlers.get('ms:resume-consumer')!({ consumerId: 'gone' }, (r: any) => { result = r; });
  assert.match(result.error, /consumer not found/);
  s.peer.consumers.set('consumer', { closed: false, resume: async () => { throw new Error('resume failed'); } } as any);
  await s.handlers.get('ms:resume-consumer')!({ consumerId: 'consumer' }, (r: any) => { result = r; });
  assert.match(result.error, /resume failed/);
});

test('resume cannot ACK success after voice leave', async t => {
  const s = setup(t);
  const pending = deferred<void>();
  s.peer.consumers.set('consumer', { closed: false, resume: () => pending.promise } as any);
  let result: any;
  const operation = s.handlers.get('ms:resume-consumer')!({ consumerId: 'consumer' }, (r: any) => { result = r; });
  s.voice.handleVoiceLeave(s.socket.id, 'room');
  pending.resolve();
  await operation;
  assert.ok(result.error);
});
