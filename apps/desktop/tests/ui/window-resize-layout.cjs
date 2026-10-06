// Hidden, isolated Electron regression for viewport coverage while the native
// window is resized. The page uses the existing share-chat QA fixture, which
// supplies its own socket, capture stream, and account-free API doubles.
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const qaUrl = process.env.COVE_UI_QA_URL ||
  'http://127.0.0.1:55173/tests/ui/share-chat-qa.html?layout-animation';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-window-resize-'));
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || userData);
fs.mkdirSync(artifacts, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const watchdog = setTimeout(() => {
  console.error('FAIL: window-resize layout regression timed out');
  app.exit(1);
}, 90_000);

app.setPath('userData', userData);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    frame: false,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      partition: `window-resize-qa-${Date.now()}`,
    },
  });
  window.webContents.setFrameRate(60);
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('renderer:', message);
  });

  const js = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code, label, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js(`Boolean(${code})`)) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const clickButton = async (condition, label) => {
    const didClick = await js(`(() => {
      const button = [...document.querySelectorAll('button')].find(${condition});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(didClick, true, `${label} button is available`);
  };

  const readMode = () => js(`(() => {
    const shell = document.querySelector('.cove-shell');
    return ['idle', 'available', 'self', 'watching'].find(mode => shell?.classList.contains('mode-' + mode)) ?? null;
  })()`);

  const startFrameSampler = () => js(`(() => {
    const state = { active: true, frames: [] };
    window.__windowResizeLayoutQa = state;
    const sample = () => {
      if (!state.active) return;
      const page = document.querySelector('.cove-v2-page');
      const shell = document.querySelector('.cove-shell');
      const rect = element => {
        const r = element.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const shellStyle = shell ? getComputedStyle(shell) : null;
      const pageStyle = page ? getComputedStyle(page) : null;
      state.frames.push({
        at: performance.now(),
        viewport: { width: innerWidth, height: innerHeight },
        page: page ? rect(page) : null,
        shell: shell ? rect(shell) : null,
        pagePadding: pageStyle ? [pageStyle.paddingTop, pageStyle.paddingRight, pageStyle.paddingBottom, pageStyle.paddingLeft] : null,
        shellRadius: shellStyle?.borderTopLeftRadius ?? null,
        shellTransitionDuration: shellStyle?.transitionDuration ?? null,
        resizing: document.documentElement.classList.contains('viewport-resizing'),
        documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      });
      requestAnimationFrame(sample);
    };
    sample();
  })()`);

  const stopFrameSampler = () => js(`(() => {
    const state = window.__windowResizeLayoutQa;
    if (state) state.active = false;
    return state?.frames ?? [];
  })()`);

  const resizeSizes = [
    { width: 1180, height: 820 },
    { width: 1023, height: 760 },
    { width: 900, height: 680 },
    { width: 980, height: 720 },
    { width: 1120, height: 800 },
    { width: 1023, height: 760 },
    { width: 1180, height: 820 },
  ];

  const verifyResizeFrames = async (mode, theme) => {
    await js(`window.shareChatQa.setTheme(${JSON.stringify(theme)})`);
    await delay(100);
    assert.equal(await readMode(), mode, `${mode}/${theme}: fixture mode remains active`);

    await startFrameSampler();
    for (const size of resizeSizes) {
      window.setContentSize(size.width, size.height);
      // Native resize messages are asynchronous; wait for the actual viewport
      // before issuing the next size so offscreen compositor coalescing cannot
      // skip the breakpoint that this regression intends to exercise.
      await waitFor(`Math.abs(innerWidth-${size.width})<=1 && Math.abs(innerHeight-${size.height})<=1`,
        `${mode}/${theme}: native resize applied`, 2000);
      await delay(32);
    }
    await delay(180);
    const frames = await stopFrameSampler();
    const result = {label:`${mode}/${theme}/viewport-coverage`,frames};
    results.push(result);
    assert.ok(frames.length >= 8, `${mode}/${theme}: sampled live resize frames`);
    // Windows can round odd native DIP sizes by a pixel. Compare coverage
    // against the actual viewport below, not the requested native size.
    assert.ok(frames.some(frame => Math.abs(frame.viewport.width-1023)<=1), `${mode}/${theme}: reached 1023px test width`);
    assert.ok(frames.some(frame => Math.abs(frame.viewport.width-900)<=1), `${mode}/${theme}: reached 900px breakpoint test width`);

    for (const frame of frames) {
      assert.ok(frame.page && frame.shell, `${mode}/${theme}: viewport shell exists on every frame`);
      for (const [element, label] of [[frame.page, 'page'], [frame.shell, 'shell']]) {
        assert.ok(Math.abs(element.left) < 0.5, `${mode}/${theme}: ${label} stays anchored to the left edge`);
        assert.ok(Math.abs(element.top) < 0.5, `${mode}/${theme}: ${label} stays anchored to the top edge`);
        assert.ok(Math.abs(element.right - frame.viewport.width) < 0.5, `${mode}/${theme}: ${label} covers the right edge`);
        assert.ok(Math.abs(element.bottom - frame.viewport.height) < 0.5, `${mode}/${theme}: ${label} covers the bottom edge`);
      }
      assert.deepEqual(frame.pagePadding, ['0px', '0px', '0px', '0px'], `${mode}/${theme}: no outer page padding`);
      assert.equal(frame.shellRadius, '0px', `${mode}/${theme}: shell reaches viewport corners`);
      assert.ok(frame.documentSize.width <= frame.viewport.width, `${mode}/${theme}: no horizontal document strip`);
      assert.ok(frame.documentSize.height <= frame.viewport.height, `${mode}/${theme}: no vertical document strip`);
    }

    const activeResizeFrames = frames.filter(frame => frame.resizing);
    assert.ok(activeResizeFrames.length >= 3, `${mode}/${theme}: resize state covers multiple rendered frames`);
    if (mode === 'self' || mode === 'watching') {
      assert.ok(activeResizeFrames.every(frame => frame.shellTransitionDuration === '0s'), `${mode}/${theme}: shell tracks follow live viewport frames`);
    }
    assert.equal(await js("document.documentElement.classList.contains('viewport-resizing')"), false, `${mode}/${theme}: resize state settles`);

    Object.assign(result, {
      sampledFrames: frames.length,
      activeResizeFrames: activeResizeFrames.length,
      testedWidths: [...new Set(frames.map(frame => frame.viewport.width))].filter(width => width <= 1023),
    });
    fs.writeFileSync(path.join(artifacts, `${mode}-${theme}.png`),
      (await window.webContents.capturePage()).toPNG());
  };

  const verifyChatAnimation = async (mode) => {
    const samples = await js(`(async () => {
      const toggle = document.querySelector('.chat-edge-toggle');
      const shell = document.querySelector('.cove-shell');
      if (!toggle || !shell) throw new Error('shared-chat toggle or shell missing');
      const read = () => document.querySelector('.workspace').getBoundingClientRect().width;
      const before = read();
      toggle.click();
      const start = performance.now();
      const frames = [];
      const durations = [];
      while (performance.now() - start < 430) {
        await new Promise(requestAnimationFrame);
        frames.push(read());
        durations.push(getComputedStyle(shell).transitionDuration);
      }
      return { before, frames, after: read(), durations, classes:shell.className,
        resizing: document.documentElement.classList.contains('viewport-resizing') };
    })()`);
    const direction = Math.sign(samples.after - samples.before);
    const intermediate = samples.frames.filter(width => direction * (width - samples.before) > 1 && direction * (samples.after - width) > 1);
    results.push({label:`${mode}/chat-animation`,...samples,intermediateFrames:intermediate.length});
    assert.equal(samples.resizing, false, `${mode}: settle resize before chat interaction`);
    assert.ok(samples.durations.some(duration => /0\.32s/.test(duration)), `${mode}: deliberate chat toggle retains 320ms shell transition`);
    assert.ok(direction !== 0 && intermediate.length >= 2, `${mode}: deliberate chat toggle still animates over intermediate frames`);
    await js("document.querySelector('.chat-edge-toggle').click()");
    await delay(400);
  };

  const verifySidebarAnimation = async () => {
    const animation = await js(`(async () => {
      const rail = document.querySelector('.navigation-rail');
      const toggle = rail.querySelector(rail.classList.contains('expanded')
        ? '[aria-label="收回频道栏"]' : '[aria-label="展开频道栏"]');
      if (!rail || !toggle) throw new Error('navigation rail or toggle missing');
      const before = rail.getBoundingClientRect().width;
      toggle.click();
      const start = performance.now();
      const frames = [];
      const durations = [];
      while (performance.now() - start < 430) {
        await new Promise(requestAnimationFrame);
        frames.push(rail.getBoundingClientRect().width);
        durations.push(getComputedStyle(rail).transitionDuration);
      }
      return { before, after: rail.getBoundingClientRect().width, durations, frames };
    })()`);
    const direction = Math.sign(animation.after - animation.before);
    const intermediate = animation.frames.filter(width => direction * (width - animation.before) > 1 && direction * (animation.after - width) > 1);
    assert.ok(animation.durations.some(duration => /0\.32s/.test(duration)), 'sidebar retains its 320ms width transition');
    assert.ok(direction !== 0 && intermediate.length >= 2, 'sidebar toggle still animates over intermediate frames');
    results.push({ label: 'sidebar-animation', intermediateFrames: intermediate.length });
    await js(`(()=>{const rail=document.querySelector('.navigation-rail');
      rail.querySelector(rail.classList.contains('expanded')
        ? '[aria-label="收回频道栏"]' : '[aria-label="展开频道栏"]').click();})()`);
    await delay(400);
    assert.ok(Math.abs(await js("document.querySelector('.navigation-rail').getBoundingClientRect().width") - animation.before) < 1,
      'sidebar is restored before testing docked chat');
  };

  try {
    await window.loadURL(qaUrl);
    await waitFor("window.shareChatQa && document.querySelector('.cove-shell')", 'share-chat fixture');
    await waitFor("document.querySelector('.mode-idle') || document.querySelector('.mode-available')", 'ordinary room mode');

    const ordinaryMode = await readMode();
    for (const theme of ['dark', 'light']) await verifyResizeFrames(ordinaryMode, theme);
    await verifySidebarAnimation();

    await clickButton("button => button.title === '加入语音'", 'join voice');
    await waitFor("document.querySelector('.control-ball.voice-active')", 'voice controls');
    await clickButton("button => button.title === '共享屏幕'", 'share screen');
    await waitFor("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '开始共享')", 'share confirmation');
    await clickButton("button => button.textContent.trim() === '开始共享'", 'confirm share');
    await waitFor("document.querySelector('.mode-self')", 'self-share mode');

    for (const theme of ['dark', 'light']) await verifyResizeFrames('self', theme);
    await verifyChatAnimation('self');

    await clickButton("button => button.textContent.trim() === '结束共享'", 'end local share');
    await waitFor("!document.querySelector('.mode-self')", 'ordinary mode after share');
    await clickButton("button => button.textContent.trim() === '观看共享'", 'watch remote share');
    await waitFor("document.querySelector('.mode-watching')", 'remote-watch mode');

    for (const theme of ['dark', 'light']) await verifyResizeFrames('watching', theme);
    await verifyChatAnimation('watching');

    console.log(`PASS: viewport resize layout (${results.length} checks)`);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({passed:true,results}, null, 2));
    clearTimeout(watchdog);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({passed:false,error:String(error),results}, null, 2));
    if (!window.isDestroyed()) fs.writeFileSync(path.join(artifacts, 'failure.png'),
      (await window.webContents.capturePage()).toPNG());
    clearTimeout(watchdog);
    if (!window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
