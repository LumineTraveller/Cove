// Headless Electron runner for the screen-audio receive-volume probe.
// Vite must serve this checkout on 55173 (npm run dev:app).
const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const os = require("node:os");
const path = require("node:path");

// Vite 只监听 ::1；userData 独立，避免与正在运行的开发实例争抢缓存。
const base = "http://127.0.0.1:55173/tests/ui/screen-audio-volume.html";
app.setPath("userData", path.join(os.tmpdir(), "cove-screen-audio-volume-probe"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const requested = process.argv.slice(2);
const variants = requested.length
  ? requested
  : ["", "?tap", "?late-audio", "?preseed=1.5"];

const timeout = setTimeout(() => {
  console.log(JSON.stringify({ fatal: "runner timeout" }));
  app.exit(1);
}, 240_000);

app.whenReady().then(async () => {
  // 把整块屏幕 + 系统回环音频交给 getDisplayMedia，用来录真实扬声器输出。
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => callback({ video: sources[0], audio: "loopback" }))
      .catch((error) => {
        console.error("capture source failed", error);
        callback(null);
      });
  });
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      // 不用 offscreen：OSR 窗口不渲染音频，测不到真实响度。
      backgroundThrottling: false,
      // 不设 partition：setDisplayMediaRequestHandler 只挂在 defaultSession 上
    },
  });
  const logs = [];
  win.webContents.setFrameRate(30);
  win.webContents.on("console-message", (event) => {
    const text = typeof event === "object" && event !== null ? event.message : String(event);
    const level = typeof event === "object" && event !== null ? event.level : 0;
    if (level >= 2 || /screen-preview|增强音量|audio\]/.test(String(text)))
      logs.push(String(text).slice(0, 300));
  });
  const results = [];
  try {
    for (const variant of variants) {
      logs.length = 0;
      await win.webContents.session.clearStorageData();
      await win.loadURL(`${base}${variant}`);
      const result = await win.webContents.executeJavaScript(
        "window.screenAudioVolumeResult",
      );
      results.push({ variant: variant || "(default)", result, logs: [...logs] });
    }
  } catch (error) {
    results.push({ fatal: String(error?.stack ?? error), logs: [...logs] });
  }
  console.log(JSON.stringify(results, null, 1));
  clearTimeout(timeout);
  app.exit(0);
});
