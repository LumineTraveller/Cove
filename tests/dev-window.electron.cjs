const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {app} = require('electron');

const root = path.resolve(__dirname, '..');
process.env.COVE_DESKTOP_DATA_DIR = fs.mkdtempSync(path.join(root, 'runtime', 'dev-window-'));
const timeout = setTimeout(() => {
  console.error('FAIL: development window did not render within 30 seconds');
  app.exit(1);
}, 30000);
process.on('uncaughtException', error => {
  console.error(error);
  app.exit(1);
});
app.once('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rendered = await win.webContents.executeJavaScript('Boolean(document.querySelector("#login-email"))');
        if (rendered) {
          const state = {visible: win.isVisible(), minimized: win.isMinimized(), url: win.webContents.getURL()};
          console.log('DEV_WINDOW_STATE ' + JSON.stringify(state));
          assert.equal(state.visible, true, 'development main window must be visible');
          assert.equal(state.minimized, false, 'development main window must not be minimized');
          console.log('PASS: actual development main/preload/renderer opens a visible login window');
          clearTimeout(timeout);
          app.exit(0);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('development renderer loaded without the login form');
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
require('../apps/desktop/dist-electron/main.js');
