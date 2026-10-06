// Real ChatRoomV2/CSS, with the isolated fixture's synthetic media and socket.
// Run Vite on 5184, then: electron tests/ui/share-chat-animation.cjs
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const artifacts = path.resolve(__dirname, "../../../tmp/share-chat-animation");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const timeout = setTimeout(() => app.exit(1), 120_000);
fs.mkdirSync(artifacts, { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      offscreen: true, backgroundThrottling: false,
      partition: "share-chat-animation-isolated",
    },
  });
  win.webContents.setFrameRate(60);
  const js = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await js(code)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = async (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async (name) => fs.writeFileSync(
    path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG(),
  );
  const sample = async (selector) => js(`(async () => {
    const video = document.querySelector('.video-content video');
    const stream = video.srcObject;
    const read = () => {
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      const panel = document.querySelector('.chat-panel').getBoundingClientRect();
      const slot = document.querySelector('.chat-slot').getBoundingClientRect();
      const edge = document.querySelector('.chat-edge-toggle-anchor').getBoundingClientRect();
      return {
        width: workspace.width, right: workspace.right,
        panelWidth: panel.width, panelLeft: slot.left, edgeRight: edge.right,
        messagesWidth: document.querySelector('.message-list').getBoundingClientRect().width,
        railWidth: document.querySelector('.navigation-rail').getBoundingClientRect().width,
        sameVideo: document.querySelector('.video-content video') === video && video.srcObject === stream,
        playing: video.readyState >= 2 && !video.paused,
      };
    };
    const before = read();
    document.querySelector(${JSON.stringify(selector)}).click();
    const started = performance.now();
    const frames = [];
    while (performance.now() - started < 430) {
      await new Promise(requestAnimationFrame);
      frames.push({ elapsed: performance.now() - started, ...read() });
    }
    return { before, frames, after: read() };
  })()`);

  const verify = (data, label, delta, direction, seam = true) => {
    const { before, after, frames } = data;
    assert.ok(Math.abs(after.width - before.width - direction * delta) < 2, `${label}: final width (${before.width} -> ${after.width}, expected delta ${direction * delta})`);
    assert.ok(frames.every((frame) => frame.sameVideo && frame.playing), `${label}: uninterrupted playback`);
    assert.ok(frames.every((frame) => Math.abs(frame.panelWidth - before.panelWidth) < 0.2), `${label}: fixed panel width`);
    assert.ok(frames.every((frame) => Math.abs(frame.messagesWidth - before.messagesWidth) < 0.2), `${label}: no message reflow`);
    const intermediate = frames.filter((frame) =>
      direction * (frame.width - before.width) > 1 && direction * (after.width - frame.width) > 1,
    );
    assert.ok(intermediate.length >= 2, `${label}: continuous resize, not instant jump`);
    for (let index = 1; index < frames.length; index++) {
      assert.ok(direction * (frames[index].width - frames[index - 1].width) >= -0.5, `${label}: no bounce`);
    }
    if (seam) {
      assert.ok(frames.every((frame) => Math.abs(frame.right - frame.panelLeft) < 2), `${label}: video/panel seam synchronized`);
      assert.ok(frames.every((frame) => Math.abs(frame.edgeRight - frame.panelLeft) < 2), `${label}: handle synchronized`);
    }
    results.push({ label, intermediateFrames: intermediate.length, beforeWidth: before.width, afterWidth: after.width });
  };

  try {
    await win.loadURL(process.env.COVE_UI_QA_URL || "http://127.0.0.1:5184/tests/ui/share-chat-qa.html?layout-animation");
    await waitFor("Boolean(document.querySelector('button[title=\"加入语音\"]'))");
    await click('button[title="加入语音"]');
    await waitFor("Boolean(document.querySelector('.control-ball.voice-active'))");
    await click('button[title="共享屏幕"]');
    await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
    await click('.share-dialog .primary-wide');
    await waitFor("Boolean(document.querySelector('.mode-self .video-content video'))");
    await delay(500);

    for (const mode of ["self", "watching"]) {
      if (mode === "watching") {
        await js("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='结束共享').click()");
        await waitFor("!document.querySelector('.mode-self')");
        await js("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='观看共享').click()");
        await waitFor("Boolean(document.querySelector('.mode-watching .video-content video'))");
      }
      if (await js("Boolean(document.querySelector('.cove-shell.chat-closed'))")) {
        await click('.chat-edge-toggle');
        await delay(450);
      }
      for (const width of [1440, 1200, 1050]) {
        win.setContentSize(width, 900);
        await delay(450);
        const delta = width > 1220 ? 288 : 270;
        verify(await sample('.chat-edge-toggle'), `${mode}/${width}/close`, delta, 1);
        verify(await sample('.chat-edge-toggle'), `${mode}/${width}/open`, delta, -1);
      }
      win.setContentSize(1440, 900);
      await delay(450);
      verify(await sample('[aria-label="展开频道栏"]'), `${mode}/room-expand`, 208, -1, false);
      verify(await sample('[aria-label="收回频道栏"]'), `${mode}/room-collapse`, 208, 1, false);
      for (const width of [760, 480]) {
        win.setContentSize(width, 900);
        await delay(450);
        for (const direction of ["close", "open"]) {
          const data = await sample('.chat-edge-toggle');
          assert.ok(data.frames.every(frame => Math.abs(frame.width - data.before.width) < 0.2), `narrow ${width}: overlay does not resize video`);
          assert.ok(data.frames.every(frame => frame.sameVideo && frame.playing), `narrow ${width}: playback`);
          assert.ok(Math.abs(data.after.panelWidth - Math.min(360, width * 0.52)) < 1, `narrow ${width}: drawer width`);
          results.push({ label: `${mode}/${width}/${direction}/overlay` });
        }
      }
    }

    win.setContentSize(1440, 900);
    await delay(450);
    // Stress layout with many messages; their widths must remain constant.
    await js(`(() => { const list=document.querySelector('.message-list'); const message=list.querySelector('.message-row'); if(!message) throw new Error('message missing'); for(let i=0;i<150;i++) list.append(message.cloneNode(true)); })()`);
    verify(await sample('.chat-edge-toggle'), 'watching/many-messages/close', 288, 1);
    verify(await sample('.chat-edge-toggle'), 'watching/many-messages/open', 288, -1);
    await capture("dark-wide-open");
    await js("document.documentElement.dataset.theme='light'");
    await delay(100);
    await capture("light-wide-open");
    win.setContentSize(760, 900);
    await delay(450);
    await capture("light-narrow-overlay");
    win.setContentSize(1440, 900);
    await delay(450);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    assert.equal(await js("getComputedStyle(document.querySelector('.cove-shell')).transitionDuration"), "0s");
    assert.equal(await js("getComputedStyle(document.querySelector('.chat-slot')).transitionDuration"), "0s");
    await click('.chat-edge-toggle');
    await delay(50);
    assert.ok(await js("Math.abs(document.querySelector('.workspace').getBoundingClientRect().width - (innerWidth - 72)) < 2"));
    results.push({ label: "reduced-motion/no-animation" });
    fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
    console.log(`PASS: ${results.length} shared-chat animation cases`);
    console.log(JSON.stringify(results));
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ passed: false, results, error: String(error.stack || error) }, null, 2));
    await capture("failure").catch(() => {});
    clearTimeout(timeout);
    win.destroy();
    app.exit(1);
  }
});
