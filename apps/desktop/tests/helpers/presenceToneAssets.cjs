'use strict';

// This Node-only UI fixture needs Vite's URL imports, not audio decoding.
// Keep the production modules and codec logic intact and scope the shim to
// the two local cue resources; each Node test file runs in its own process.
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

for (const name of ['join', 'leave']) {
  // tsx includes its normalized query in the cache key (e.g. .wav?url=).
  const filename = require.resolve(`../../src/features/media/audio/assets/voice-${name}.wav?url`);
  const asset = new Module(filename, module);
  asset.filename = filename;
  asset.loaded = true;
  asset.exports = pathToFileURL(filename.split('?')[0]).href;
  require.cache[filename] = asset;
}
