'use strict';
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const key of Object.keys(process.env)) {
  if (/^(COVE_|VITE_|MEDIASOUP_)/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key))
    delete process.env[key];
}
// Keep the qualified capture assets and dependency provenance of the frozen
// performance candidate. This entry only changes the profile and dev port.
const check = spawnSync(process.execPath, [path.join(__dirname, 'start-last-round-candidate.cjs'), '--check'],
  {cwd: root, stdio: 'inherit', windowsHide: true});
if (check.status !== 0) process.exit(check.status ?? 1);
Object.assign(process.env, {
  COVE_DESKTOP_DATA_DIR: path.join(root, 'runtime', 'desktop-client-settings-20261031'),
  COVE_VITE_CACHE_DIR: path.join(root, 'runtime', 'vite-client-settings-20261031'),
  COVE_DEV_RENDERER_PORT: '55180',
  COVE_DEV_RENDERER_URL: 'http://127.0.0.1:55180',
  VITE_SERVER_URL: 'http://127.0.0.1:3301',
  VITE_COVE_DEFAULT_SERVER: 'http://127.0.0.1:3301',
  COVE_NATIVE_GPU_CAPTURE: '1',
  COVE_NATIVE_GPU_CAPTURE_PIXEL_FORMAT: 'bgra',
  COVE_NATIVE_GPU_CAPTURE_CPU_FRAMES: '0',
  COVE_NATIVE_FRAME_SINK: 'generator',
});
process.chdir(root);
console.log('Cove client-settings candidate: isolated profile; client only; port 55180.');
process.argv = [process.execPath, path.join(__dirname, 'dev.cjs'), '--client', '--electron'];
require('./dev.cjs');
