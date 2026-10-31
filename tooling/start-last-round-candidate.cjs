'use strict';

// Local user-test entry: reuse the existing dev launcher, never start a server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const expected = {
  'native-screen-capture-helper.exe': '0e962dacb2cac5a0c9f594b2fe8491acaa3632831f991f0a545560f170205468',
  'native-screen-handles.node': '4530ec73e4a0010e12abc7134f8231e84185312554e7dbdaffba21dda7d57f91',
};
for (const [name, hash] of Object.entries(expected)) {
  const bytes = fs.readFileSync(path.join(root, 'apps/desktop/build', name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error(`Candidate native asset changed: ${name}`);
}
if (desktopRequire('electron/package.json').version !== '44.0.0')
  throw new Error('This candidate requires the existing Electron 44.0.0 runtime.');

// Dependencies are shared read-only on this machine. Reject stale workspace
// outputs rather than silently testing another checkout's implementation.
for (const name of ['contracts', 'client-core', 'media-core', 'diagnostics']) {
  const local = path.join(root, 'packages', name, 'dist');
  const linked = path.join(path.dirname(desktopRequire.resolve(`@cove/${name}/package.json`)), 'dist');
  function check(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const leaf = path.join(relative, entry.name);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) check(file, leaf);
      else if (!fs.readFileSync(file).equals(fs.readFileSync(path.join(linked, leaf))))
        throw new Error(`Candidate dependency output differs: @cove/${name}/${leaf}`);
    }
  }
  check(local);
}

if (process.argv.includes('--check')) {
  console.log('Candidate assets, Electron version and workspace dependency outputs match.');
} else {
  // Do not inherit experimental benchmark or externally injected Node settings.
  for (const key of Object.keys(process.env)) {
    if (/^(COVE_|VITE_|MEDIASOUP_)/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key))
      delete process.env[key];
  }
  Object.assign(process.env, {
    COVE_DESKTOP_DATA_DIR: path.join(root, 'runtime', 'desktop-last-round-20261031'),
    COVE_VITE_CACHE_DIR: path.join(root, 'runtime', 'vite-last-round-20261031'),
    COVE_DEV_RENDERER_PORT: '55179',
    COVE_DEV_RENDERER_URL: 'http://127.0.0.1:55179',
    VITE_SERVER_URL: 'http://127.0.0.1:3301',
    VITE_COVE_DEFAULT_SERVER: 'http://127.0.0.1:3301',
    COVE_NATIVE_GPU_CAPTURE: '1',
    COVE_NATIVE_GPU_CAPTURE_PIXEL_FORMAT: 'bgra',
    COVE_NATIVE_GPU_CAPTURE_CPU_FRAMES: '0',
    COVE_NATIVE_FRAME_SINK: 'generator',
  });
  process.chdir(root);
  console.log('Cove local performance candidate: isolated profile; client only; port 55179.');
  console.log('The first launch requires entering your server address in Cove. No server is started.');
  process.argv = [process.execPath, path.join(__dirname, 'dev.cjs'), '--client', '--electron'];
  require('./dev.cjs');
}
