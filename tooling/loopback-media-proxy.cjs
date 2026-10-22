// Test-only ICE/TCP fault injection. Never binds or forwards outside loopback.
const net = require('node:net');
async function createLoopbackMediaProxy(targetPort) {
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) throw new Error('Invalid local SFU port');
  let blocked = false, closed = false;
  const pairs = new Set();
  const counts = { interruptedConnections: 0, toServerBytes: 0, toClientBytes: 0 };
  const server = net.createServer(client => {
    if (closed || client.remoteAddress !== '127.0.0.1') { client.destroy(); return; }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    const pair = { client, upstream }; pairs.add(pair);
    const close = () => { pairs.delete(pair); client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close);
    client.once('close', close); upstream.once('close', close);
    client.on('data', bytes => { counts.toServerBytes += bytes.length; if (!upstream.write(bytes)) client.pause(); });
    upstream.on('data', bytes => { counts.toClientBytes += bytes.length; if (!client.write(bytes)) upstream.pause(); });
    client.on('drain', () => { if (!blocked) upstream.resume(); });
    upstream.on('drain', () => { if (!blocked) client.resume(); });
    if (blocked) { client.pause(); upstream.pause(); counts.interruptedConnections++; }
  });
  await new Promise((resolve, reject) => {
    const ready = () => { server.off('error', reject); resolve(); };
    server.once('error', reject); server.once('listening', ready); server.listen(0, '127.0.0.1');
  });
  server.on('error', () => {});
  return { port: server.address().port, setBlocked(value) {
      blocked = value === true;
      for (const pair of pairs) {
        if (blocked) { pair.client.pause(); pair.upstream.pause(); counts.interruptedConnections++; }
        else { pair.client.resume(); pair.upstream.resume(); }
      }
    },
    counts: () => ({ ...counts }),
    close: () => new Promise(resolve => { if (closed) return resolve(); closed = true;
      for (const pair of pairs) { pair.client.destroy(); pair.upstream.destroy(); } server.close(resolve); }),
  };
}
module.exports = { createLoopbackMediaProxy };
