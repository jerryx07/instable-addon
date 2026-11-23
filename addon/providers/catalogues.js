'use strict';

const { AddonError } = require('../errors');
const { httpUrl, requestJson } = require('../http');
const { normalized } = require('../recording');

function endpoint(base, path, params = {}) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + path;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function string(value) { return typeof value === 'string' ? value.trim() : ''; }

function trackKey(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return string(value);
}

function recordingCode(value) {
  const code = string(value).toUpperCase().replace(/-/g, '');
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) ? code : '';
}

function artwork(value) {
  try { return httpUrl(value).href; } catch { return undefined; }
}

function createCatalogues(env, fetchImpl) {
  const primary = httpUrl(env.INSTABLE_API_URL || 'https://instable.arcod.xyz');
  const secondary = httpUrl(env.MONOCHROME_API_URL || 'https://tracks.monochrome.st');
  const get = (url, signal) => requestJson(url, { signal, fetchImpl });

  const instable = {
    async search(query, signal) {
      const url = endpoint(primary, 'api/get-music', { q: query, offset: 0, source: 'qobuz' });
      const data = await get(url, signal);
      const items = data?.data?.tracks?.items;
      if (!Array.isArray(items) || data.success === false) throw new AddonError(502, 'Instable search is unavailable.');
      return items.slice(0, 60).filter(t => t && t.streamable !== false && t.previewOnly !== true).map(t => {
        const title = string(t.title);
        const version = string(t.version);
        const withVersion = version && !(' ' + normalized(title) + ' ').includes(' ' + normalized(version) + ' ');
        return { source: 'instable', key: trackKey(t.id), title: withVersion ? title + ' (' + version + ')' : title,
          artist: string(t.performer?.name), album: string(t.album?.title), duration: Number(t.duration),
          isrc: recordingCode(t.isrc), artworkURL: artwork(t.album?.image?.large || t.album?.image?.small) };
      });
    },
    async mediaUrl(track, signal) {
      for (const quality of ['27', '6']) {
        const url = endpoint(primary, 'api/player/stream/' + track.key, { quality });
        let data;
        try { data = await get(url, signal); }
        catch (error) {
          if (quality === '27' && error.status === 404) continue;
          throw error;
        }
        if (data?.trackId != null && String(data.trackId) !== track.key) throw new AddonError(422, 'Instable returned a different recording.');
        if (data?.encrypted || data?.drm || data?.sample || data?.preview || data?.isPreview) throw new AddonError(422, 'Instable returned a restricted rendition or preview.');
        if (data?.success !== false && typeof data?.url === 'string' && data.url) return httpUrl(data.url).href;
      }
      throw new AddonError(404, 'Instable has no playable lossless stream for this track.');
    },
  };
  const monochrome = {
    async search(query, signal) {
      const data = await get(endpoint(secondary, 'search', { q: query }), signal);
      if (!Array.isArray(data?.tracks)) throw new AddonError(502, 'Monochrome search is unavailable.');
      const albums = new Map((Array.isArray(data.releases) ? data.releases : []).filter(Boolean).map(r => [trackKey(r.id || r.releaseId), string(r.title)]));
      return data.tracks.slice(0, 60).filter(t => t && t.playable !== false && !t.isPreview && !t.previewOnly).map(t => ({
        source: 'monochrome', key: trackKey(t.trackId ?? t.id), title: string(t.title),
        artist: Array.isArray(t.artistNames) ? t.artistNames.map(string).filter(Boolean).join(', ') : '',
        album: string(t.album?.title) || albums.get(trackKey(t.releaseId)) || '', duration: Number(t.duration) / 1000,
        isrc: recordingCode(t.isrc), artworkURL: artwork(t.artwork),
      }));
    },
    mediaUrl(track) { return endpoint(secondary, 'track/' + track.key).href; },
  };
  return { instable, monochrome };
}

module.exports = { createCatalogues };
