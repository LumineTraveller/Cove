// Build the real room fixture for file:// Electron QA. No dev server is needed.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('vite');
const root = path.resolve(process.env.COVE_UI_QA_SOURCE || path.join(__dirname, '../..'));
const outDir = path.resolve(process.env.COVE_UI_QA_BUILD || path.join(__dirname, '../../../tmp/share-entry-fixture'));
process.chdir(root);
build({ root, configFile: path.join(root, 'vite.config.ts'), build: {
  outDir, emptyOutDir: true,
  rollupOptions: { input: path.join(root, 'tests/ui/share-chat-qa.html') },
}}).then(() => {
  // The production logo is relative to index.html; this fixture is nested.
  const assets = path.join(outDir, 'tests/ui/assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(path.join(root, 'public/assets/cove-icon.png'), path.join(assets, 'cove-icon.png'));
  console.log('QA fixture:', path.join(outDir, 'tests/ui/share-chat-qa.html'));
}).catch(error => { console.error(error); process.exitCode = 1; });
