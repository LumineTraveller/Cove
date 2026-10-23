// Test-only ICE/TCP fault injection. Never binds or forwards outside loopback.
const net = require('node:net');
const dgram = require('node:dgram');
async function createLoopbackMediaProxy(targetPort, protocol = 'tcp') {
  if (protocol === 'udp') return createLoopbackUdpMediaProxy(targetPort);
  if (protocol !== 'tcp') throw new Error('Only TCP or UDP loopback media proxies are supported');
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

/** Datagram relay; each browser tuple gets its own SFU-facing UDP tuple. */
async function createLoopbackUdpMediaProxy(targetPort) {
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) throw new Error('Invalid local SFU port');
  let blocked = false, closed = false;
  const front = dgram.createSocket('udp4');
  const flows = new Map();
  const counts = { interruptedConnections: 0, toServerBytes: 0, toClientBytes: 0, toServerDatagrams: 0, toClientDatagrams: 0, droppedDatagrams: 0, peakFlows: 0, receivedDatagrams: 0, rejectedNonLoopbackDatagrams: 0 };
  const closeFlow = key => { const flow = flows.get(key); if (!flow) return; flows.delete(key); flow.upstream.close(); };
  front.on('message', (bytes, remote) => {
    counts.receivedDatagrams++;
    if (closed || remote.address !== '127.0.0.1') { counts.rejectedNonLoopbackDatagrams++; return; }
    const key = `${remote.address}:${remote.port}`;
    let flow = flows.get(key);
    if (!flow) {
      if (flows.size >= 64) { counts.droppedDatagrams++; return; }
      const upstream = dgram.createSocket('udp4');
      flow = { upstream, remote, lastSeen: Date.now(), interrupted: false }; flows.set(key, flow);
      counts.peakFlows = Math.max(counts.peakFlows, flows.size);
      upstream.on('error', () => closeFlow(key));
      // Bind even if this first packet is dropped, so a flow created during an
      // outage still owns a socket that can be closed/reaped deterministically.
      upstream.bind(0, '127.0.0.1');
      upstream.on('message', (reply, source) => {
        if (closed || source.address !== '127.0.0.1' || source.port !== targetPort) return;
        flow.lastSeen = Date.now();
        if (blocked) { counts.droppedDatagrams++; if (!flow.interrupted) { flow.interrupted = true; counts.interruptedConnections++; } return; }
        counts.toClientDatagrams++; counts.toClientBytes += reply.length;
        front.send(reply, flow.remote.port, '127.0.0.1', () => {});
      });
    }
    flow.lastSeen = Date.now();
    if (blocked) { counts.droppedDatagrams++; if (!flow.interrupted) { flow.interrupted = true; counts.interruptedConnections++; } return; }
    counts.toServerDatagrams++; counts.toServerBytes += bytes.length;
    flow.upstream.send(bytes, targetPort, '127.0.0.1', () => {});
  });
  await new Promise((resolve, reject) => { front.once('error', reject); front.bind(0, '127.0.0.1', resolve); });
  const reap = setInterval(() => { for (const [key, flow] of flows) if (Date.now() - flow.lastSeen > 30000) closeFlow(key); }, 2000);
  return { port: front.address().port,
    setBlocked(value) { blocked = value === true; if (!blocked) for (const flow of flows.values()) flow.interrupted = false; },
    counts: () => ({ ...counts, activeFlows: flows.size, protocol: 'udp', blocked }),
    close: () => new Promise(resolve => { if (closed) return resolve(); closed = true; clearInterval(reap); for (const key of flows.keys()) closeFlow(key); front.close(resolve); }),
  };
}
module.exports = { createLoopbackMediaProxy, createLoopbackUdpMediaProxy };
