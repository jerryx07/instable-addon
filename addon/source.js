'use strict';

const { AddonError } = require('./errors');
const { createCatalogues } = require('./providers/catalogues');
const { probeAudio } = require('./media');
const { encode, decode, sameRecording, queryMatch, normalized } = require('./recording');

function createSource({ env = process.env, fetchImpl = fetch } = {}) {
  const catalogues = createCatalogues(env, fetchImpl);
  const cooldown = new Map();

  async function attempt(source, timeoutMs, parent, work) {
    parent?.throwIfAborted();
    const remaining = (cooldown.get(source) || 0) - Date.now();
    if (remaining > 0) throw new AddonError(429, source + ' is rate limited.', { 'Retry-After': String(Math.ceil(remaining / 1000)) });
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    try {
      const result = await work(catalogues[source], signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw new AddonError(504, source + ' lookup timed out.');
      if (error.status === 429) {
        const value = error.headers?.['Retry-After'];
        const delay = /^\d+$/.test(value || '') ? Number(value) * 1000 : Date.parse(value) - Date.now();
        cooldown.set(source, Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 60000));
      }
      throw error;
    }
  }

  async function searchIn(source, query, signal) {
    const tracks = await attempt(source, 4500, signal, (cat, budget) => cat.search(query, budget));
    return tracks.map(t => ({ ...t, id: encode(t) })).filter(t => t.id);
  }

  async function resolve(track, signal, expected = track) {
    return attempt(track.source, track.source === 'instable' ? 6000 : 7500, signal, async (cat, budget) => {
      const url = await cat.mediaUrl(track, budget);
      const audio = await probeAudio(url, expected, { signal: budget, fetchImpl });
      return { ...audio, source: track.source };
    });
  }

  async function search(query, { signal } = {}) {
    if (!normalized(query)) return [];
    let primary = [], secondary = [], primaryError;
    try { primary = await searchIn('instable', query, signal); }
    catch (error) { primaryError = error; }
    const exact = t => queryMatch(query, t);
    // Related suggestions alone do not establish that the requested song was found.
    if (!primary.some(exact)) {
      try { secondary = await searchIn('monochrome', query, signal); }
      catch (error) { if (!primary.length) throw primaryError || error; }
    }
    signal?.throwIfAborted();
    if (primaryError && !secondary.length) throw primaryError;
    const result = [];
    for (const t of [...primary.filter(exact), ...secondary.filter(exact), ...primary.filter(t => !exact(t)), ...secondary.filter(t => !exact(t))]) {
      if (result.some(row => row.id === t.id || (row.source !== t.source && sameRecording(t, row)))) continue;
      result.push(t);
      if (result.length === 20) break;
    }
    return result.map(({ id, title, artist, album, duration, artworkURL }) => ({ id, title, artist, album, duration, artworkURL }));
  }

  async function stream(id, { signal } = {}) {
    const track = decode(id);
    try { return await resolve(track, signal); }
    catch (primaryError) {
      if (track.source !== 'instable' || signal?.aborted) throw primaryError;
      let rows = await searchIn('monochrome', track.title, signal);
      let matches = rows.filter(row => sameRecording(track, row));
      if (!matches.length) {
        // Common titles can fill the first page with tracks by other artists.
        rows = await searchIn('monochrome', track.title + ' ' + track.artist, signal);
        matches = rows.filter(row => sameRecording(track, row));
      }
      matches.sort((a, b) => Number(Boolean(b.album)) - Number(Boolean(a.album)));
      let lastError = primaryError;
      for (const match of matches.slice(0, 2)) {
        try { return await resolve(match, signal, track); }
        catch (error) {
          if (![404, 422].includes(error.status) || signal?.aborted) throw error;
          lastError = error;
        }
      }
      throw lastError;
    }
  }
  return { search, stream };
}

module.exports = { createSource };
