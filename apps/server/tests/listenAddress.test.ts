import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readListenAddress } from '../src/listenAddress';

test('bind addresses retain defaults and accept explicit IPv4/IPv6 without DNS', () => {
  assert.equal(readListenAddress(undefined, 'test'), '0.0.0.0');
  for (const address of ['127.0.0.1', '0.0.0.0', '192.168.10.3', '::1'])
    assert.equal(readListenAddress(address, 'test'), address);
  for (const address of ['', 'localhost', 'https://example.test', '127.0.0.1:3001', '--inspect', '256.1.1.1'])
    assert.throws(() => readListenAddress(address, 'test'), /must be an IPv4 or IPv6/);
});

test('real HTTP and native UDP/TCP media bind only the explicitly selected local address', { timeout: 20000 }, async () => {
  const names = ['COVE_HTTP_HOST', 'MEDIASOUP_LISTEN_IP', 'MEDIASOUP_IP', 'MEDIASOUP_PORT', 'COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR', 'COVE_SERVER_SECURITY_ENABLED'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const directory = await mkdtemp(path.join(tmpdir(), 'cove-acceptance-bind-'));
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.2', resolve));
  const mediaPort = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  Object.assign(process.env, { COVE_HTTP_HOST: '127.0.0.2', MEDIASOUP_LISTEN_IP: '127.0.0.2',
    MEDIASOUP_IP: '127.0.0.2', MEDIASOUP_PORT: String(mediaPort), COVE_DATA_DIR: directory,
    COVE_DOWNLOAD_DIR: path.join(directory, 'downloads'), COVE_SERVER_SECURITY_ENABLED: 'false' });
  const { startServer, stopServer } = await import('../src/index');
  try {
    const port = await startServer(0);
    assert.equal((await fetch(`http://127.0.0.2:${port}/api/version`)).status, 200);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/version`), /fetch failed/);
    const { webRtcServer } = await import('../src/features/media/ms');
    const dump = await webRtcServer.dump();
    assert.ok(dump.udpSockets.length > 0);
    assert.ok(dump.tcpServers.length > 0);
    for (const socket of [...dump.udpSockets, ...dump.tcpServers]) assert.equal(socket.ip, '127.0.0.2');
  } finally {
    await stopServer();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await rm(directory, { recursive: true, force: true });
  }
});
