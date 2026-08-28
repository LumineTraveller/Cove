import { app, BrowserWindow, Menu, session, desktopCapturer, ipcMain, shell } from 'electron';
import path from 'path';
import { openUpdaterLog, startAutoUpdater } from './updater';
import type { AutoUpdaterController, UpdateState } from './updater-core';
import { normalizeExternalHttpUrl } from './external-links';
import { ServerCertificatePolicy } from './server-certificate-policy';
import {
  ApplicationAudioCaptureController,
  listApplicationAudioSources,
  type ApplicationAudioSource,
} from './application-audio';

// Electron 29 / Chromium 122 在 Windows 上默认关闭 WGC 屏幕捕获，回退到
// 较慢的 DXGI/GDI 抓屏路径。WGC 直接使用 Windows.Graphics.Capture 与
// D3D11 图形链路；不受支持时 WebRTC 会安全回退到默认捕获器。
// 该 Chromium Feature 必须在 app.whenReady() 之前启用。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'AllowWgcScreenCapturer');
}

const isDev = !app.isPackaged;
let updaterController: AutoUpdaterController | null = null;
let mainWindow: BrowserWindow | null = null;
const serverCertificatePolicy = new ServerCertificatePolicy();
const applicationAudioCapture = new ApplicationAudioCaptureController();
// The global Electron loopback source also captures Cove's own voice and
// sound-pack playback. Screen sharing uses a separate native process-loopback
// capture which excludes the Cove process tree.
const screenAudioCapture = new ApplicationAudioCaptureController('cove:screen-audio:chunk');

// A certificate exception is accepted only for the exact HTTPS origin chosen
// in Cove's server settings and only inside the main application window.
app.on('certificate-error', (event, webContents, url, _error, _certificate, callback) => {
  if (webContents === mainWindow?.webContents && serverCertificatePolicy.allows(url)) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

const unavailableUpdateState: UpdateState = {
  status: 'disabled',
  message: '更新服务尚未准备好。',
};

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
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
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
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Fullscreen API 也会经过权限回调；只允许 Cove 主窗口的顶层页面。
    if (permission === 'fullscreen') {
      callback(webContents === win.webContents && details.isMainFrame);
      return;
    }
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    callback(allowed.includes(permission));
  });
  // 同步检查（某些 Chromium 路径走这个而非上面的异步 handler）
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (permission === 'fullscreen') return webContents === win.webContents && details.isMainFrame;
    return ['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission);
  });

  // Electron 不允许渲染进程直接调用 getDisplayMedia，必须在主进程注册处理函数
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      if (!sources.length) { callback({}); return; }
      // Do not expose Electron's global `loopback` source here. It includes
      // Cove's own rendered voice/chat audio. The renderer starts a native
      // process-loopback capture with Cove excluded when system audio is
      // requested, and the display stream itself remains video-only.
      callback({ video: sources[0] });
    }).catch(() => callback({}));
  });
}

app.whenReady().then(() => {
  ipcMain.handle('cove:shell:open-external', async (_event, value: unknown) => {
    const url = normalizeExternalHttpUrl(value);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('cove:security:set-server-certificate-exception', (event, serverUrl: unknown, enabled: unknown) => {
    if (event.sender !== mainWindow?.webContents) return null;
    return serverCertificatePolicy.configure(serverUrl, enabled);
  });
  ipcMain.handle('cove:update:get-state', () => updaterController?.getState() ?? unavailableUpdateState);
  ipcMain.handle('cove:update:check', () => updaterController?.checkNow() ?? unavailableUpdateState);
  ipcMain.handle('cove:update:install', () => updaterController?.installNow() ?? false);
  ipcMain.handle('cove:update:open-log', (event) => {
    if (event.sender !== mainWindow?.webContents) return false;
    return openUpdaterLog();
  });
  ipcMain.handle('cove:application-audio:list', async (event) => {
    if (event.sender !== mainWindow?.webContents) return [];
    return listApplicationAudioSources();
  });
  ipcMain.handle('cove:application-audio:start', async (event, sourceId: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof sourceId !== 'string')
      return { ok: false, error: '无效的应用音频请求。' };
    try {
      const source = (await listApplicationAudioSources()).find(item => item.id === sourceId) as ApplicationAudioSource | undefined;
      if (!source) return { ok: false, error: '所选应用已关闭或无法捕获。请刷新列表后重试。' };
      applicationAudioCapture.start(event.sender, source);
      return { ok: true };
    } catch (error) {
      console.error('[application-audio] 启动失败', error);
      return { ok: false, error: error instanceof Error ? error.message : '无法启动应用音频捕获。' };
    }
  });
  ipcMain.handle('cove:application-audio:stop', (event) => {
    if (event.sender !== mainWindow?.webContents) return false;
    applicationAudioCapture.stop();
    return true;
  });
  ipcMain.handle('cove:screen-audio:start', (event) => {
    if (event.sender !== mainWindow?.webContents)
      return { ok: false, error: '无效的系统音频请求。' };
    try {
      // The main process is the root of the renderer/GPU/audio process tree.
      // The native process-loopback API's exclude mode therefore removes all
      // audio rendered by Cove while retaining other desktop applications.
      screenAudioCapture.startExcludingProcess(event.sender, process.pid);
      return { ok: true };
    } catch (error) {
      console.error('[screen-audio] 启动失败', error);
      return { ok: false, error: error instanceof Error ? error.message : '无法启动系统音频捕获。' };
    }
  });
  ipcMain.handle('cove:screen-audio:stop', (event) => {
    if (event.sender !== mainWindow?.webContents) return false;
    screenAudioCapture.stop();
    return true;
  });
  createWindow();
  updaterController = startAutoUpdater(app.isPackaged);
});

app.on('will-quit', () => {
  applicationAudioCapture.stop();
  screenAudioCapture.stop();
  updaterController?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
