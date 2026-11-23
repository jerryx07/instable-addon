'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { createSource } = require('./source');
const { AddonError } = require('./errors');
const { version } = require('../package.json');

function manifest(env) {
  return { id: 'dev.purebits.soundaddon.instable-monochrome', name: 'Instable + Monochrome', version,
    resources: ['search', 'stream'], allowDownloads: env.ADDON_ALLOW_DOWNLOADS === 'true' ? 1 : 0,
    checkValidLossless: 0, bitchordAuth: false,
    settings: [{ key: 'quality', default: 'LOSSLESS', options: [{ value: 'LOSSLESS', label: 'Verified FLAC' }] }] };
}

function sameKey(actual, expected) {
  const left = Buffer.from(actual || ''), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function createServer({ env = process.env, source = createSource({ env }) } = {}) {
  const server = http.createServer(async (req, res) => {
    const disconnected = new AbortController();
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(14500)]);
    res.once('close', () => disconnected.abort());
    function send(status, data, headers = {}) {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type', ...headers });
      res.end(req.method === 'HEAD' || status === 204 ? undefined : JSON.stringify(data));
    }
    try {
      if (req.method === 'OPTIONS') return send(204);
      if (!['GET', 'HEAD'].includes(req.method)) throw new AddonError(405, 'Use GET for addon requests.', { Allow: 'GET, HEAD, OPTIONS' });
      const url = new URL(req.url, 'http://addon.local');
      let parts;
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new AddonError(400, 'Malformed request path.'); }
      if (parts.length === 1 && parts[0] === 'health') return send(200, { status: 'ok', version });
      if (env.ADDON_ACCESS_KEY) {
        if (parts[0] !== 'a' || !sameKey(parts[1], env.ADDON_ACCESS_KEY)) throw new AddonError(401, 'A valid addon access path is required.');
        parts.splice(0, 2);
      }
      if (!parts.length || (parts.length === 1 && parts[0] === 'manifest.json')) return send(200, manifest(env));
      if (parts.length === 1 && parts[0] === 'search') {
        const query = (url.searchParams.get('q') || '').trim();
        if (query.length > 200) throw new AddonError(400, 'Search query is too long.');
        return send(200, { tracks: query ? await source.search(query, { signal }) : [] });
      }
      if (parts.length === 2 && parts[0] === 'stream') return send(200, await source.stream(parts[1], { signal }));
      throw new AddonError(404, 'Unknown addon endpoint.');
    } catch (error) {
      if (signal.aborted) return send(504, { error: 'Lookup timed out.' });
      if (error instanceof AddonError) return send(error.status, { error: error.message }, error.headers);
      return send(500, { error: 'The addon could not complete this request.' });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const server = createServer();
  server.on('error', error => { console.error('Server could not start (' + error.code + ').'); process.exitCode = 1; });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Instable + Monochrome listening on port ' + port));
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => {
    server.close();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  });
}

module.exports = { createServer };
