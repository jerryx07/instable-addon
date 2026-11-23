'use strict';

const { AddonError } = require('./errors');

function httpUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new AddonError(502, 'Invalid backend URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AddonError(502, 'Expected an HTTP(S) URL without embedded credentials.');
  return url;
}

async function requestJson(input, { signal, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(httpUrl(input), { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      throw new AddonError(response.status, 'Music backend returned HTTP ' + response.status + '.',
        response.status === 429 && retry && retry.length < 128 ? { 'Retry-After': retry } : {});
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new AddonError(502, 'Catalogue response is too large.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AddonError) throw error;
    throw new AddonError(signal?.aborted ? 504 : 502, 'Music backend did not return readable JSON.');
  }
}

module.exports = { httpUrl, requestJson };
