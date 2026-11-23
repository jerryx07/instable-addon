'use strict';

const { AddonError } = require('./errors');
const { httpUrl } = require('./http');
const { normalized } = require('./recording');

const LIMIT = 64 * 1024;

async function prefix(response) {
  if (!response.body) throw new AddonError(502, 'Empty audio response.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < LIMIT) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, LIMIT - length);
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, length);
}

// A large picture or padding block can push optional Vorbis comments outside the range.
function comments(bytes) {
  const tags = new Map();
  for (let offset = 4; offset + 4 <= bytes.length;) {
    const type = bytes[offset], start = offset + 4, end = start + bytes.readUIntBE(offset + 1, 3);
    if (end > bytes.length) break;
    if ((type & 127) === 4 && start + 8 <= end) {
      let pos = start + 4 + bytes.readUInt32LE(start);
      if (pos + 4 > end) break;
      const count = bytes.readUInt32LE(pos);
      pos += 4;
      for (let i = 0; i < count && pos + 4 <= end; i++) {
        const size = bytes.readUInt32LE(pos);
        pos += 4;
        if (pos + size > end) break;
        const text = bytes.toString('utf8', pos, pos + size);
        pos += size;
        const equals = text.indexOf('=');
        const key = text.slice(0, equals).toUpperCase();
        if (equals > 0 && ['TITLE', 'ARTIST', 'ALBUM', 'ISRC'].includes(key)) {
          const values = tags.get(key) || [];
          values.push(text.slice(equals + 1));
          tags.set(key, values);
        }
      }
    }
    if (type & 128) break;
    offset = end;
  }
  return tags;
}

async function probeAudio(input, track, { signal, fetchImpl = fetch }) {
  const url = httpUrl(input);
  let response, bytes;
  try {
    response = await fetchImpl(url, { headers: { Range: 'bytes=0-65535', 'Accept-Encoding': 'identity' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      throw new AddonError(response.status, 'Audio host returned HTTP ' + response.status + '.',
        response.status === 429 && retry && retry.length < 128 ? { 'Retry-After': retry } : {});
    }
    bytes = await prefix(response);
  } catch (error) {
    if (error instanceof AddonError) throw error;
    throw new AddonError(signal?.aborted ? 504 : 502, 'Audio host could not be read.');
  }
  if (bytes.length < 42 || bytes.toString('latin1', 0, 4) !== 'fLaC' ||
      (bytes[4] & 127) !== 0 || bytes.readUIntBE(5, 3) !== 34) throw new AddonError(422, 'Expected a native FLAC stream.');
  const info = bytes.readBigUInt64BE(18);
  const sampleRate = Number(info >> 44n);
  const channels = Number((info >> 41n) & 7n) + 1;
  const bitDepth = Number((info >> 36n) & 31n) + 1;
  const duration = Number(info & 0xfffffffffn) / sampleRate;
  if (sampleRate < 1 || sampleRate > 655350 || bitDepth < 4 || !duration || Math.abs(duration - track.duration) > 1) {
    throw new AddonError(422, 'Audio duration or FLAC metadata does not match the requested recording.');
  }
  const tags = comments(bytes);
  for (const [key, expected] of [['TITLE', track.title], ['ARTIST', track.artist], ['ALBUM', track.album], ['ISRC', track.isrc]]) {
    const values = tags.get(key);
    if (!values?.length || !expected) continue;
    const norm = key === 'ISRC' ? s => s.replace(/-/g, '').toUpperCase() : normalized;
    if (![...values, values.join(', ')].some(value => norm(value) === norm(expected))) {
      throw new AddonError(422, 'Audio file tags identify a different recording or release.');
    }
  }
  return { url: httpUrl(response.url || url.href).href, format: 'flac', codec: 'flac', container: 'flac',
    manifest: 'none', encrypted: false, sampleRate, bitDepth, channels, duration };
}

module.exports = { probeAudio };
