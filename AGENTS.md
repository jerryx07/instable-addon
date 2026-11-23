# SoundAddon

Maintain one standalone PureBits addon with Instable as the primary source and Monochrome as the fallback. Preserve this priority for search and playback. A related result, a gated response or a preview cannot stand in for the requested release.

Keep provider IDs lossless, including Monochrome's long decimal strings. Search IDs must survive server restarts. Use bounded probes of actual FLAC audio and respect upstream cooldowns. Keep credentials and signed media URLs out of logs.

The PureBits reference client is at D:\web application\PureBits. Check its addon models, matching and HTTP contract before compatibility changes. Run npm test from the repo root. npm start and Docker must expose the same server, including private paths and the root manifest.
