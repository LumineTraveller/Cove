import { app, Tray, Menu, nativeImage, clipboard, shell } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { networkInterfaces } from 'os';

if (!app.requestSingleInstanceLock()) { app.quit(); }

app.setAppUserModelId('com.cove.server');
if (process.platform === 'darwin') app.dock?.hide();

let tray: Tray | null = null;
const HTTP_PORT = 3001;

// ── 日志文件 (~/.cove/server.log) ─────────────────────────────────────────────
// 打包后的 GUI 程序不会往控制台输出，必须写文件才能排查启动失败原因。
const LOG_PATH = path.join(os.homedir(), '.cove', 'server.log');

function setupLogging() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    // 每次启动清空旧日志，只保留本次运行
    fs.writeFileSync(LOG_PATH, `=== Cove Server 启动 ${new Date().toISOString()} ===\n`);
  } catch { /* ignore */ }

  const write = (level: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [${level}] ` +
      args.map(a => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
    try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a: unknown[]) => { write('INFO', a); origLog(...a); };
  console.warn = (...a: unknown[]) => { write('WARN', a); origWarn(...a); };
  console.error = (...a: unknown[]) => { write('ERROR', a); origErr(...a); };

  process.on('uncaughtException', (e) => write('UNCAUGHT', [e]));
  process.on('unhandledRejection', (e) => write('UNHANDLED', [e]));
}

function openLog() {
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '(暂无日志)\n');
  }
  shell.openPath(LOG_PATH);
}

// ── 配置文件 (~/.cove/server-config.json) ─────────────────────────────────────
// 控制 mediasoup 的公网 IP 和端口（SakuraFrp 远程访问时需要设置）
// 示例内容：
// {
//   "mediasoupIp": "114.51.4.19",
//   "mediasoupPort": 40000
// }

const CONFIG_PATH = path.join(os.homedir(), '.cove', 'server-config.json');

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (cfg.mediasoupIp)   process.env.MEDIASOUP_IP   = cfg.mediasoupIp;
    if (cfg.mediasoupPort) process.env.MEDIASOUP_PORT  = String(cfg.mediasoupPort);
  } catch (e) {
    console.warn('[config] 读取配置失败:', e);
  }
}

// 打包后 mediasoup 的 JS 在 app.asar 内，会把 worker 路径算到归档里（无法执行）。
// 必须显式指定解包后的 worker 二进制路径（带 .exe）。
function setupMediasoupWorker() {
  if (!app.isPackaged) return; // 开发模式 mediasoup 自己能找到
  const exe = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
  const bin = path.join(
    process.resourcesPath, 'app.asar.unpacked',
    'node_modules', 'mediasoup', 'worker', 'out', 'Release', exe,
  );
  if (fs.existsSync(bin)) {
    process.env.MEDIASOUP_WORKER_BIN = bin;
    console.log('[mediasoup] worker bin =', bin);
  } else {
    console.error('[mediasoup] 找不到 worker 二进制:', bin);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function makePng(r: number, g: number, b: number): Buffer {
  const size = 16;
  const crc32 = (buf: Buffer) => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'ascii');
    const crc = crc32(Buffer.concat([t, data]));
    const out = Buffer.alloc(4 + 4 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc, 8 + data.length);
    return out;
  };
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const imgData = Buffer.concat(Array.from({ length: size }, () => row));
  const compressed = require('zlib').deflateSync(imgData);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeTrayIcon(running: boolean): Electron.NativeImage {
  const [r, g, b] = running ? [34, 197, 94] : [239, 68, 68];
  return nativeImage.createFromBuffer(makePng(r, g, b));
}

function buildMenu(localIP: string): Electron.Menu {
  const msIp   = process.env.MEDIASOUP_IP   ?? '127.0.0.1';
  const msPort = process.env.MEDIASOUP_PORT ?? '40000';
  const isLocal = msIp === '127.0.0.1';

  return Menu.buildFromTemplate([
    { label: 'Cove 服务器', enabled: false },
    { label: '状态：运行中 ✓', enabled: false },
    { type: 'separator' },

    { label: `HTTP：${localIP}:${HTTP_PORT}`, enabled: false },
    {
      label: '复制局域网地址',
      click: () => clipboard.writeText(`http://${localIP}:${HTTP_PORT}`),
    },

    { type: 'separator' },
    { label: `WebRTC：${msIp}:${msPort}${isLocal ? '（仅本机）' : ''}`, enabled: false },
    {
      label: isLocal
        ? '⚠ 远程访问需配置 server-config.json'
        : '✓ 已配置远程 WebRTC 地址',
      enabled: false,
    },

    { type: 'separator' },
    {
      label: '打开数据目录',
      click: () => shell.openPath(path.join(os.homedir(), '.cove')),
    },
    { label: '查看日志', click: () => openLog() },
    {
      label: '编辑配置文件',
      click: () => {
        // 确保配置文件存在
        if (!fs.existsSync(CONFIG_PATH)) {
          fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
          fs.writeFileSync(CONFIG_PATH, JSON.stringify({
            mediasoupIp: '127.0.0.1',
            mediasoupPort: 40000,
          }, null, 2));
        }
        shell.openPath(CONFIG_PATH);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupLogging(); // 必须最先调用，确保后续所有输出都进日志文件
  try {
    readConfig(); // 读取 mediasoup 配置（必须在 startServer 之前）
    setupMediasoupWorker(); // 指定 mediasoup worker 二进制路径（打包后必须）

    const serverPath = app.isPackaged
      ? path.join(__dirname, '../dist/index.js')
      : path.join(__dirname, '../src/index');

    const { startServer } = require(serverPath);
    await startServer(HTTP_PORT);

    const localIP = getLocalIP();
    tray = new Tray(makeTrayIcon(true));
    tray.setToolTip(`Cove 服务器 · ${localIP}:${HTTP_PORT}`);
    tray.setContextMenu(buildMenu(localIP));
    tray.on('click', () => tray?.popUpContextMenu());

    console.log(`[server] http://${localIP}:${HTTP_PORT}`);
    console.log(`[mediasoup] ${process.env.MEDIASOUP_IP ?? '127.0.0.1'}:${process.env.MEDIASOUP_PORT ?? '40000'}`);
  } catch (err) {
    console.error('[server] 启动失败:', err);
    tray = new Tray(makeTrayIcon(false));
    tray.setToolTip('Cove 服务器 · 启动失败');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '状态：启动失败 ✗', enabled: false },
      { type: 'separator' },
      { label: '查看日志', click: () => openLog() },
      { label: '打开数据目录', click: () => shell.openPath(path.join(os.homedir(), '.cove')) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  }
});

app.on('window-all-closed', () => { /* 保持后台运行 */ });
