// Offscreen Electron runner for sortable-qa.tsx. Vite must serve this checkout
// on port 5173. Verifies grid pointer drag (including same-row insertion),
// overlay stacking above the sound-pack popover, settle and keyboard moves.
const { app, BrowserWindow } = require('electron');

const APP_URL = process.env.SORTABLE_QA_URL || 'http://localhost:5173/tests/ui/sortable-qa.html';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'sortable-qa' },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level >= 2) errors.push(event.message);
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(APP_URL);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await run('Boolean(window.sortableQa)')) break;
      await delay(50);
    }

    const afterSameRow = await run("window.sortableQa.dragBetween('a', 'b', 'c')");
    if (afterSameRow.join('') !== 'bacd') throw new Error(`same-row insert produced ${afterSameRow.join('')}`);

    const lastDrag = await run('window.sortableQa.lastDrag');
    if (!lastDrag?.overlayVisible) throw new Error('drag overlay was not painted');
    if (!(lastDrag.zIndex > 520)) throw new Error(`drag overlay z-index ${lastDrag.zIndex} is below the sound-pack popover`);

    const afterDrag = await run("window.sortableQa.drag('a', 'd')");
    if (afterDrag.join('') !== 'bcad') throw new Error(`pointer drag produced ${afterDrag.join('')}`);

    const overlayLeft = await run("Boolean(document.getElementById('overlay'))");
    if (overlayLeft) throw new Error('drag overlay was not removed');
    const draggingAfterDrag = await run('window.sortableQa.dragging()');
    if (draggingAfterDrag !== null) throw new Error('dragging state was not cleared');

    const afterKeyboard = await run("window.sortableQa.keyboard('b', [' ', 'ArrowRight', ' '])");
    if (afterKeyboard.join('') !== 'cbad') throw new Error(`keyboard drag produced ${afterKeyboard.join('')}`);

    const status = await run("document.getElementById('status').textContent");
    if (!status.includes('已放下')) throw new Error(`missing live announcement: ${status}`);
    if (errors.length) throw new Error(`renderer errors: ${errors.join(' | ')}`);

    console.log('sortable-qa passed', JSON.stringify({ afterSameRow, afterDrag, afterKeyboard, zIndex: lastDrag.zIndex }));
    app.exit(0);
  } catch (error) {
    console.error('sortable-qa failed:', error instanceof Error ? error.message : error);
    app.exit(1);
  }
});
