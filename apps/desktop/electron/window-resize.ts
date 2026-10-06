import type { BrowserWindow } from 'electron';

/** Notify once per native drag, before the renderer's viewport resize event.
 * Do not intercept sizing, poll bounds, change GPU flags, or block on a paint.
 */
export function installNativeResizeState(win: BrowserWindow, platform = process.platform): void {
  if (platform !== 'win32') return;
  let active = false;
  const update = (next: boolean) => {
    if (active === next || win.isDestroyed()) return;
    active = next;
    win.webContents.send('cove:window-resizing', active);
  };
  win.on('will-resize', () => update(true));
  win.on('resized', () => update(false));
  // Also covers an interrupted / Esc-cancelled native drag. Electron owns and
  // removes the hook with the window; never unhook other Windows messages.
  win.hookWindowMessage(0x0232 /* WM_EXITSIZEMOVE */, () => update(false));
  win.webContents.on('did-finish-load', () => {
    if (active && !win.isDestroyed()) win.webContents.send('cove:window-resizing', true);
  });
}
