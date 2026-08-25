import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'fs';
import path from 'path';
import {
  configureAutoUpdater,
  type AutoUpdaterController,
  type LoggerLike,
  type UpdateState,
} from './updater-core';
import { discoverUpdateSources } from './update-sources';

function createLogger(): LoggerLike {
  const logPath = path.join(app.getPath('userData'), 'updater.log');
  const write = (level: string, message?: unknown, ...args: unknown[]) => {
    const values = [message, ...args].map(value => {
      if (value instanceof Error) return value.stack ?? value.message;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    });
    const line = `[${new Date().toISOString()}] [${level}] ${values.join(' ')}\n`;
    try { fs.appendFileSync(logPath, line); } catch { /* logging must never break the app */ }
  };
  return {
    info: (message, ...args) => { console.log(message, ...args); write('INFO', message, ...args); },
    warn: (message, ...args) => { console.warn(message, ...args); write('WARN', message, ...args); },
    error: (message, ...args) => { console.error(message, ...args); write('ERROR', message, ...args); },
  };
}

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find(win => !win.isDestroyed()) ?? null;
}

function publishState(state: UpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('cove:update:state', state);
  }
}

export function startAutoUpdater(isPackaged: boolean): AutoUpdaterController {
  return configureAutoUpdater({
    updater: autoUpdater,
    isPackaged,
    getWindow: getMainWindow,
    publishState,
    logger: createLogger(),
    resolveSources: discoverUpdateSources,
  });
}
