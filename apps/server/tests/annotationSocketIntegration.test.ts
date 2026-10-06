import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { Server, type Socket as ServerSocket } from 'socket.io';

import { createAnnotationService } from '../src/features/annotations/annotationService';
import { registerAnnotationSocketHandlers } from '../src/features/annotations/socketHandlers';
import { createControlService } from '../src/features/remote-control/controlService';
import { registerRemoteControlSocketHandlers } from '../src/features/remote-control/socketHandlers';
import { RemoteControlRegistry } from '../src/features/remote-control/remoteControl';

const ROOM = 'annotation-room';

function emitAck<T>(socket: ClientSocket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ACK`)), 3_000);
    socket.emit(event, payload, (result: T) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function waitEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function connectRole(url: string, role: string) {
  const socket = connectSocket(url, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 3_000,
    auth: { role },
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  socket.connect();
  await connected;
  return socket;
}

test('Socket.IO annotation events provide snapshots to late viewers and reject stale or forged targets', { timeout: 15_000 }, async (t) => {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const roomMembers = new Map([[ROOM, new Set<string>()]]);
  const userNames = new Map<string, string>();
  const remoteControlCapabilities = new Set<string>();
  const activeScreenSessions = new Map<string, string>();
  const remoteControls = new RemoteControlRegistry();
  const clients: ClientSocket[] = [];
  const control = createControlService({ io: io as never, remoteControls });
  const annotations = createAnnotationService({
    io: io as never,
    roomMembers,
    userNames,
    currentScreenSessionId: (roomId, sharerSocketId) =>
      roomId === ROOM ? activeScreenSessions.get(sharerSocketId) ?? null : null,
    stopRemoteControlForSocket: control.stopRemoteControlForSocket,
  });

  io.on('connection', (socket: ServerSocket) => {
    const role = String(socket.handshake.auth.role ?? 'outsider');
    const username = role === 'owner' ? 'Sharer' : role === 'viewer' ? 'Viewer' : 'Guest';
    userNames.set(socket.id, username);
    void socket.join(ROOM);
    if (role !== 'outsider') roomMembers.get(ROOM)!.add(socket.id);
    if (role === 'owner') activeScreenSessions.set(socket.id, 'screen-1');
    if (role !== 'outsider') remoteControlCapabilities.add(socket.id);

    registerAnnotationSocketHandlers({ socket: socket as never, annotations });
    registerRemoteControlSocketHandlers({
      socket: socket as never,
      roomMembers,
      remoteControlCapabilities,
      isSharingScreen: (socketId, roomId) =>
        roomId === ROOM && activeScreenSessions.has(socketId),
      isRemoteControlAllowed: annotations.remoteControlAllowed,
      remoteControls,
      io: io as never,
      userNames,
      publicUserId: (socketId) => socketId,
      emitRemoteRequestCancelled: control.emitRemoteRequestCancelled,
      emitRemoteControlStopped: control.emitRemoteControlStopped,
    });
    socket.on('disconnect', () => {
      roomMembers.get(ROOM)?.delete(socket.id);
      remoteControlCapabilities.delete(socket.id);
      userNames.delete(socket.id);
      activeScreenSessions.delete(socket.id);
      annotations.removeMember(socket.id);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  const owner = await connectRole(url, 'owner');
  clients.push(owner);
  const viewer = await connectRole(url, 'viewer');
  clients.push(viewer);
  const ownerId = owner.id!;
  const oldTarget = { roomId: ROOM, sharerSocketId: ownerId, sessionId: 'screen-1' };

  const initial = await emitAck<any>(owner, 'annotation:get', {
    target: { roomId: ROOM, sharerSocketId: ownerId },
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.state.enabled, false);
  assert.equal(initial.state.sessionId, 'screen-1');

  assert.equal(
    (await emitAck<any>(owner, 'annotation:configure', {
      target: oldTarget,
      enabled: true,
      permission: 'request',
    })).state.enabled,
    true,
  );

  const denied = await emitAck<any>(viewer, 'annotation:draw', {
    target: oldTarget,
    stroke: {
      id: 'forged-stroke',
      authorSocketId: ownerId,
      tool: 'pen',
      color: '#123456',
      width: 0.004,
      points: [{ x: 0.5, y: 0.5 }],
    },
  });
  assert.equal(denied.error.code, 'forbidden');

  const requested = await emitAck<any>(viewer, 'annotation:request', { target: oldTarget });
  assert.equal(requested.ok, true);
  const approved = await emitAck<any>(owner, 'annotation:respond', {
    target: oldTarget,
    requesterSocketId: viewer.id,
    accepted: true,
  });
  assert.equal(approved.state.grants.includes(viewer.id), true);

  const maliciousApproval = await emitAck<any>(viewer, 'annotation:respond', {
    target: oldTarget,
    requesterSocketId: viewer.id,
    accepted: true,
  });
  assert.equal(maliciousApproval.error.code, 'forbidden');

  const strokeEvent = waitEvent<any>(owner, 'annotation:stroke');
  const drawn = await emitAck<any>(viewer, 'annotation:draw', {
    target: oldTarget,
    stroke: {
      id: 'shared-stroke',
      authorSocketId: ownerId,
      tool: 'pen',
      color: '#123456',
      width: 0.004,
      points: [{ x: 0.1, y: 0.9 }, { x: 0.2, y: 0.8 }],
    },
  });
  assert.equal(drawn.ok, true);
  const broadcast = await strokeEvent;
  assert.equal(broadcast.stroke.authorSocketId, viewer.id);
  assert.equal(broadcast.sessionId, 'screen-1');

  const outsider = await connectRole(url, 'outsider');
  clients.push(outsider);
  const forged = await emitAck<any>(outsider, 'annotation:get', { target: oldTarget });
  assert.equal(forged.error.code, 'forbidden');

  const lateViewer = await connectRole(url, 'late-viewer');
  clients.push(lateViewer);
  const lateSnapshot = await emitAck<any>(lateViewer, 'annotation:get', {
    target: { roomId: ROOM, sharerSocketId: ownerId },
  });
  assert.equal(lateSnapshot.state.strokes.length, 1);
  assert.equal(lateSnapshot.state.strokes[0].authorSocketId, viewer.id);
  assert.equal(lateSnapshot.state.grants.includes(viewer.id), true);

  const pending = await emitAck<any>(viewer, 'remote-control:request', {
    roomId: ROOM,
    sharerSocketId: ownerId,
  });
  assert.equal(pending.ok, true);
  const controllerCancelled = waitEvent<any>(viewer, 'remote-control:request-result');
  const sharerCancelled = waitEvent<any>(owner, 'remote-control:request-cancelled');
  const disabled = await emitAck<any>(owner, 'annotation:configure', {
    target: oldTarget,
    remoteControlAllowed: false,
  });
  assert.equal(disabled.ok, true);
  assert.equal((await controllerCancelled).accepted, false);
  assert.equal((await sharerCancelled).requestId, pending.requestId);
  const blockedRequest = await emitAck<any>(viewer, 'remote-control:request', {
    roomId: ROOM,
    sharerSocketId: ownerId,
  });
  assert.equal(blockedRequest.ok, false);

  await emitAck<any>(owner, 'annotation:configure', {
    target: oldTarget,
    remoteControlAllowed: true,
  });
  const request = await emitAck<any>(viewer, 'remote-control:request', {
    roomId: ROOM,
    sharerSocketId: ownerId,
  });
  assert.equal(request.ok, true);
  const viewerStarted = waitEvent<any>(viewer, 'remote-control:started');
  const sharerStarted = waitEvent<any>(owner, 'remote-control:started');
  assert.equal((await emitAck<any>(owner, 'remote-control:respond', {
    requestId: request.requestId,
    accepted: true,
  })).ok, true);
  const session = await viewerStarted;
  await sharerStarted;
  assert.equal(typeof session.sessionId, 'string');

  const viewerStopped = waitEvent<any>(viewer, 'remote-control:stopped');
  const sharerStopped = waitEvent<any>(owner, 'remote-control:stopped');
  await emitAck<any>(owner, 'annotation:configure', {
    target: oldTarget,
    remoteControlAllowed: false,
  });
  await viewerStopped;
  await sharerStopped;
  owner.once('remote-control:input', () => assert.fail('input must not reach the sharer after remote control was disabled'));
  viewer.emit('remote-control:input', {
    sessionId: session.sessionId,
    input: { type: 'pointer', x: 0.5, y: 0.5 },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  activeScreenSessions.set(ownerId, 'screen-2');
  const staleDraw = await emitAck<any>(viewer, 'annotation:draw', {
    target: oldTarget,
    stroke: {
      id: 'stale-stroke',
      tool: 'pen',
      color: '#123456',
      width: 0.004,
      points: [{ x: 0.5, y: 0.5 }],
    },
  });
  assert.equal(staleDraw.error.code, 'invalid_target');
  const nextGeneration = await emitAck<any>(owner, 'annotation:get', {
    target: { roomId: ROOM, sharerSocketId: ownerId },
  });
  assert.equal(nextGeneration.state.sessionId, 'screen-2');
  assert.equal(nextGeneration.state.enabled, false);
  assert.deepEqual(nextGeneration.state.strokes, []);

  annotations.endForSocket(ownerId, ROOM, 'screen-1');
  assert.equal(annotations.sessionCount(), 1);
});
