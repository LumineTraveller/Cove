// Run with the desktop package's Electron executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

assert.ok(process.versions.electron, 'Run this check with Electron.');

const temporaryArtifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-window-minimum-'));
app.setPath('userData', path.join(temporaryArtifacts, 'user-data'));

const mainSource = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const optionsMatch = mainSource.match(
  /function createWindow\(\)\s*\{\s*const win = new BrowserWindow\(\{([\s\S]*?)\n\s*\}\);/,
);
assert.ok(optionsMatch, 'Could not find the main BrowserWindow options in electron/main.ts.');

function readNumber(name) {
  const match = optionsMatch[1].match(new RegExp(`\\b${name}\\s*:\\s*(\\d+)\\b`));
  assert.ok(match, `Could not find ${name} in the main BrowserWindow options.`);
  return Number(match[1]);
}

const frameMatch = optionsMatch[1].match(/\bframe\s*:\s*(true|false)\b/);
assert.ok(frameMatch, 'Could not find frame in the main BrowserWindow options.');
assert.equal(frameMatch[1], 'false', 'The tested window must match the frameless main window.');

const configured = {
  width: readNumber('width'),
  height: readNumber('height'),
  minWidth: readNumber('minWidth'),
  minHeight: readNumber('minHeight'),
};
assert.ok(configured.minWidth >= 1100, `Expected a minimum width of at least 1100px; got ${configured.minWidth}px.`);
assert.ok(configured.minHeight >= 600, `Expected the 600px minimum height to remain; got ${configured.minHeight}px.`);

app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({
      ...configured,
      minWidth: configured.minWidth,
      minHeight: configured.minHeight,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setSize(900, 600);
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = {
      passed: true,
      configured,
      requestedSize: { width: 900, height: 600 },
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      temporaryArtifacts,
    };
    assert.ok(result.bounds.width >= configured.minWidth,
      `Native window width ${result.bounds.width}px is below minWidth ${configured.minWidth}px.`);
    assert.ok(result.bounds.height >= configured.minHeight,
      `Native window height ${result.bounds.height}px is below minHeight ${configured.minHeight}px.`);

    fs.writeFileSync(path.join(temporaryArtifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    win.destroy();
    app.exit(0);
  } catch (error) {
    const result = { passed: false, error: error.stack || String(error), temporaryArtifacts };
    fs.writeFileSync(path.join(temporaryArtifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result, null, 2));
    win?.destroy();
    app.exit(1);
  }
});
