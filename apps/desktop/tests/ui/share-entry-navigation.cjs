// Real ChatRoomV2, real CSS, synthetic capture only. Supports an offline Vite build.
// Linux headless: electron --ozone-platform=headless --ozone-override-screen-size=1440,900 <this file>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const viewportWidth = Number(process.env.COVE_UI_QA_WIDTH || 1440);
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || path.join(__dirname, '../../../tmp/share-entry-navigation'));
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const results = { runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, viewportWidth, viewportHeight: 900 }, checks: [], rendererErrors: [], flows: {}, paints: {} };
const check = (condition, label) => results.checks.push({ label, passed: Boolean(condition) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('UI QA exceeded 90 seconds'); app.exit(2); }, 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: viewportWidth, height: 900, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'share-entry-navigation-isolated' } });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', event => { if (event.level >= 2) console.log('renderer:', event.message); });
  win.webContents.on('render-process-gone', (_event, details) => results.rendererErrors.push(details));
  let activePaints = null;
  win.webContents.on('paint', (_event, dirty, image) => {
    if (activePaints && activePaints.frames.length < 48)
      activePaints.frames.push({ elapsed: performance.now() - activePaints.started, image, dirty });
  });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async code => {
    for (let attempt = 0; attempt < 240; attempt++) { if (await js(code)) return; await delay(25); }
    throw new Error('Timed out: ' + code);
  };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = text => js(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const capture = async name => {
    const image = await win.webContents.capturePage();
    check(image.getSize().width === viewportWidth && image.getSize().height === 900, name + ': actual ' + viewportWidth + 'x900 pixels');
    fs.writeFileSync(path.join(artifacts, name + '.png'), image.toPNG());
  };
  const record = async (name, action) => {
    activePaints = { started: performance.now(), frames: [] };
    try { results.flows[name] = await action(); }
    finally {
      const frames = activePaints.frames; activePaints = null;
      const directory = path.join(artifacts, name); fs.mkdirSync(directory, { recursive: true });
      results.paints[name] = frames.map((frame, index) => {
        const file = `${String(index).padStart(2, '0')}-${Math.round(frame.elapsed)}ms.png`;
        fs.writeFileSync(path.join(directory, file), frame.image.toPNG());
        return { elapsed: frame.elapsed, size: frame.image.getSize(), dirty: frame.dirty, file: `${name}/${file}` };
      });
    }
    return results.flows[name];
  };
  const entry = (name, action) => record(name, () => js(`(async () => {
    const frames=[]; const started=performance.now(); ${action};
    while(performance.now()-started<720) {
      await new Promise(requestAnimationFrame);
      const shell=document.querySelector('.cove-shell');
      if (!shell.matches('.mode-self,.mode-watching')) continue;
      const video=shell.querySelector('.video-content video');
      const loader=shell.querySelector('.screen-video-loading');
      const vr=video?.getBoundingClientRect(), lr=loader?.getBoundingClientRect();
      const covered=!!(loader&&vr&&lr&&lr.left<=vr.left+1&&lr.top<=vr.top+1&&lr.right>=vr.right-1&&lr.bottom>=vr.bottom-1&&loader.contains(document.elementFromPoint(lr.left+lr.width/2,lr.top+lr.height/2))&&getComputedStyle(loader).backgroundImage!=='none');
      const rail=shell.querySelector('.navigation-rail').getBoundingClientRect();
      const workspace=shell.querySelector('.workspace').getBoundingClientRect();
      frames.push({elapsed:performance.now()-started,width:workspace.width,
        expected:shell.getBoundingClientRect().right-rail.right,classes:shell.className,
        videoPresent:!!video,videoReadyState:video?.readyState,videoOpacity:video?Number(getComputedStyle(video).opacity):null,
        videoVisibility:video?getComputedStyle(video).visibility:null,videoWidth:video?.videoWidth,
        loading:!!loader,loadingCoversVideo:covered,busy:shell.querySelector('.screen-video-surface,.remote-video-surface')?.getAttribute('aria-busy')});
    }
    return frames;
  })()`));
  const navigation = (name, selectors, intervals = []) => record(name, () => js(`(async () => {
    const rail=document.querySelector('.navigation-rail'); const copy=rail.querySelector('.room-nav-copy');
    const brand=rail.querySelector('.brand-name'); const settings=rail.querySelector('.room-nav-item > .icon-btn');
    const globalSettings=rail.querySelector('.global-settings-button');
    const settingsIcon=globalSettings.querySelector('.nav-action-icon');
    const video=document.querySelector('.video-content video'); const stream=video?.srcObject;
    const read=()=>{const rr=rail.getBoundingClientRect(),ir=settingsIcon.getBoundingClientRect();return {
      width:rr.width,copyWidth:copy.getBoundingClientRect().width,
      settingsX:ir.left+ir.width/2-rr.left,settingsY:ir.top+ir.height/2,
      railPadding:Number.parseFloat(getComputedStyle(rail).paddingLeft),
      sameGlobalSettings:rail.querySelector('.global-settings-button')===globalSettings,
      sameSettingsIcon:globalSettings.querySelector('.nav-action-icon')===settingsIcon,
      copyOpacity:Number(getComputedStyle(copy).opacity),copyVisibility:getComputedStyle(copy).visibility,
      copyDisplay:getComputedStyle(copy).display,sameCopy:rail.querySelector('.room-nav-copy')===copy,
      sameBrand:!!brand&&rail.querySelector('.brand-name')===brand,
      sameSettings:!!settings&&rail.querySelector('.room-nav-item > .icon-btn')===settings,
      sameVideo:document.querySelector('.video-content video')===video&&video?.srcObject===stream,playing:!video||!video.paused};};
    const before=read(), frames=[], actions=${JSON.stringify(selectors)}, intervals=${JSON.stringify(intervals)};
    const started=performance.now(); let next=0, action=0;
    while(performance.now()-started<720) {
      if(action<actions.length&&performance.now()-started>=next) {
        document.querySelector(actions[action]).click(); next += intervals[action] ?? 0; action++;
        // Let React commit the click before measuring the class-change frame.
        await Promise.resolve();
        frames.push({elapsed:performance.now()-started,...read()});
      }
      await new Promise(requestAnimationFrame); frames.push({elapsed:performance.now()-started,...read()});
    }
    return {before,frames,after:read()};
  })()`));
  const assertEntry = name => {
    const frames = results.flows[name];
    check(frames.length > 2, name + ': sampled startup frames');
    check(frames.every(frame => Math.abs(frame.width - frame.expected) < 2), name + ': full workspace from first share frame');
    check(frames.every(frame => /chat-closed/.test(frame.classes)), name + ': chat closed atomically on entry');
  };
  const assertNavigation = (name, target, continuous = true) => {
    const { before, frames, after } = results.flows[name];
    check(before.copyDisplay !== 'none' && frames.every(frame => frame.copyDisplay !== 'none'), name + ': labels stay laid out');
    check(frames.every(frame => frame.sameCopy && frame.sameBrand && frame.sameSettings), name + ': stable content nodes');
    check(frames.every(frame => frame.sameGlobalSettings && frame.sameSettingsIcon), name + ': stable bottom settings nodes');
    check(frames.every(frame => Math.abs(frame.settingsY-before.settingsY)<0.2), name + ': bottom settings never jumps vertically');
    // Original endpoints: center x=36px at padding=10px, x=38px at 14px.
    // Every intermediate position must follow that same trajectory, including
    // the synchronous class-change frame and interrupted/reversed transitions.
    check(frames.every(frame => Math.abs(frame.settingsX-(31+frame.railPadding/2))<0.2), name + ': bottom settings follows rail padding without an instant icon-offset jump');
    check(frames.every(frame => Math.abs(frame.copyWidth - before.copyWidth) < 0.2), name + ': fixed label width');
    check(frames.every(frame => frame.sameVideo && frame.playing), name + ': uninterrupted shared video');
    if (!continuous) check(frames.every(frame => Math.abs(frame.width - target) < 1), name + ': reduced motion has no intermediate width');
    if (continuous) check(frames.filter(frame => frame.width > 73 && frame.width < 279).length >= 2, name + ': continuous rail width samples');
    check(Math.abs(after.width - target) < 1, name + ': final rail width');
    if (name === 'expand' || name === 'remoteExpand') check(frames.filter(frame => frame.elapsed < 150).every(frame => frame.copyOpacity < 0.05 || frame.copyVisibility === 'hidden'), name + ': label reveal waits for panel opening');
    if (name === 'collapse' || name === 'remoteCollapse') check(frames.every(frame => frame.copyOpacity < 0.05 || frame.copyVisibility === 'hidden'), name + ': labels hide immediately when closing');
  };
  const expand = '[aria-label="展开频道栏"]', collapse = '[aria-label="收回频道栏"]';
  try {
    await win.loadURL(process.env.COVE_UI_QA_URL || 'http://127.0.0.1:55173/tests/ui/share-chat-qa.html?layout-animation');
    await waitFor('Boolean(document.querySelector(\'button[title="加入语音"]\'))');
    await click('button[title="加入语音"]');
    await waitFor("Boolean(document.querySelector('.control-ball.voice-active'))");
    await delay(400);
    await capture('ordinary');
    await navigation('ordinaryExpand', [expand]); assertNavigation('ordinaryExpand', 280);
    await navigation('ordinaryCollapse', [collapse]); assertNavigation('ordinaryCollapse', 72);
    results.narrowGeometry = await js("(()=>{const button=document.querySelector('.room-switch'),badge=button.querySelector('.voice-count');return {button:button.getBoundingClientRect().toJSON(),badge:badge.getBoundingClientRect().toJSON(),overflow:getComputedStyle(button).overflow}})()");
    check(results.narrowGeometry.overflow !== 'hidden' || results.narrowGeometry.badge.right <= results.narrowGeometry.button.right + 0.5, 'narrow rail: voice count badge is not clipped');
    check(await js("[...document.querySelectorAll('.nav-collapse,.room-nav-item > .icon-btn')].every(button => button.disabled && button.tabIndex === -1)"), 'collapsed hidden actions are disabled and out of tab order');
    await click('button[title="共享屏幕"]');
    await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
    await entry('selfEntry', "document.querySelector('.share-dialog .primary-wide').click()");
    assertEntry('selfEntry'); await capture('self-entry');
    results.closedChatFocus = await js(`(()=>{const shell=document.querySelector('.cove-shell'),slot=document.querySelector('.chat-slot'),input=slot.querySelector('textarea');const before=shell.scrollLeft;input.focus();return {inert:slot.inert,ariaHidden:slot.getAttribute('aria-hidden'),focused:document.activeElement===input,before,after:shell.scrollLeft}})()`);
    check(results.closedChatFocus.inert && results.closedChatFocus.ariaHidden === 'true' && !results.closedChatFocus.focused && results.closedChatFocus.after === results.closedChatFocus.before, 'closed chat: inert textarea cannot focus or scroll the shell');
    await waitFor("document.querySelector('.video-content video')?.readyState >= 2");
    await navigation('expand', [expand]); assertNavigation('expand', 280); await capture('room-expanded');
    await navigation('collapse', [collapse]); assertNavigation('collapse', 72); await capture('room-collapsed');
    check(await js("document.activeElement === document.querySelector('[aria-label=\"展开频道栏\"]')"), 'collapse restores keyboard focus to visible expand control');
    await navigation('rapidToggle', [expand, collapse, expand, collapse, expand], [65, 45, 65, 45]);
    assertNavigation('rapidToggle', 280);
    await navigation('resetNarrow', [collapse]); assertNavigation('resetNarrow', 72);
    await clickText('结束共享');
    await waitFor("!document.querySelector('.mode-self')");
    // Withhold actual video chunks to exercise the real first-frame gate.
    if (await js("window.shareChatQa.supportsDelayedFrames")) {
      await delay(450);
      await js("window.shareChatQa.setNextShareFrameDelay(360)");
      await click('button[title="共享屏幕"]');
      await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
      await entry('delayedEntry', "document.querySelector('.share-dialog .primary-wide').click()");
      assertEntry('delayedEntry');
      const pending = results.flows.delayedEntry.filter(frame => frame.videoReadyState < 2);
      check(pending.length > 2, 'delayedEntry: real video has no frame during delay');
      check(pending.every(frame => frame.loading && frame.busy === 'true' && frame.loadingCoversVideo), 'delayedEntry: empty video hidden behind loading surface');
      check(results.flows.delayedEntry.some(frame => frame.videoReadyState >= 2 && !frame.loading && frame.busy === 'false'), 'delayedEntry: first presented frame replaces loading surface');
      await capture('delayed-ready');
      await clickText('结束共享'); await waitFor("!document.querySelector('.mode-self')");
      await js("window.shareChatQa.setNextShareFrameDelay(1500)");
      await click('button[title="共享屏幕"]');
      await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
      await entry('cancelPendingEntry', "document.querySelector('.share-dialog .primary-wide').click()");
      assertEntry('cancelPendingEntry');
      check(results.flows.cancelPendingEntry.every(frame => frame.loading && frame.busy === 'true'), 'cancelPendingEntry: no frame exposed before cancellation');
      await clickText('结束共享'); await waitFor("!document.querySelector('.mode-self')");
      await click('button[title="共享屏幕"]');
      await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
      await entry('immediateReentry', "document.querySelector('.share-dialog .primary-wide').click()");
      assertEntry('immediateReentry');
      await waitFor("document.querySelector('.screen-video-surface')?.getAttribute('aria-busy') === 'false'");
      check(await js("document.querySelector('.video-content video')?.videoWidth === 1280"), 'immediateReentry: replacement stream presents successfully');
      await clickText('结束共享'); await waitFor("!document.querySelector('.mode-self')");
    } else { check(false, 'delayed first-frame API is available'); }
    // Let the ordinary member-column layout settle before testing remote entry.
    await delay(450);
    await entry('remoteEntry', "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='观看共享').click()");
    assertEntry('remoteEntry'); await capture('remote-entry');
    await waitFor("document.querySelector('.video-content video')?.readyState >= 2");
    await navigation('remoteExpand', [expand]); assertNavigation('remoteExpand', 280);
    await navigation('remoteCollapse', [collapse]); assertNavigation('remoteCollapse', 72);
    await js("document.documentElement.dataset.theme = 'light'");
    await navigation('lightExpand', [expand]); assertNavigation('lightExpand', 280);
    await capture('light-room-expanded');
    await navigation('lightCollapse', [collapse]); assertNavigation('lightCollapse', 72);
    await navigation('lightRapidToggle', [expand, collapse, expand, collapse, expand], [65, 45, 65, 45]);
    assertNavigation('lightRapidToggle', 280);
    await navigation('lightResetNarrow', [collapse]); assertNavigation('lightResetNarrow', 72);
    await js("document.documentElement.dataset.theme = 'dark'");
    const availableWidth = results.flows.remoteEntry.at(-1).expected;
    const chatLayout = await js("(()=>{const s=document.querySelector('.cove-shell');return {drawer:s.classList.contains('share-chat-drawer'),width:parseFloat(getComputedStyle(s).getPropertyValue('--chat-panel-width'))}})()");
    for (const [name, expectedWidth] of [['chatOpen', availableWidth - (chatLayout.drawer ? 0 : chatLayout.width)], ['chatClose', availableWidth]]) {
      const frames = await record(name, () => js(`(async()=>{
        const video=document.querySelector('.video-content video'), stream=video.srcObject, frames=[];
        document.querySelector('.chat-edge-toggle').click(); const started=performance.now();
        while(performance.now()-started<450){await new Promise(requestAnimationFrame);frames.push({elapsed:performance.now()-started,width:document.querySelector('.workspace').getBoundingClientRect().width,sameVideo:document.querySelector('.video-content video')===video&&video.srcObject===stream,playing:!video.paused});}
        return frames;
      })()`));
      check(frames.every(frame => frame.sameVideo && frame.playing), name + ': shared video stays mounted and playing');
      check(Math.abs(frames.at(-1).width - expectedWidth) < 1, name + ': correct chat endpoint');
      if (!chatLayout.drawer) check(frames.filter(frame => frame.width > availableWidth - chatLayout.width + 1 && frame.width < availableWidth - 1).length > 2, name + ': intentional chat animation still works');
      else check(frames.every(frame => Math.abs(frame.width - availableWidth) < 1), name + ': narrow chat stays an overlay without resizing video');
      if (name === 'chatOpen') {
        results.openChatFocus = await js(`(()=>{const shell=document.querySelector('.cove-shell'),slot=document.querySelector('.chat-slot'),input=slot.querySelector('textarea');input.focus();return {inert:slot.inert,focused:document.activeElement===input,scroll:shell.scrollLeft}})()`);
        check(!results.openChatFocus.inert && results.openChatFocus.focused && results.openChatFocus.scroll === 0, 'open chat: textarea accepts focus without shifting layout');
      } else {
        check(await js("document.activeElement === document.querySelector('.chat-edge-toggle') && document.querySelector('.chat-slot').inert && document.querySelector('.cove-shell').scrollLeft === 0"), 'close focused chat: focus returns to edge toggle without shifting layout');
      }
    }
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    results.reducedMotion = await js("matchMedia('(prefers-reduced-motion: reduce)').matches");
    check(results.reducedMotion, 'reduced-motion preference applied');
    await navigation('reducedExpand', [expand]); assertNavigation('reducedExpand', 280, false);
    await navigation('reducedCollapse', [collapse]); assertNavigation('reducedCollapse', 72, false);
    win.webContents.debugger.detach();
    check(results.rendererErrors.length === 0, 'renderer process stayed alive');
    const failed = results.checks.filter(item => !item.passed);
    if (failed.length) throw new Error(`${failed.length} failed checks: ${failed.map(item => item.label).join('; ')}`);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({passed:true,results},null,2));
    console.log(`PASS: ${results.checks.length} UI checks, full-width share entry and stable repeated navigation`);
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({passed:false,error:String(error),results},null,2));
    clearTimeout(timeout); win.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(2); });
