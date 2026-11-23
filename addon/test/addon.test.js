'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createSource } = require('../source');
const { createServer } = require('../server');
const { diagnose } = require('../doctor');

const monoId = '159085459229286400';
const track = { id: 210, title: 'Single', performer: { name: 'Group' }, album: { title: 'Debut' }, isrc: 'USYYY2345678', duration: 168 };
const backup = { trackId: monoId, title: 'Single', artistNames: ['Group'], releaseId: '910000000000000123', duration: 168136, isrc: track.isrc };

function flac({ seconds = 168.136, tags = {} } = {}) {
  const b = Buffer.alloc(42);
  b.write('fLaC'); b[7] = 34;
  b.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (23n << 36n) | BigInt(Math.round(seconds * 48000)), 18);
  const entries = Object.entries(tags).map(([key, value]) => Buffer.from(key + '=' + value));
  const count = Buffer.alloc(8);
  count.writeUInt32LE(entries.length, 4);
  const body = [count];
  for (const value of entries) {
    const len = Buffer.alloc(4); len.writeUInt32LE(value.length);
    body.push(len, value);
  }
  const comments = Buffer.concat(body), block = Buffer.alloc(4);
  block[0] = 132; block.writeUIntBE(comments.length, 1, 3);
  return Buffer.concat([b, block, comments]);
}

function fixture(opts = {}) {
  const calls = [];
  const searchResult = { success: true, data: { tracks: { items: opts.primaryRows ?? [track] } } };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const route = url.pathname;
    calls.push(url.hostname + route);
    if (route === '/api/get-music') {
      assert.equal(url.searchParams.get('source'), 'qobuz');
      return opts.primaryError ? new Response(null, { status: opts.primaryError, headers: { 'Retry-After': '30' } }) : Response.json(searchResult);
    }
    if (route.startsWith('/api/player/stream/')) {
      if (opts.primaryMissing || (opts.cdOnly && url.searchParams.get('quality') !== '6')) return Response.json({ success: false });
      return Response.json({ trackId: opts.wrongId ? 999 : 210, url: 'https://audio.test/file' });
    }
    if (route === '/search') return Response.json({ tracks: opts.secondarySearch?.(url.searchParams.get('q')) ?? opts.secondaryRows ?? [backup],
      releases: [{ id: backup.releaseId, title: 'Debut' }] });
    if (url.hostname === 'audio.test' || route === '/track/' + monoId) {
      assert.equal(init.headers.Range, 'bytes=0-65535');
      return new Response(url.hostname === 'audio.test' ? (opts.primaryAudio ?? flac()) : (opts.secondaryAudio ?? flac()), { status: 206 });
    }
    throw Error('Unexpected URL');
  };
  return { source: createSource({ env: {}, fetchImpl }), calls };
}

test('one private PureBits manifest resolves through Instable, including after restart', async t => {
  const { source, calls } = fixture();
  const server = createServer({ env: { ADDON_ACCESS_KEY: 'k' }, source });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/manifest.json')).status, 401);
  const manifest = await (await fetch(origin + '/a/k/')).json();
  assert.deepEqual(manifest.resources, ['search', 'stream']);
  assert.equal((await fetch(origin + '/a/k/archive/manifest.json')).status, 404);
  assert.equal((await fetch(origin + '/a/k/stream/bad')).status, 400);
  const result = await diagnose({ origin, key: 'k', query: 'Single Group' });
  assert.deepEqual(result, { title: 'Single', artist: 'Group', album: 'Debut', source: 'instable', codec: 'flac', bitDepth: 24, sampleRate: 48000, duration: 168.136 });
  const [row] = await source.search('Single');
  assert.equal((await fixture().source.stream(row.id)).source, 'instable');
  assert.ok(!calls.some(route => route.includes('monochrome')));
});

