import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  configureAutoUpdater,
  type AutoUpdaterController,
  type LoggerLike,
  type UpdateState,
} from './updater-core';
import { discoverUpdateSources } from './update-sources';
import { createGiteeInstallerCache } from './gitee-installer-cache';

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

export async function openUpdaterLog(): Promise<boolean> {
  const logPath = path.join(app.getPath('userData'), 'updater.log');
  if (!fs.existsSync(logPath)) return false;
  return (await shell.openPath(logPath)) === '';
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
  const logger = createLogger();
  let installerCache: ReturnType<typeof createGiteeInstallerCache> | undefined;
  if (isPackaged && process.platform === 'win32') {
    try {
      installerCache = createGiteeInstallerCache({
        localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        installedVersion: app.getVersion(),
        logger,
      });
    } catch (error) { logger.warn('[updater] 无法初始化安装包清理，保留缓存', error); }
  }
  const cleanup = installerCache?.cleanupInstalledUpdate() ?? Promise.resolve();
  return configureAutoUpdater({
    updater: autoUpdater,
    isPackaged,
    getWindow: getMainWindow,
    publishState,
    logger,
    // Serialize startup cleanup with ALL checks (including a manual check) so a
    // cleanup cannot race this process's next download into the same directory.
    resolveSources: async () => { await cleanup; return discoverUpdateSources(); },
    onInstallerReady: (info, source) => installerCache?.remember(info, source),
  });
}
