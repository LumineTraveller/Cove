import { app, BrowserWindow, Notification, dialog, type MessageBoxOptions } from 'electron';
import electronUpdater from 'electron-updater';
import fs from 'fs';
import path from 'path';
import { configureAutoUpdater, type AutoUpdaterController, type LoggerLike } from './updater-core';

const { autoUpdater } = electronUpdater;

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

async function promptInstall(version: string): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'info',
    title: 'Cove 更新已准备好',
    message: `Cove ${version} 已下载完成`,
    detail: '立即重启即可完成更新。选择“稍后”时，Cove 会在正常退出后自动安装。',
    buttons: ['立即重启更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const win = getMainWindow();
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

export function startAutoUpdater(isPackaged: boolean): AutoUpdaterController {
  return configureAutoUpdater({
    updater: autoUpdater,
    isPackaged,
    getWindow: getMainWindow,
    notify,
    promptInstall,
    logger: createLogger(),
  });
}
