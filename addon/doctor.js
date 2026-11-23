'use strict';

async function diagnose({ origin = 'http://127.0.0.1:' + (process.env.PORT || 8787),
  key = process.env.ADDON_ACCESS_KEY, query = 'Bling-Bang-Bang-Born Creepy Nuts' } = {}) {
  const base = new URL(key ? '/a/' + encodeURIComponent(key) + '/' : '/', origin);
  async function json(route) {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(16000) });
    if (!response.ok) throw Error(route.split(/[/?]/)[0] + ' returned HTTP ' + response.status);
    return response.json();
  }
  const info = await json('manifest.json');
  if (!info.resources?.includes('stream')) throw Error('Missing stream capability.');
  const { tracks } = await json('search?' + new URLSearchParams({ q: query, quality: 'LOSSLESS' }));
  if (!tracks?.length) throw Error('No matches.');
  const track = tracks[0];
  const media = await json('stream/' + encodeURIComponent(track.id) + '?quality=LOSSLESS');
  if (media.codec !== 'flac' || media.encrypted !== false || !media.url) throw Error('Expected a verified FLAC stream.');
  return { artist: track.artist, title: track.title, album: track.album, source: media.source,
    codec: media.codec, bitDepth: media.bitDepth, sampleRate: media.sampleRate, duration: media.duration };
}

if (require.main === module) {
  diagnose({ query: process.argv.slice(2).join(' ') || undefined })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error('Doctor failed. ' + error.message); process.exitCode = 1; });
}

module.exports = { diagnose };
