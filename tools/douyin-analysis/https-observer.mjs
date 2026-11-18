// Exact-host research observer. No side effects until listen(); no CA installation or account access.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createMetadataSampler } from './metadata-sampler.mjs';

export const OBSERVED_HOST = 'minigame.zijieapi.com';
export function createHttpObserver({ port = 17327, interceptHosts = [OBSERVED_HOST], interceptPorts = [443],
  certificateFor, caIsInstalled = () => false, log = () => {}, onMetadata = () => {}, upstreamCa } = {}) {
  if (interceptHosts.length !== 1 || interceptHosts[0] !== OBSERVED_HOST || interceptPorts.length !== 1 || interceptPorts[0] !== 443) throw new Error('HOST_SCOPE_MISMATCH');
  if (typeof certificateFor !== 'function') throw new Error('CERTIFICATE_PROVIDER_REQUIRED');
  if (upstreamCa !== undefined) throw new Error('UPSTREAM_TRUST_OVERRIDE_FORBIDDEN');
  const sampler = createMetadataSampler({ emit: onMetadata });
  const safeLog = kind => { try { log(kind, ''); } catch {} };
  const sockets = new Set(), requests = new Set(); let serverTls, started = false, nextId = 0;
  const server = http.createServer(onRequest);
  function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; }
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (req, client, head) => {
    client.on('error', () => {});
    let url;
    try {
      if (/[\s/?#@]/.test(req.url || '')) throw new Error('BAD_CONNECT');
      url = new URL(`https://${req.url}`);
    } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = url.hostname.replace(/^\[|\]$/g, ''), targetPort = Number(url.port || 443);
    if (host.toLowerCase() !== OBSERVED_HOST || targetPort !== 443) {
      const upstream = track(net.connect(targetPort, host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      }));
      upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy());
      return;
    }
    try {
      if (!serverTls) {
        const { cert, keyPem } = certificateFor(OBSERVED_HOST);
        serverTls = tls.createServer({ cert, key: keyPem, ALPNProtocols: ['http/1.1'] }, socket => {
          socket.observedTarget = true; server.emit('connection', socket);
        });
        serverTls.on('tlsClientError', () => safeLog('tls_error'));
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) client.unshift(head);
      serverTls.emit('connection', client);
    } catch { safeLog('certificate_error'); client.destroy(); }
  });
  function requestTarget(req) {
    if (req.socket.observedTarget) return { host: OBSERVED_HOST, port: 443, secure: true, path: req.url, sample: true };
    // Plain HTTP proxy requests are forwarded without sampling or logging their contents.
    const url = new URL(req.url);
    if (url.protocol !== 'http:') throw new Error('BAD_HTTP_TARGET');
    return { host: url.hostname, port: Number(url.port || 80), secure: false, path: url.pathname + url.search, sample: false };
  }
  function onRequest(req, res) {
    let target;
    try { target = requestTarget(req); } catch { res.writeHead(400); res.end(); return; }
    const id = ++nextId;
    const requestSample = target.sample ? sampler.begin({ id, direction: 'request', host: OBSERVED_HOST, url: target.path, method: req.method, headers: req.headers }) : null;
    if (requestSample) { req.on('data', chunk => requestSample.add(chunk)); req.once('end', () => requestSample.end()); req.once('aborted', () => requestSample.abort()); }
    let upstream;
    try {
      upstream = (target.secure ? https : http).request({ host: target.host, port: target.port, path: target.path,
        method: req.method, headers: req.headers, servername: target.host, rejectUnauthorized: true,
      }, response => {
        const responseSample = target.sample ? sampler.begin({ id, direction: 'response', host: OBSERVED_HOST, url: target.path,
          method: req.method, status: response.statusCode, headers: response.headers }) : null;
        if (responseSample) { response.on('data', chunk => responseSample.add(chunk)); response.once('end', () => responseSample.end()); response.once('aborted', () => responseSample.abort()); }
        response.on('error', () => { responseSample?.abort(); res.destroy(); });
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
    } catch { requestSample?.abort(); res.writeHead(502); res.end(); return; }
    requests.add(upstream); upstream.once('close', () => requests.delete(upstream)); upstream.on('socket', track);
    upstream.on('error', () => { requestSample?.abort(); if (!res.headersSent) res.writeHead(502); res.end(); safeLog('upstream_error'); });
    req.on('error', () => { requestSample?.abort(); upstream.destroy(); });
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  }
  // Selected-host WebSocket upgrades are forwarded; frames are never decoded or recorded.
  server.on('upgrade', (req, client, head) => {
    if (!req.socket.observedTarget) { client.destroy(); return; }
    const upstream = https.request({ host: OBSERVED_HOST, port: 443, path: req.url, method: req.method,
      headers: req.headers, servername: OBSERVED_HOST, rejectUnauthorized: true });
    requests.add(upstream); upstream.once('close', () => requests.delete(upstream)); upstream.on('socket', track);
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      track(socket); client.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${Object.entries(response.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy());
      client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy());
      client.pipe(socket); socket.pipe(client);
      if (head.length) socket.write(head); if (upstreamHead.length) client.write(upstreamHead);
    });
    upstream.on('response', response => { response.resume(); client.destroy(); });
    upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy()); upstream.end();
  });
  return {
    get port() { return server.address()?.port ?? port; },
    async listen() {
      if (started) return;
      if (!caIsInstalled()) throw new Error('CA_NOT_INSTALLED');
      await new Promise((resolve, reject) => { const fail = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', fail); started = true; resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1'); });
    },
    async stop() {
      if (!started) return;
      started = false; const closing = new Promise(resolve => server.close(resolve));
      for (const request of requests) request.destroy(); requests.clear();
      for (const socket of sockets) socket.destroy(); sockets.clear(); serverTls?.close(); await closing;
    },
  };
}
