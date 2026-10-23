'use strict';
// Real SFU/SQLite fixture, restricted to a launcher-owned runtime directory.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const runtime = path.resolve(process.env.COVE_FPS_RUN_DIR || '');
const runtimeName=process.env.COVE_FPS_RUNTIME_NAME||'fps-candidate';
if(!/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/.test(runtimeName))throw Error('Invalid performance runtime namespace');
const relative = path.relative(path.join(root, 'runtime', runtimeName), runtime);
if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('An isolated screen-performance run directory is required');
process.env.COVE_DATA_DIR = path.join(runtime, 'backend-data');
process.env.COVE_DOWNLOAD_DIR = path.join(process.env.COVE_DATA_DIR, 'downloads');
process.env.COVE_SERVER_SECURITY_ENABLED = 'false';
process.env.COVE_HTTP_HOST = '127.0.0.1';
process.env.MEDIASOUP_IP = '127.0.0.1';
process.env.MEDIASOUP_LISTEN_IP = '127.0.0.1';
process.env.MEDIASOUP_PORT = process.env.COVE_QA_MEDIA_PORT;
fs.mkdirSync(process.env.COVE_DATA_DIR, { recursive: true });
const { startServer, stopServer } = require(path.join(root, 'apps/server/dist/index.js'));
const { smokeClientIdentity } = require(path.join(root, 'tooling/smoke-client-identity.cjs'));
const { io } = require('socket.io-client');
const identity = smokeClientIdentity();
let stopped = false;
async function stop() { if (stopped) return; stopped = true; await stopServer(); if(process.connected)process.disconnect(); }
async function main() {
  const port = await startServer(0);
  const base = 'http://127.0.0.1:' + port;
  const accounts = [];
  for (let index = 0; index < 2; index++) {
    const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', ...identity.headers }, body: JSON.stringify({ email: `fps-${index}@example.test`, password: 'isolated-fps-password-123', username: `Floating ${index}` }) });
    assert.equal(response.status, 201); accounts.push(await response.json());
  }
  const socket = io(base, { auth: identity.auth, autoConnect: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.equal((await socket.timeout(8000).emitWithAck('user:register', { authToken: accounts[0].token, clientId: 'fps-seed', ...identity.registration })).ok, true);
  const created = await socket.timeout(8000).emitWithAck('room:create', { name: 'Isolated screen performance' });
  assert.ok(created.room?.id); socket.disconnect();
  // Account tokens remain on this owned IPC channel and never enter reports.
  process.send?.({ type: 'ready', base, roomId: created.room.id, accounts });
  process.on('message', async message => {
    try {
      if (message?.type === 'stop') await stop();
      else if (message?.type === 'snapshot') {
        const { peers } = require(path.join(root, 'apps/server/dist/features/media/ms.js'));
        const resources = { peers: peers.size, transports: 0, producers: 0, consumers: 0 };
        for (const peer of peers.values()) {
          for (const [key, value] of Object.entries(peer)) if (/Transport$/.test(key) && value && !value.closed) resources.transports++;
          resources.producers += peer.producers.size; resources.consumers += peer.consumers.size;
        }
        process.send?.({ type: 'snapshot', requestId: message.requestId, resources });
      }
    } catch (error) { process.send?.({ type: 'backend-error', requestId: message?.requestId, error: error.message }); }
  });
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
process.once('disconnect', () => void stop());
main().catch(async error => { console.error(error); await stopServer().catch(() => {}); process.exitCode = 1; if(process.connected)process.disconnect(); });

