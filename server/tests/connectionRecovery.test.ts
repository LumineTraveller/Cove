import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { DisconnectGrace, DISCONNECT_GRACE_MS } from '../src/disconnectGrace';

test('real transport interruption restores the same socket, room and peer; explicit disconnect cleans immediately', async t => {
  const http = createServer();
  const io = new Server(http, {
    connectionStateRecovery: { maxDisconnectionDuration: DISCONNECT_GRACE_MS * 2, skipMiddlewares: false },
  });
  const grace = new DisconnectGrace();
  const peers = new Map<string, object>();
  let active!: Socket;
  io.on('connection', socket => {
    active = socket;
    grace.recover(socket.id);
    if (!peers.has(socket.id)) peers.set(socket.id, {});
    socket.join('voice-room');
    socket.emit('session:checkpoint');
    socket.on('disconnect', reason => {
      if (reason === 'transport close') grace.fail(socket.id, () => peers.delete(socket.id));
      else peers.delete(socket.id);
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as { port: number }).port;
  const client = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'], reconnectionDelay: 50, reconnectionDelayMax: 50, randomizationFactor: 0,
  });
  t.after(async () => { client.disconnect(); grace.clear(); await new Promise<void>(resolve => io.close(() => resolve())); });
  await once(client, 'session:checkpoint');
  const id = client.id!;
  const peer = peers.get(id);
  const disconnected = once(active, 'disconnect');
  const reconnected = once(client, 'connect');
  client.io.engine.close();
  await disconnected;
  assert.equal(peers.get(id), peer);
  await reconnected;
  assert.equal(client.recovered, true);
  assert.equal(client.id, id);
  assert.equal(peers.get(id), peer);
  assert.equal(active.rooms.has('voice-room'), true);
  const gone = once(active, 'disconnect');
  client.disconnect();
  await gone;
  assert.equal(peers.has(id), false);
});
