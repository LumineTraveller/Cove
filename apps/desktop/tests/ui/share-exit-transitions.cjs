// Real ChatRoomV2 exit-frame regression. Fake signaling/capture only; no live services.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const width = Number(process.env.COVE_UI_QA_WIDTH || 1440);
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || path.join(__dirname, '../../../tmp/share-exit-transitions'));
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.disableHardwareAcceleration();
const results = { runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, width, height: 900 }, checks: [], flows: {}, paints: {}, rendererErrors: [] };
const sourceRoot = path.resolve(process.env.COVE_UI_QA_SOURCE || path.join(__dirname, '../..'));
results.source = { root: sourceRoot, sha256: {} };
results.harnessSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
for (const name of ['src/styles/ui-v2.css', 'src/features/rooms/ChatRoomV2.tsx', 'src/features/rooms/useShareLayout.ts', 'src/features/rooms/useRoomController.ts', 'tests/ui/share-chat-qa.tsx'])
  results.source.sha256[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex');
const check = (condition, label) => results.checks.push({ passed: Boolean(condition), label });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Exit QA exceeded 120 seconds'); app.exit(2); }, 120000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height: 900, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'share-exit-transitions-isolated' } });
  win.webContents.setFrameRate(60);
  win.webContents.on('render-process-gone', (_event, details) => results.rendererErrors.push(details));
  let activePaints = null;
  win.webContents.on('paint', (_event, dirty, image) => {
    if (activePaints && activePaints.frames.length < 64)
      activePaints.frames.push({ elapsed: performance.now() - activePaints.started, dirty, image });
  });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async code => {
    for (let attempt = 0; attempt < 240; attempt++) { if (await js(code)) return; await delay(25); }
    throw new Error('Timed out: ' + code);
  };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
  const capture = async name => {
    const image = await win.webContents.capturePage();
    check(image.getSize().width === width && image.getSize().height === 900, name + ': actual viewport pixels');
    fs.writeFileSync(path.join(artifacts, name + '.png'), image.toPNG());
  };
  const record = async (name, action) => {
    activePaints = { started: performance.now(), frames: [] };
    try { results.flows[name] = await action(); }
    finally {
      const frames = activePaints.frames; activePaints = null;
      fs.mkdirSync(path.join(artifacts, name), { recursive: true });
      results.paints[name] = frames.map((frame, index) => {
        const file = `${name}/${String(index).padStart(2,'0')}-${Math.round(frame.elapsed)}ms.png`;
        fs.writeFileSync(path.join(artifacts, file), frame.image.toPNG());
        return { elapsed: frame.elapsed, dirty: frame.dirty, size: frame.image.getSize(), file };
      });
    }
    return results.flows[name];
  };
  const openShare = async (frameDelay = 0) => {
    await js(`window.shareChatQa.setNextShareFrameDelay(${frameDelay})`);
    await click('button[title="共享屏幕"]');
    await waitFor("Boolean(document.querySelector('.share-dialog .primary-wide'))");
    await click('.share-dialog .primary-wide');
    await waitFor("Boolean(document.querySelector('.mode-self'))");
    await delay(frameDelay ? 50 : 400);
  };
  const openRemote = async () => {
    await js('window.shareChatQa.restoreRemoteShare()');
    await waitFor(`Boolean(${button('观看共享')})`);
    await js(`${button('观看共享')}.click()`);
    await waitFor("Boolean(document.querySelector('.mode-watching'))");
    await delay(400);
  };
  const exit = async (name, actions, { focus = false } = {}) => {
    const outcome = await record(name, () => js(`(async () => {
      const originalChat=document.querySelector('.chat-panel');
      const originalComposer=originalChat.querySelector('textarea');
      const frames=[]; const started=performance.now();
      const actions=${JSON.stringify(actions)}; let index=0;
      const read=()=>{
        const shell=document.querySelector('.cove-shell'), rail=shell.querySelector('.navigation-rail');
        const workspace=shell.querySelector('.workspace'), slot=shell.querySelector('.chat-slot');
        const chat=slot.querySelector('.chat-panel'), input=chat.querySelector('textarea');
        const sr=shell.getBoundingClientRect(), rr=rail.getBoundingClientRect(), wr=workspace.getBoundingClientRect(), cr=chat.getBoundingClientRect();
        const style=getComputedStyle(slot), cs=getComputedStyle(shell), controls=shell.querySelector('.control-ball-anchor')?.getBoundingClientRect();
        const ordinary=!shell.matches('.mode-self,.mode-watching');
        if(ordinary&&${focus}) input.focus({preventScroll:true});
        const p={x:Math.max(cr.left,0)+Math.min(cr.width/2,100), y:Math.max(cr.top,0)+Math.min(cr.height/2,100)};
        const hit=document.elementFromPoint(p.x,p.y);
        const message=chat.querySelector('.message-text-content'), mr=message?.getBoundingClientRect();
        const mh=mr?document.elementFromPoint(mr.left+Math.min(mr.width/2,80),mr.top+mr.height/2):null;
        const messageReadable=!!message&&!!mr&&mr.width>0&&mr.height>0&&mr.left>=cr.left&&mr.right<=sr.right&&mr.top>=cr.top&&mr.bottom<=cr.bottom&&!!mh&&(message.contains(mh)||mh.contains(message))&&getComputedStyle(message).visibility==='visible';
        return {elapsed:performance.now()-started, ordinary, classes:shell.className,
          rail:rr.toJSON(), shell:sr.toJSON(), workspace:wr.toJSON(), chat:cr.toJSON(), memberWidth:parseFloat(cs.getPropertyValue('--member-width')),
          slotOpacity:Number(style.opacity), slotVisibility:style.visibility, slotTransform:style.transform, slotInert:slot.inert,
          slotAriaHidden:slot.getAttribute('aria-hidden'), chatHit:!!hit&&chat.contains(hit), messageReadable, messageRect:mr?.toJSON(),
          sameChat:chat===originalChat, sameComposer:input===originalComposer, composerFocused:document.activeElement===input,
          scroll:shell.scrollLeft, videoPresent:!!shell.querySelector('.video-content video'),
          memberPresent:!!shell.querySelector('.workspace-header'), controlsCenter:controls?controls.left+controls.width/2:null,
          shellTransition:cs.transition, slotTransition:style.transition};
      };
      const before=read();
      while(performance.now()-started<760){
        while(index<actions.length&&performance.now()-started>=actions[index].at){(0,eval)(actions[index].code);index++;}
        await new Promise(requestAnimationFrame);frames.push(read());
      }
      return {before,frames};
    })()`));
    const frames = outcome.frames.filter(frame => frame.ordinary);
    check(frames.length > 5, name + ': ordinary frames captured');
    check(frames.every(f => Math.abs(f.rail.width - (f.classes.includes('nav-wide') ? 280 : 72)) < 1), name + ': interrupted rail is at its endpoint from first ordinary frame');
    check(frames.every(f => Math.abs(f.workspace.width - f.memberWidth) < 1), name + ': member column correct from first ordinary frame');
    check(frames.every(f => Math.abs(f.workspace.left-f.rail.right)<1 && Math.abs(f.chat.left-f.workspace.right)<1 && Math.abs(f.chat.right-f.shell.right)<1), name + ': chat occupies remaining layout from first ordinary frame');
    check(frames.every(f => f.slotOpacity > .99 && f.slotVisibility==='visible' && !f.slotInert && f.slotAriaHidden==='false' && f.chatHit), name + ': chat visible and interactive from first ordinary frame');
    check(frames.every(f => f.messageReadable), name + ': history text readable and unobstructed from first ordinary frame');
    check(frames.every(f => f.slotTransform==='none'||f.slotTransform==='matrix(1, 0, 0, 1, 0, 0)'), name + ': no lingering chat slide after exit');
    check(frames.every(f => f.sameChat && f.sameComposer && f.scroll===0 && !f.videoPresent && f.memberPresent), name + ': stable chat nodes, members present, no stale video or scroll');
    if (focus) check(frames.every(f=>f.composerFocused), name + ': composer focus works immediately without scrolling');
    check(frames.every(f => Math.abs(f.controlsCenter-(f.rail.right+f.workspace.width/2))<1), name + ': controls centered from first ordinary frame');
    await capture(name + '-settled');
    return outcome;
  };
  try {
    await win.loadURL(process.env.COVE_UI_QA_URL || 'http://127.0.0.1:55173/tests/ui/share-chat-qa.html?layout-animation');
    await waitFor('Boolean(document.querySelector(\'button[title="加入语音"]\'))');
    await click('button[title="加入语音"]');
    await waitFor("Boolean(document.querySelector('.control-ball.voice-active'))");
    await delay(450); await capture('ordinary-before');
    await openShare(); await capture('sharing-before');
    await exit('localStopClosedChat', [{at:0,code:`${button('结束共享')}.click()`}], {focus:true});
    await openShare();
    await click('.chat-edge-toggle'); await delay(400);
    await js("document.querySelector('.chat-slot textarea').focus()");
    await exit('localStopOpenChat', [{at:0,code:`${button('结束共享')}.click()`}], {focus:true});
    await openShare(); await click('.chat-edge-toggle'); await delay(400);
    await exit('stopDuringChatClose', [{at:0,code:"document.querySelector('.chat-edge-toggle').click()"},{at:35,code:`${button('结束共享')}.click()`}], {focus:true});
    await openShare();
    await exit('stopDuringChatOpen', [{at:0,code:"document.querySelector('.chat-edge-toggle').click()"},{at:35,code:`${button('结束共享')}.click()`}], {focus:true});
    await openShare();
    await exit('rapidChatThenStop', [0,25,50,75].map(at=>({at,code:"document.querySelector('.chat-edge-toggle').click()"})).concat([{at:100,code:`${button('结束共享')}.click()`}]), {focus:true});
    await openShare();
    await exit('localTrackEnded', [{at:0,code:'window.shareChatQa.endLocalShareTrack()'}], {focus:true});
    await openShare(1500);
    await exit('pendingFirstFrameCancelled', [{at:0,code:`${button('结束共享')}.click()`}], {focus:true});
    await openRemote();
    await exit('viewerStopsWatching', [{at:0,code:`${button('结束观看')}.click()`}], {focus:true});
    await openRemote();
    await exit('remoteProducerStops', [{at:0,code:'window.shareChatQa.endRemoteShare()'}], {focus:true});
    await openRemote(); await click('.chat-edge-toggle'); await delay(400);
    await exit('remoteStopsDuringChatClose', [{at:0,code:"document.querySelector('.chat-edge-toggle').click()"},{at:35,code:'window.shareChatQa.endRemoteShare()'}], {focus:true});
    await openShare();
    await exit('stopDuringNavExpand', [{at:0,code:"document.querySelector('[aria-label=\"展开频道栏\"]').click()"},{at:70,code:`${button('结束共享')}.click()`}], {focus:true});
    await openShare();
    await exit('stopDuringNavCollapse', [{at:0,code:"document.querySelector('[aria-label=\"收回频道栏\"]').click()"},{at:70,code:`${button('结束共享')}.click()`}], {focus:true});
    await delay(400);
    // Re-enter before the old 340ms exit transition would have completed.
    await openShare();
    const rapid = await record('rapidStopReentry', () => js(`(async()=>{
      const frames=[],started=performance.now(); ${button('结束共享')}.click();
      await new Promise(requestAnimationFrame);
      document.querySelector('button[title="共享屏幕"]').click();
      await new Promise(requestAnimationFrame);
      document.querySelector('.share-dialog .primary-wide').click();
      while(performance.now()-started<650){await new Promise(requestAnimationFrame);const shell=document.querySelector('.cove-shell');if(!shell.matches('.mode-self'))continue;const rail=shell.querySelector('.navigation-rail').getBoundingClientRect(),work=shell.querySelector('.workspace').getBoundingClientRect();frames.push({width:work.width,expected:shell.getBoundingClientRect().right-rail.right,closed:shell.matches('.chat-closed'),inert:shell.querySelector('.chat-slot').inert,videoPresent:!!shell.querySelector('.video-content video')});}return frames;
    })()`));
    check(rapid.length>5&&rapid.every(f=>Math.abs(f.width-f.expected)<1&&f.closed&&f.inert&&f.videoPresent), 'rapidStopReentry: all share frames immediately full width, closed inert chat, video present');
    await exit('rapidReentryFinalStop', [{at:0,code:`${button('结束共享')}.click()`}], {focus:true});
    // Explicit channel navigation must retain its own continuous width/anchor motion.
    for (const mode of ['ordinary','sharing']) {
      if(mode==='sharing') await openShare();
      for(const expand of [true,false]) {
        const name=mode+(expand?'NavExpand':'NavCollapse');
        const nav=await record(name,()=>js(`(async()=>{
          const shell=document.querySelector('.cove-shell'),rail=shell.querySelector('.navigation-rail'),chat=shell.querySelector('.chat-panel'),video=shell.querySelector('.video-content video');
          const read=()=>{const r=rail.getBoundingClientRect(),w=shell.querySelector('.workspace').getBoundingClientRect(),a=shell.querySelector('.control-ball-anchor').getBoundingClientRect();return {railWidth:r.width,center:a.left+a.width/2,expected:w.left+w.width/2,sameChat:shell.querySelector('.chat-panel')===chat,sameVideo:shell.querySelector('.video-content video')===video};};
          const before=read(),frames=[],started=performance.now();document.querySelector('[aria-label="${expand?'展开频道栏':'收回频道栏'}"]').click();
          while(performance.now()-started<600){await new Promise(requestAnimationFrame);frames.push(read());}return {before,frames};
        })()`));
        check(nav.frames.filter(f=>f.railWidth>73&&f.railWidth<279).length>=2,name+': channel rail still animates continuously');
        // The existing rail (320ms) and dock (340ms) curves differ by up to 5.3px
        // in the delivered baseline. Preserve that smooth movement, not a snap.
        check(nav.frames.every(f=>Math.abs(f.center-f.expected)<6),name+': controls follow rail within existing timing offset, without a jump');
        check(nav.frames.every(f=>f.sameChat&&f.sameVideo),name+': chat and video nodes stay mounted');
        check(Math.abs(nav.frames.at(-1).railWidth-(expand?280:72))<1,name+': correct endpoint');
      }
      if(mode==='sharing') await exit('afterNavigationStop',[{at:0,code:`${button('结束共享')}.click()`}],{focus:true});
    }
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await openShare();
    await exit('reducedMotionStop', [{at:0,code:`${button('结束共享')}.click()`}], {focus:true});
    win.webContents.debugger.detach();
    check(results.rendererErrors.length===0, 'renderer stayed alive');
    const failed=results.checks.filter(c=>!c.passed);
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:failed.length===0,results},null,2));
    console.log(`${failed.length?'FAIL':'PASS'}: ${results.checks.length-failed.length}/${results.checks.length} checks; ${Object.keys(results.flows).length} flows`);
    if(failed.length) console.log(failed.map(c=>c.label).join('\n'));
    clearTimeout(timeout);win.destroy();app.exit(failed.length?1:0);
  } catch(error) {
    console.error(error); await capture('failure').catch(()=>{});
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),results},null,2));
    clearTimeout(timeout);win.destroy();app.exit(1);
  }
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(2)});
