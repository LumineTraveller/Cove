// Hidden/offscreen Electron runner for share-chat-qa.tsx. Vite must serve this
// checkout on port 5173. The runner owns all screenshots and native hit-tests.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const artifacts = path.resolve(__dirname, "../../..", "tmp/share-chat-qa");
fs.mkdirSync(artifacts, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 90_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      partition: "share-chat-qa-isolated",
    },
  });
  win.webContents.setFrameRate(30);
  win.webContents.on("console-message", (event) => {
    if (event.level >= 2) console.error("renderer:", event.message);
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (await predicate()) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const capture = async (name) => {
    fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadURL("http://127.0.0.1:5173/tests/ui/share-chat-qa.html");
    await waitFor(() => js("Boolean(window.shareChatQaResult)"), "fixture result");
    // Keep screenshots after the fixture has completed its interactions. The
    // page remains on remote-watch with the chat expanded for visual QA.
    await waitFor(() => js("document.querySelector('.mode-watching') && document.querySelector('.chat-panel')"), "remote-watch chat");

    const widths = [1200, 760, 480];
    for (const width of widths) {
      win.setContentSize(width, 900);
      await delay(260);
      await capture(`dark-${width}-expanded`);
      const before = await js("window.shareChatQa.getSnapshot()");
      const toggle = await js("window.shareChatQa.getSnapshot().toggleRect");
      if (!toggle) throw new Error(`Missing shared-chat toggle at width ${width}`);
      const hit = await js(`(() => { const e=document.querySelector('[data-testid="share-chat-toggle"], [aria-label*="聊天"], .share-chat-toggle, .strip-chat-button'); if(!e) return false; const r=e.getBoundingClientRect(); const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return e.contains(h); })()`);
      if (!hit) throw new Error(`Shared-chat toggle is obscured at width ${width}`);
      await js(`(() => { const e=document.querySelector('[data-testid="share-chat-toggle"], [aria-label*="聊天"], .share-chat-toggle, .strip-chat-button'); e.focus(); e.click(); })()`);
      await delay(130);
      const collapsed = await js("!document.querySelector('.chat-panel') || document.querySelector('.chat-panel').offsetParent === null");
      if (!collapsed) throw new Error(`Shared chat did not collapse at width ${width}`);
      await capture(`dark-${width}-collapsed`);
      await js(`(() => { const e=document.querySelector('[data-testid="share-chat-toggle"], [aria-label*="聊天"], .share-chat-toggle, .strip-chat-button'); if(!e) throw new Error('toggle missing after collapse'); e.click(); })()`);
      await waitFor(() => js("Boolean(document.querySelector('.chat-panel'))"), `expanded chat at width ${width}`);
      await delay(130);
      await capture(`dark-${width}-expanded-again`);
      const after = await js("window.shareChatQa.getSnapshot()");
      if (before.panelBackground !== after.panelBackground) throw new Error(`Chat panel background changed while toggling at width ${width}`);
    }

    // The fixture itself renders both themes; remounting here would reset the
    // already-verified state. Apply the app theme on the live screen so the
    // dark/light surfaces are both captured with the same remote-watch layout.
    await js("document.documentElement.dataset.theme='light'; document.documentElement.style.colorScheme='light'");
    await delay(250);
    win.setContentSize(760, 900);
    await delay(160);
    await capture("light-760-expanded");
    const light = await js("window.shareChatQa.getSnapshot()");
    if (!light.panelBackground || /rgba?\([^)]*,\s*0(?:\.0+)?\)/.test(light.panelBackground)) throw new Error("Light shared chat panel is not opaque");

    const result = await js("window.shareChatQaResult");
    const enriched = { ...result, screenshots: fs.readdirSync(artifacts).filter((name) => name.endsWith('.png')).sort() };
    fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify(enriched, null, 2));
    fs.writeFileSync(path.resolve("output/share-chat-qa-result.json"), JSON.stringify(enriched, null, 2));
    if (!enriched.passed) throw new Error(enriched.error || "shared-chat QA fixture failed");
    console.log(`PASS: shared-chat QA (${enriched.screenshots.length} screenshots)`);
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      fs.writeFileSync(path.join(artifacts, "failure.png"), (await win.webContents.capturePage()).toPNG());
    } catch { /* renderer may have exited */ }
    clearTimeout(timeout);
    win.destroy();
    app.exit(1);
  }
});
