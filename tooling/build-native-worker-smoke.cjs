'use strict';
// Emits only the CPU fixture and its actual production Worker dependency to an
// isolated runtime folder. Does not package, install or launch any application.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'apps', 'desktop');
(async () => {
  const { build } = await import('vite');
  await build({
    root: desktop,
    configFile: path.join(desktop, 'vite.config.ts'),
    build: {
      outDir: path.join(root, 'runtime', 'native-worker-sink-smoke', 'build'),
      emptyOutDir: false,
      rollupOptions: { input: path.join(desktop, 'tests', 'ui', 'native-worker-sink.html') },
    },
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
