// Headless runner for element-volume-probe.html: measures real speaker output
// through Electron's system loopback capture.
const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const os = require("node:os");
const path = require("node:path");

app.setPath("userData", path.join(os.tmpdir(), "cove-element-volume-probe"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const timeout = setTimeout(() => {
  console.log(JSON.stringify({ fatal: "runner timeout" }));
  app.exit(1);
}, 150_000);

app.whenReady().then(async () => {
  // 绕过选择器，直接把整块屏幕 + 系统回环音频交给 getDisplayMedia。
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
    width: 900,
    height: 600,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const logs = [];
  win.webContents.on("console-message", (event) => {
    logs.push(String(typeof event === "object" && event !== null ? event.message : event).slice(0, 300));
  });
  let payload = null;
  try {
    await win.loadURL("http://[::1]:5173/tests/ui/element-volume-probe.html");
    for (let attempt = 0; attempt < 400; attempt += 1) {
      payload = await win.webContents
        .executeJavaScript("window.elementVolumeProbe?.done ? window.elementVolumeProbe : null")
        .catch(() => null);
      if (payload) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    payload = { fatal: String(error?.stack ?? error) };
  }
  console.log(JSON.stringify({ payload, logs: logs.slice(-20) }, null, 1));
  clearTimeout(timeout);
  app.exit(0);
});
