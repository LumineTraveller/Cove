'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { WebSocketServer, WebSocket } = require('ws');
const { SOCKET_PATH, readAck, summary, demand } = require('./protocol.cjs');

// Intentionally independent of Electron, allowing bounded protocol tests without
// launching a renderer. No endpoint, token, payload or exception text is logged.
async function createTransport({ onAck, onError, framing = 'fragmented' }) {
  demand(['fragmented', 'fragmented-cork', 'single-copy'].includes(framing), 'invalid_ws_framing_control');
  let token = crypto.randomBytes(32), proof = crypto.randomBytes(32);
  let client = null, reserved = false, authenticated = false, stopped = false, exported = false;
  let authTimer = null, hello = null, port = 0, stopping = null;
  const sockets = new Set();
  let observedSocket = null;
  const timings = { headerFlush: [], copy: [], postSendBufferedBytes: [], postSendWritableBytes: [] };
  const diagnostics = { framing, sampleScope: 'Complete session including warmup; timing values use main performance.now().', tcpNoDelayRequested: false, tcpNoDelayNativeResult: null,
    tcpNoDelayObservation: 'ws 8.20.1 setSocket calls setNoDelay(); probe also requests true. Native UV return is observed when available; no getsockopt getter is exposed by Node.',
    drainEvents: 0, dataMessages: 0, websocketFramesPerMessage: framing === 'single-copy' ? 1 : 2,
    fullFrameCopyBytes: 0, fullFrameCopies: 0, writableHighWaterMark: null, bytesWritten: 0, bytesRead: 0,
    maxPostSendBufferedBytes: 0, maxPostSendWritableBytes: 0 };
  const observe = () => {
    if (!observedSocket) return;
    diagnostics.bytesWritten = observedSocket.bytesWritten; diagnostics.bytesRead = observedSocket.bytesRead;
    diagnostics.writableHighWaterMark = observedSocket.writableHighWaterMark;
  };
  const server = http.createServer({ maxHeaderSize: 4096, headersTimeout: 1500,
    requestTimeout: 1500, connectionsCheckingInterval: 500 }, (_request, response) => { response.writeHead(403, { Connection: 'close' }); response.end(); });
  server.maxConnections = 2;
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {});
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => { if (!stopped) onError('loopback_listener_failed'); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128, perMessageDeflate: false, clientTracking: true });
  const erase = () => { token?.fill(0); proof?.fill(0); hello?.fill(0); token = proof = hello = null; };
  const stop = () => stopping ||= (async () => {
    stopped = true; clearTimeout(authTimer); authTimer = null; erase();
    observe();
    const closedSockets = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
    client?.removeAllListeners('message'); client?.terminate(); client = null;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => {
      let done = false;
      const timer = setTimeout(finish, 300);
      function finish() { if (done) return; done = true; clearTimeout(timer); resolve(); }
      const closedServer = new Promise(resolveServer => { try { server.close(resolveServer); } catch { resolveServer(); } });
      const closedWs = new Promise(resolveWs => { try { wss.close(resolveWs); } catch { resolveWs(); } });
      Promise.allSettled([...closedSockets, closedServer, closedWs]).then(finish);
    });
    observe(); observedSocket = null;
  })();
  const fault = code => { if (!stopped) { onError(code); void stop(); } };
  server.on('upgrade', (request, socket, head) => {
    const headerBytes = request.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value) + 4, 0);
    if (stopped || reserved || authenticated || socket.remoteAddress !== '127.0.0.1' ||
        request.method !== 'GET' || request.url !== SOCKET_PATH || request.headers.origin !== 'null' ||
        request.headers.host !== '127.0.0.1:' + port || headerBytes > 4096 ||
        request.headers['sec-websocket-protocol']) {
      socket.destroy(); return;
    }
    reserved = true;
    try {
      wss.handleUpgrade(request, socket, head, ws => {
        client = ws;
        observedSocket = socket;
        socket.setNoDelay(true); diagnostics.tcpNoDelayRequested = true;
        // Probe-only confirmation of the existing owned UV TCP operation.
        // This private handle stays internal and is never serialized or logged.
        if (typeof socket._handle?.setNoDelay === 'function') {
          const status = socket._handle.setNoDelay(true);
          diagnostics.tcpNoDelayNativeResult = Number.isInteger(status) ? status : null;
          if (Number.isInteger(status) && status !== 0) { fault('loopback_no_delay_failed'); return; }
        }
        socket.on('drain', () => { diagnostics.drainEvents++; });
        socket.setTimeout(0); // The dedicated auth deadline now owns this socket.
        ws.on('error', () => fault('loopback_socket_failed'));
        ws.on('close', () => { if (!stopped) fault('loopback_socket_closed'); });
        authTimer = setTimeout(() => fault('loopback_auth_timeout'), 1500);
        ws.on('message', (buffer, binary) => {
          if (stopped) return;
          if (!authenticated) {
            if (!binary || !Buffer.isBuffer(buffer) || buffer.length !== 33 || buffer[0] !== 1 || !token ||
                !crypto.timingSafeEqual(buffer.subarray(1), token)) { fault('loopback_auth_failed'); return; }
            authenticated = true; clearTimeout(authTimer); authTimer = null; socket.setTimeout(0);
            token.fill(0); token = null;
            hello = Buffer.alloc(33); hello[0] = 2; proof.copy(hello, 1); proof.fill(0); proof = null;
            // Closing only the listening handle leaves the authenticated upgrade
            // alive. Every other accepted TCP socket is retired immediately.
            server.close(() => {});
            for (const candidate of sockets) if (candidate !== socket) candidate.destroy();
            ws.send(hello, { binary: true, compress: false }, error => {
              hello?.fill(0); hello = null;
              if (error) fault('loopback_hello_failed');
            });
            return;
          }
          if (!binary) { fault('loopback_ack_invalid'); return; }
          const ack = readAck(buffer);
          if (!ack) { fault('loopback_ack_invalid'); return; }
          onAck(ack);
        });
      });
    } catch { fault('loopback_upgrade_failed'); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('loopback_listen_timeout')), 1500);
      const done = error => { clearTimeout(timer); server.off('error', onFailure); error ? reject(new Error('loopback_listen_failed')) : resolve(); };
      const onFailure = () => done(true); server.once('error', onFailure);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });
  } catch (error) { await stop(); throw error; }
  return {
    credentials() {
      if (exported || stopped || !token || !proof) throw new Error('loopback_credentials_unavailable');
      exported = true;
      return { port, path: SOCKET_PATH, token: token.toString('base64'), proof: proof.toString('base64') };
    },
    send(slot, callback) {
      if (stopped || !authenticated || client?.readyState !== WebSocket.OPEN) throw new Error('loopback_not_authenticated');
      const started = performance.now(); diagnostics.dataMessages++;
      const flushed = error => {
        if (error) fault('loopback_payload_send_failed');
        else if (!stopped) callback();
      };
      if (framing === 'single-copy') {
        // Deliberately expensive causal control, not a proposed optimization.
        const packet = Buffer.concat([slot.header, slot.payload]);
        timings.copy.push(performance.now() - started); diagnostics.fullFrameCopies++; diagnostics.fullFrameCopyBytes += packet.length;
        client.send(packet, { binary: true, fin: true, compress: false }, flushed);
      } else {
        if (framing === 'fragmented-cork') observedSocket.cork();
        try {
          client.send(slot.header, { binary: true, fin: false, compress: false }, error => {
            if (error) fault('loopback_header_send_failed');
            else if (!stopped) timings.headerFlush.push(performance.now() - started);
          });
          client.send(slot.payload, { binary: true, fin: true, compress: false }, flushed);
        } finally { if (framing === 'fragmented-cork') observedSocket?.uncork(); }
      }
      const buffered = client?.bufferedAmount || 0, writable = observedSocket?.writableLength || 0;
      timings.postSendBufferedBytes.push(buffered); timings.postSendWritableBytes.push(writable);
      diagnostics.maxPostSendBufferedBytes = Math.max(diagnostics.maxPostSendBufferedBytes, buffered);
      diagnostics.maxPostSendWritableBytes = Math.max(diagnostics.maxPostSendWritableBytes, writable);
      observe();
    },
    stop,
    state() { return { authenticated, stopped, listenerOpen: server.listening, socketCount: sockets.size, websocketCount: wss.clients.size, authTimerActive: !!authTimer }; },
    diagnostics() { observe(); return { ...diagnostics, headerFlushMs: summary(timings.headerFlush),
      fullCopyMs: summary(timings.copy), postSendBufferedBytes: summary(timings.postSendBufferedBytes),
      postSendWritableBytes: summary(timings.postSendWritableBytes) }; },
  };
}
module.exports = { createTransport };
