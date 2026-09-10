// Run with the client's Electron executable while Vite is serving port 5173.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

fs.mkdirSync(path.resolve('output'), { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'connection-recovery-test' },
  });
  try {
    await win.loadURL('http://localhost:5173/tests/ui/connection-recovery.html');
    const result = await win.webContents.executeJavaScript(`Promise.race([
      window.connectionRecoveryResult,
      new Promise((_, reject) => setTimeout(() => reject(new Error('UI regression timed out')), 20000))
    ])`);
    if (!result) throw new Error('Regression fixture was not loaded');
    fs.writeFileSync(path.resolve('output/connection-recovery-result.json'), JSON.stringify(result, null, 2));
    app.exit(result.passed ? 0 : 1);
  } catch (error) {
    fs.writeFileSync(path.resolve('output/connection-recovery-result.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  }
});
