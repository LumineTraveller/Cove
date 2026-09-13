const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.dirname(require.resolve('@jitsi/rnnoise-wasm/package.json'));
const syncLoaderPath = path.join(packageRoot, 'dist', 'rnnoise-sync.js');
const syncLoader = fs.readFileSync(syncLoaderPath, 'utf8');
const inlineWasm = syncLoader.match(
  /wasmBinaryFile = "data:application\/octet-stream;base64,([^"]+)";/,
);
if (!inlineWasm) throw new Error('Could not find the RNNoise 0.2 inline WASM payload');

const loader = syncLoader
  .replace(inlineWasm[0], 'wasmBinaryFile = "rnnoise-v2.wasm";')
  .replace('export default createRNNWasmModuleSync;', '');
const outputDir = path.join(__dirname, '..', 'src');
fs.writeFileSync(path.join(outputDir, 'rnnoiseWasmLoader.js'), `${loader.trim()}\n`);
fs.writeFileSync(path.join(outputDir, 'rnnoise-v2.wasm'), Buffer.from(inlineWasm[1], 'base64'));