test('empty primary results fall back, keeping 18-digit track IDs intact', async () => {
  const { source, calls } = fixture({ primaryRows: [] });
  const [row] = await source.search('Single Group');
  assert.equal(row.duration, 168.136);
  assert.equal((await source.stream(row.id)).source, 'monochrome');
  assert.deepEqual(calls, ['instable.arcod.xyz/api/get-music', 'tracks.monochrome.st/search', 'tracks.monochrome.st/track/' + monoId]);
});

test('a related version on Instable does not hide an exact Monochrome match', async () => {
  const { source } = fixture({ primaryRows: [{ ...track, version: 'Instrumental' }] });
  const [first, related] = await source.search('Group Single');
  assert.equal(first.title, 'Single'); assert.equal(related.title, 'Single (Instrumental)');
  assert.equal((await source.stream(first.id)).source, 'monochrome');
});

test('Instable CD quality is tried before switching providers', async () => {
  const { source, calls } = fixture({ cdOnly: true });
  const [t] = await source.search('Single');
  assert.equal((await source.stream(t.id)).source, 'instable');
  assert.equal(calls.filter(x => x.includes('/player/stream')).length, 2);
  assert.ok(!calls.some(x => x.includes('monochrome')));
});

for (const scenario of [
  ['missing URL', { primaryMissing: true }],
  ['wrong provider track ID', { wrongId: true }],
  ['lossy bytes', { primaryAudio: Buffer.from('ID3') }],
  ['preview', { primaryAudio: flac({ seconds: 30 }) }],
]) {
  test('stream falls back to same recording on ' + scenario[0], async () => {
    const { source } = fixture(scenario[1]);
    const [row] = await source.search('Single');
    assert.equal((await source.stream(row.id)).source, 'monochrome');
  });
}

test('fallback refuses different recording codes, releases, artists and versions', async () => {
  for (const change of [{ isrc: 'USYYY2345679' }, { artistNames: ['Other'] }, { title: 'Single (Live)' }, { album: { title: 'Reissue' } }, { duration: 170000 }]) {
    const { source, calls } = fixture({ primaryMissing: true, secondaryRows: [{ ...backup, ...change }] });
    const [row] = await source.search('Single');
    await assert.rejects(source.stream(row.id), e => e.status === 404);
    assert.ok(!calls.some(route => route.includes('/track/')));
  }
});

test('Monochrome media with wrong duration or embedded album is rejected despite catalogue match', async () => {
  for (const info of [{ seconds: 169.640 }, { tags: { ALBUM: 'Different Release' } }]) {
    const { source } = fixture({ primaryMissing: true, secondaryAudio: flac(info) });
    const [row] = await source.search('Single');
    await assert.rejects(source.stream(row.id), e => e.status === 422);
  }
});

test('Instable rate limit allows a backup search and suppresses repeat upstream requests', async () => {
  const { source, calls } = fixture({ primaryError: 429 });
  await source.search('Single'); await source.search('Group');
  assert.equal(calls.filter(x => x.includes('api/get-music')).length, 1);
  assert.equal(calls.filter(x => x.includes('monochrome')).length, 2);
});

test('a common title can require an artist-specific backup lookup', async () => {
  const { source } = fixture({ primaryMissing: true, secondarySearch: q => q === 'Single Group' ? [backup] : [] });
  const [row] = await source.search('Single Group');
  assert.equal((await source.stream(row.id)).source, 'monochrome');
});

test('caller cancellation does not launch another provider lookup', async () => {
  const controller = new AbortController();
  let requests = 0;
  const source = createSource({ env: {}, fetchImpl: async () => {
    requests++; controller.abort(); throw Error('cancelled');
  } });
  await assert.rejects(source.search('Single Group', { signal: controller.signal }));
  assert.equal(requests, 1);
});

test('two empty catalogues return zero tracks and malformed IDs never reach upstream', async () => {
  const { source, calls } = fixture({ primaryRows: [], secondaryRows: [] });
  assert.deepEqual(await source.search('Single'), []);
  const length = calls.length;
  await assert.rejects(source.stream('v1.not-a-track'), e => e.status === 400);
  assert.equal(calls.length, length);
});
