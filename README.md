# Instable + Monochrome

One PureBits HTTP addon. Instable searches the Qobuz catalogue and resolves playback first. Monochrome supplies the fallback. Both services run upstream of this addon and their availability can change.

## Run with npm

From the repository root, use Node.js 22.9 or newer. The server has zero npm dependencies.

```powershell
npm start
```

## Run with Docker

```powershell
docker compose up -d --build
```

Both methods serve the addon on port 8787. For optional settings copy `.env.example` to `.env`. Set `PORT` to select another local port.

## Add to PureBits

Point your existing Cloudflare Tunnel at `http://localhost:8787`. For a temporary tunnel on the same host, run:

```powershell
cloudflared tunnel --url http://localhost:8787
```

In **Settings → Sources**, remove the previous SoundAddon entry and add **one** source:

```text
https://YOUR-TUNNEL-HOST/manifest.json
```

With `ADDON_ACCESS_KEY` set, use `https://YOUR-TUNNEL-HOST/a/YOUR-URL-ENCODED-KEY/manifest.json`. Search and stream run under that same prefix. Downloads are disabled by default.

## Source order and verification

- A matching Instable search result takes priority. If the search fails, returns no results, or offers only related recordings, the addon searches Monochrome. Exact matches appear ahead of related suggestions.
- If the selected Instable stream is missing, times out, or fails audio verification, the addon searches Monochrome for that recording. Title, artist, version, duration and available release identifiers must agree. Streams resolve to direct media URLs and both providers honor rate-limit cooldowns.
- Playback requires native FLAC. The addon reads up to 64 KiB, obtains sample rate, bit depth and duration from STREAMINFO, rejects duration differences over one second and checks identity tags when present. A different release or preview can therefore produce a miss. FLAC encoding alone cannot establish the provenance of a master.
- The root and `/manifest.json` serve the manifest. `/search?q=…` returns track rows and `/stream/{id}` returns playback JSON. `/health` reports whether the local server is running.

## Check playback resolution

While the addon is running, use a second terminal:

```powershell
npm run doctor -- "Bling-Bang-Bang-Born Creepy Nuts"
npm test
```

The diagnostic reports the provider that supplied the audio and the measured format. Test playback on your phone to verify the complete route through your tunnel.
