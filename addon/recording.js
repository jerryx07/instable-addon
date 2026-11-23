'use strict';

const { AddonError } = require('./errors');

function normalized(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function valid(track) {
  const idPattern = track.source === 'instable' ? /^[1-9]\d{0,15}$/ : /^[1-9]\d{14,23}$/;
  return ['instable', 'monochrome'].includes(track.source) &&
    typeof track.key === 'string' && idPattern.test(track.key) &&
    [track.title, track.artist, track.album].every(s => typeof s === 'string' && s.length <= 400) &&
    normalized(track.title) && normalized(track.artist) &&
    typeof track.isrc === 'string' && /^(?:[A-Z]{2}[A-Z0-9]{3}\d{7})?$/.test(track.isrc) &&
    Number.isFinite(track.duration) && track.duration > 0 && track.duration <= 86400;
}

function encode(track) {
  if (!valid(track)) return null;
  const parts = [track.source, track.key, track.title, track.artist, track.album, track.duration, track.isrc];
  const id = 'v1.' + Buffer.from(JSON.stringify(parts)).toString('base64url');
  return id.length <= 4096 ? id : null;
}

function decode(id) {
  if (typeof id === 'string' && id.length <= 4096 && /^v1\.[\w-]+$/.test(id)) {
    try {
      const parts = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString());
      if (Array.isArray(parts) && parts.length === 7) {
        const [source, key, title, artist, album, duration, isrc] = parts;
        const track = { source, key, title, artist, album, duration, isrc };
        if (valid(track) && encode(track) === id) return track;
      }
    } catch {}
  }
  throw new AddonError(400, 'Invalid track ID. Search for the recording again.');
}

function sameRecording(target, other) {
  if (normalized(target.title) !== normalized(other.title) || normalized(target.artist) !== normalized(other.artist)) return false;
  if (target.isrc && other.isrc && target.isrc !== other.isrc) return false;
  if (target.album && other.album && normalized(target.album) !== normalized(other.album)) return false;
  if (!(target.isrc && other.isrc) && !(target.album && other.album)) return false;
  return Math.abs(target.duration - other.duration) <= 1;
}

function queryMatch(query, track) {
  const q = normalized(query);
  const title = normalized(track.title);
  const artist = normalized(track.artist);
  return [title, artist, title + ' ' + artist, artist + ' ' + title].includes(q);
}

module.exports = { normalized, encode, decode, sameRecording, queryMatch };
