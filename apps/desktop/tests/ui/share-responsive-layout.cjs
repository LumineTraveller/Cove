// Production room/dock components and CSS; only socket/capture are synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const mainSource = fs.readFileSync(path.join(__dirname, '../../electron/main.ts'), 'utf8');
const minimumWidth = Number(mainSource.match(/\bminWidth:\s*(\d+)/)?.[1]);
if (!Number.isFinite(minimumWidth)) throw new Error('Missing desktop window minimum width');
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || path.join(__dirname, '../../../tmp/share-responsive'));
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const results = { checks: [], states: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(2), 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1800, height: 900, minWidth: minimumWidth, minHeight: 600,
    frame: false, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'share-responsive-isolated' } });
  win.webContents.setFrameRate(60);
  win.webContents.setAudioMuted(true);
  win.webContents.on('render-process-gone', (_event, details) => results.errors.push(details));
  const js = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async code => {
    for (let i = 0; i < 240; i++) { if (await js(code)) return; await delay(25); }
    throw new Error('Timed out: ' + code);
  };
  const check = (condition, label) => {
    results.checks.push({ label, passed: Boolean(condition) });
    if (!condition) throw new Error(label);
  };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async name => {
    await delay(220);
    fs.writeFileSync(path.join(artifacts, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const read = () => js(`(()=>{
    const shell=document.querySelector('.cove-shell'),style=getComputedStyle(shell),dock=shell.querySelector('.control-ball');
    const bar=shell.querySelector('.share-status-bar');
    const rect=e=>e?.getBoundingClientRect().toJSON();
    const controls=[...bar.querySelectorAll('.share-status-left > *, .share-status-actions')].map(rect);
    const d=rect(dock),overlap=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
    return {shellWidth:shell.clientWidth,railWidth:parseFloat(style.getPropertyValue('--rail-width')),
      panelWidth:parseFloat(style.getPropertyValue('--chat-panel-width')),drawer:shell.classList.contains('share-chat-drawer'),
      chatOpen:shell.classList.contains('chat-open'),workspace:rect(shell.querySelector('.workspace')),bar:rect(bar),
      dock:d,classes:dock.className,overlaps:controls.filter(r=>overlap(d,r)),
      ball:rect(dock.querySelector('.ball-quad')),
      anchorClasses:shell.querySelector('.control-ball-anchor').className,
      anchorBottom:getComputedStyle(shell.querySelector('.control-ball-anchor')).bottom,
      shareNameWidth:rect(bar.querySelector('.share-status-left > b')).width,
      volumeWidth:rect(bar.querySelector('.share-status-left .volume-control'))?.width,
      visibleLabels:[...dock.querySelectorAll('.dock-label')].filter(l=>l.getBoundingClientRect().width>.5 && parseFloat(getComputedStyle(l).opacity)>.1).length,
      video:shell.querySelector('.video-content video')?.paused,
      manageClickable:(()=>{const b=bar.querySelector('.share-operations-trigger'),r=rect(b);return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()
    };
  })()`);
  const rail = async expanded => {
    const selector = expanded ? '[aria-label="展开频道栏"]' : '[aria-label="收回频道栏"]';
    if (await js(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`)) await click(selector);
    await delay(420);
  };
  const chat = async open => {
    if (await js(`document.querySelector('.chat-edge-toggle').getAttribute('aria-expanded') !== '${open}'`)) await click('.chat-edge-toggle');
    await delay(420);
  };
  const resize = async width => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    win.setContentSize(width, 900); await delay(650);
  };
  const animateResize = async (width, target, label, reducedMotion = false) => {
    await js(`(()=>{
      const dock=document.querySelector('.control-ball');
      window.__qaDockMotion={samples:[],video:document.querySelector('.video-content video')};
      const start=performance.now();
      const sample=()=>{
        const d=dock.getBoundingClientRect(),l=dock.querySelector('.dock-label');
        window.__qaDockMotion.samples.push({time:performance.now()-start,width:d.width,height:d.height,
          expanded:dock.classList.contains('expanded'),fit:dock.classList.contains('full')?'full':'compact',
          labelWidth:l.getBoundingClientRect().width,opacity:parseFloat(getComputedStyle(l).opacity)});
        if(performance.now()-start<550) requestAnimationFrame(sample);
      };sample();
    })()`);
    win.setContentSize(width, 900);
    await delay(650);
    const motion = await js(`({samples:window.__qaDockMotion.samples,
      videoRetained:document.querySelector('.video-content video')===window.__qaDockMotion.video
        && !window.__qaDockMotion.video.paused})`);
    results.motions ??= [];
    results.motions.push({label,reducedMotion,...motion});
    const samples = motion.samples;
    const start = samples[0], end = samples.at(-1);
    check(start.fit !== target && end.fit === target, label + ': changes dock presentation');
    check(samples.every(s=>s.expanded && Math.abs(s.height-58)<.5), label + ': stays expanded and horizontal');
    check(motion.videoRetained, label + ': does not replace or pause video');
    const low = Math.min(start.width,end.width), high = Math.max(start.width,end.width);
    const intermediate = samples.filter(s=>s.width>low+1 && s.width<high-1);
    if (reducedMotion) {
      check(intermediate.length === 0, label + ': reduced motion switches directly');
    } else {
      check(intermediate.length >= 2, label + ': has continuous intermediate widths');
      const direction = Math.sign(end.width-start.width);
      check(samples.slice(1).every((s,i)=>(s.width-samples[i].width)*direction>=-.6),
        label + ': animates monotonically without width flicker');
      const targetStart = samples.find(s=>s.fit===target)?.time;
      check(samples.filter(s=>s.time>targetStart+370).every(s=>Math.abs(s.width-end.width)<.6),
        label + ': completes within the existing animation rhythm');
    }
  };
  const inspect = async (label, { temporaryExpansion = false } = {}) => {
    const s = await read(); results.states.push({ label, ...s });
    check(Math.abs(s.bar.height - 58) < .5, label + ': footer remains 58px');
    check(s.drawer === (s.shellWidth - s.railWidth - s.panelWidth < 640), label + ': drawer uses remaining space');
    if (!temporaryExpansion) {
      check(s.overlaps.length === 0, label + ': dock does not cover share status/actions');
      check(s.manageClickable, label + ': shared operations remain clickable');
    }
    check(Math.abs(s.dock.height - 58) < .5, label + ': dock remains horizontal');
    check(s.anchorBottom === '15px', label + ': dock keeps original bottom position');
    check(!/control-ball-(upward|responsive-raised)/.test(s.anchorClasses), label + ': no upward or raised presentation');
    check(s.video === false, label + ': shared video keeps playing');
    check(s.dock.left >= s.workspace.left - .5 && s.dock.right <= s.workspace.right + .5, label + ': dock stays within workspace');
    await capture(label); return s;
  };
  try {
    await win.loadURL(process.env.COVE_UI_QA_URL || 'http://127.0.0.1:55173/tests/ui/share-chat-qa.html?layout-animation&screen-audio');
    await waitFor("Boolean(document.querySelector('button[title=\"加入语音\"]'))");
    await click('button[title="加入语音"]');
    await waitFor("Boolean(document.querySelector('.control-ball.voice-active'))");
    check(await js("document.querySelector('.control-ball').classList.contains('compact')"), 'ordinary room preserves compact dock');
    await click('button[title="共享屏幕"]');
    await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
    await click('.share-dialog .primary-wide');
    await waitFor("document.querySelector('.video-content video')?.readyState>=2");
    await delay(500);
    const full = await inspect('owner-wide');
    check(full.classes.includes('full') && full.visibleLabels > 0, 'wide share keeps labeled dock');
    await animateResize(1150, 'compact', 'owner-full-to-compact'); await inspect('owner-medium');
    await animateResize(1800, 'full', 'owner-compact-to-full'); await inspect('owner-full-restored');
    await resize(900); await rail(true);
    check(win.getSize()[0] >= minimumWidth && minimumWidth === 1100, 'native minimum clamps narrow window to 1100px');
    await inspect('owner-narrow');
    await click('.share-status-actions .end-share');
    await waitFor("!document.querySelector('.mode-self')");
    await resize(1800); await rail(false);
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='观看共享').click()");
    await waitFor("document.querySelector('.video-content video')?.readyState>=2");
    await waitFor("Boolean(document.querySelector('.share-status-left .volume-control'))");
    // Explicitly lock in ample space; constrained resizing must release this
    // preference only when a ball is necessary, never toggle it repeatedly.
    if (await js("!document.querySelector('.control-ball').classList.contains('locked')")) await click('.ball-quad');
    await delay(500); await inspect('viewer-wide-audio');
    await animateResize(1450, 'compact', 'viewer-full-to-compact');
    await inspect('viewer-compact-animated');
    await animateResize(1800, 'full', 'viewer-compact-to-full');
    await inspect('viewer-full-animated');
    for (const width of [1450, 1300, 1150, 1100]) {
      await resize(width); await rail(false); await chat(false);
      await inspect('viewer-' + width);
    }
    await resize(1150); await rail(false); await chat(true);
    let s = await read();
    check(!s.drawer, '1150px collapsed rail still supports docked chat');
    await rail(true); s = await read();
    check(s.drawer, '1150px expanded rail changes open chat to drawer');
    check(Math.abs(s.workspace.width - (s.shellWidth - s.railWidth)) < 1, 'drawer reserves no video column width');
    await capture('boundary-drawer');
    // Reversing the order must choose the same presentation without toggling chat.
    await chat(false); await rail(false); await rail(true); await chat(true);
    check((await read()).drawer, 'opening chat after rail also selects drawer');
    const video = await js("window.__qaResponsiveVideo=document.querySelector('.video-content video');true");
    check(video, 'video node captured for interrupted toggles');
    for (let i=0; i<6; i++) {
      await click('[aria-label="' + (i % 2 ? '展开频道栏' : '收回频道栏') + '"]');
      await delay(45);
    }
    await delay(600);
    check(await js("document.querySelector('.video-content video')===window.__qaResponsiveVideo && !window.__qaResponsiveVideo.paused"), 'rapid presentation changes retain video/stream');
    await chat(false); await rail(true); await resize(1100);
    s = await inspect('viewer-ball');
    check(s.classes.includes('collapsed') && s.classes.includes('unlocked'), 'severely constrained dock releases lock and becomes ball');
    check(s.shareNameWidth >= 139 && s.volumeWidth >= 174, 'minimum-width ball is tested with maximum share-name width and system audio controls');
    const ball = await js("document.querySelector('.ball-quad').getBoundingClientRect().toJSON()");
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(ball.left+ball.width/2),y:Math.round(ball.top+ball.height/2)});
    await delay(500);
    s = await inspect('viewer-ball-hover', { temporaryExpansion: true });
    check(s.classes.includes('expanded') && s.classes.includes('compact'), 'collapsed ball still exposes icon actions on hover');
    // Compact side widths differ by half a pixel because the leave icon is
    // 22px and its opposite icon is 21px; retain the original horizontal CSS.
    check(Math.abs(s.ball.left+s.ball.width/2-(ball.left+ball.width/2)) <= 1
      && Math.abs(s.ball.top+s.ball.height/2-(ball.top+ball.height/2)) <= 1,
      'horizontal expansion keeps the ball anchored under the pointer');
    check(await js("(()=>{const b=document.querySelector('.ball-side button[title=\"切换麦克风\"]'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()"), 'hovered compact microphone action is clickable');
    win.webContents.sendInputEvent({type:'mouseMove',x:8,y:8}); await delay(600);
    await inspect('viewer-ball-collapsed-again');
    check(await js("[...document.querySelectorAll('.control-ball .ball-side button')].every(b=>b.tabIndex===-1)"), 'collapsed actions are excluded from keyboard tab order');
    // An offscreen window has no OS focus; enable Chromium's native focus
    // emulation so focus() dispatches real focus events without showing a window.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    await js("document.querySelector('.ball-quad').focus()"); await delay(500);
    results.keyboardFocus = await js("({active:document.activeElement?.className,hasFocus:document.hasFocus(),dock:document.querySelector('.control-ball').className})");
    check((await read()).classes.includes('expanded'), 'keyboard focus also opens constrained dock');
    check(await js("[...document.querySelectorAll('.control-ball .ball-side button')].every(b=>b.tabIndex===0)"), 'expanded icon actions remain keyboard reachable');
    await js("document.querySelector('.share-operations-trigger').focus()"); await delay(600);
    await inspect('viewer-ball-keyboard-blurred');
    await resize(1800); await rail(false);
    s = await inspect('viewer-restored');
    check(s.classes.includes('unlocked'), 'widening does not overwrite released/manual unlock preference');
    await js("window.shareChatQa.setTheme('light')");
    await resize(1150); await inspect('viewer-light');
    // Freeze widths and watch for state oscillation after all animations settle.
    const classes = [];
    for (let i=0; i<12; i++) { classes.push((await read()).classes); await delay(35); }
    check(new Set(classes).size===1, 'steady layout does not oscillate dock states');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await resize(1800);
    await click('.ball-quad'); await delay(400);
    await animateResize(1450, 'compact', 'reduced-motion-full-to-compact', true);
    await resize(1150); await rail(true); await chat(true);
    check((await read()).drawer, 'reduced motion retains remaining-space drawer decision');
    win.webContents.debugger.detach();
    check(results.errors.length===0, 'renderer process stays alive');
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:true,results},null,2));
    console.log(`PASS: ${results.checks.length} responsive shared-layout UI checks`);
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    await capture('failure').catch(()=>{});
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),results},null,2));
    console.error(error); clearTimeout(timeout); win.destroy(); app.exit(1);
  }
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(2)});
