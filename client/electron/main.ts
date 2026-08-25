import { app, BrowserWindow, Menu, session, desktopCapturer } from 'electron';
import path from 'path';
import { startAutoUpdater } from './updater';

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  Menu.setApplicationMenu(null);

  // F12 / Ctrl+Shift+I 切换开发者工具（正式版也能用，方便排查音视频问题）
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const f12   = input.key === 'F12';
    const ctrlI = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
    if (f12 || ctrlI) win.webContents.toggleDevTools();
  });

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Retry until Vite dev server is ready
    win.webContents.on('did-fail-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed()) win.loadURL('http://localhost:5173');
      }, 1000);
    });
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 麦克风 / 摄像头权限：打包后 getUserMedia 默认会被挂起，必须显式放行，
  // 否则点"加入语音"会静默无反应（getUserMedia 永远不 resolve）。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    callback(allowed.includes(permission));
  });
  // 同步检查（某些 Chromium 路径走这个而非上面的异步 handler）
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission);
  });

  // Electron 不允许渲染进程直接调用 getDisplayMedia，必须在主进程注册处理函数
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      if (!sources.length) { callback({}); return; }
      // Chromium 的 audio:true 只表示“请求音频”；Electron 仍需在主进程显式
      // 提供 Windows loopback 音源，否则返回的屏幕流永远只有视频轨。
      callback({
        video: sources[0],
        ...(request.audioRequested && process.platform === 'win32'
          ? { audio: 'loopback' as const }
          : {}),
      });
    }).catch(() => callback({}));
  });
}

app.whenReady().then(() => {
  createWindow();
  startAutoUpdater(app.isPackaged);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
