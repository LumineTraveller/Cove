// Real owner hook, IPC, transparent window and Win32 geometry; synthetic content only.
const {app, BrowserWindow, ipcMain, screen, session, desktopCapturer} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const desktop = path.resolve(__dirname,'../..');
const artifacts = path.resolve(process.env.COVE_UI_QA_ARTIFACTS || path.join(desktop,'../../runtime/annotation-fix/overlay'));
fs.mkdirSync(artifacts,{recursive:true});
app.setPath('userData',path.join(artifacts,'electron-data'));
app.commandLine.appendSwitch('enable-features','AllowWgcScreenCapturer');
// The test entry lives below the app root. Production runs electron . instead.
app.getAppPath = () => desktop;
const checks = [], failures = [];
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const timeout = setTimeout(()=>app.exit(2),60000);
const {AnnotationOverlayController} = require('../../dist-electron/annotation-overlay');
app.whenReady().then(async()=>{
  let owner;
  const controller = new AnnotationOverlayController((token,reason)=>{
    failures.push(reason); owner?.webContents.send('cove:annotation-overlay:failure',{token,reason});
  }, (token,input)=>owner?.webContents.send('cove:annotation-overlay:input',{token,input}));
  const captioned = process.env.COVE_UI_QA_CAPTIONED === '1';
  const target = new BrowserWindow({x:120,y:120,width:640,height:360,frame:captioned,show:true,
    backgroundColor:'#ffffff',webPreferences:{sandbox:true}});
  await target.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:#fff;color:#164e63"><h1>Cove synthetic annotation target</h1><p>No personal screen is captured.</p><div style="width:100px;height:100px;background:#22c55e"></div></body>'));
  target.focus();
  const nativeHandle = win => win.getNativeWindowHandle().readBigUInt64LE().toString();
  const sources = await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}});
  const source = sources.find(item=>item.id.split(':')[1]===nativeHandle(target));
  if(!source)throw new Error('Synthetic capture source was not enumerated');
  const probe = new BrowserWindow({show:false,webPreferences:{offscreen:true,partition:'annotation-capture-probe'}});
  const probeSession = session.fromPartition('annotation-capture-probe');
  probeSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='media'));
  probeSession.setPermissionCheckHandler((_contents,permission)=>permission==='media');
  await probe.loadFile(path.join(__dirname,'annotation-capture-probe.html'));
  const capturedSize = await probe.webContents.executeJavaScript(`probeWindow(${JSON.stringify(source.id)})`,true);
  console.log('synthetic-window-capture',JSON.stringify(capturedSize));
  probe.destroy(); target.focus();
  controller.setCaptureSource(source);
  owner = new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,
    webPreferences:{offscreen:true,backgroundThrottling:false,preload:path.join(__dirname,'annotation-owner-preload.cjs'),partition:'overlay-owner-qa'}});
  owner.webContents.on('console-message',event=>{if(event.level>=2)console.error('renderer:',event.message);});
  const allowed = event => event.sender===owner.webContents && event.senderFrame===owner.webContents.mainFrame;
  ipcMain.handle('cove:annotation-overlay:bind',(event,id)=>allowed(event)?controller.bind(id):{error:'denied'});
  ipcMain.handle('cove:annotation-overlay:update',(event,token,frame)=>allowed(event)&&controller.update(token,frame));
  ipcMain.handle('cove:annotation-overlay:input-mode',(event,token,active)=>allowed(event)&&controller.setInputActive(token,active));
  ipcMain.on('cove:annotation-overlay:input',(event,token,input)=>{
    if(event.senderFrame===event.sender.mainFrame)controller.handleInput(event.sender,token,input);
  });
  ipcMain.handle('cove:annotation-overlay:close',(event,token)=>{if(!allowed(event))return false;controller.close(token);return true;});
  const js = code => owner.webContents.executeJavaScript(code,true);
  const wait = async (predicate,label) => {
    for(let i=0;i<160;i++){if(await predicate())return;await delay(25);}
    throw new Error('Timed out: '+label);
  };
  const check = (passed,label) => {checks.push({label,passed:Boolean(passed)});if(!passed)throw new Error(label);};
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  const overlay = () => BrowserWindow.getAllWindows().find(w=>w!==owner&&w!==target);
  const pixel = async (x,y) => overlay().webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas');return [...c.getContext('2d').getImageData(Math.round(c.width*${x}),Math.round(c.height*${y}),1,1).data]})()`);
  const start = async (allowed = true) => {
    await click('button[title="共享屏幕"]');
    await wait(()=>js("Boolean(document.querySelector('.share-dialog .primary-wide'))"),'share dialog');
    await click('.share-dialog .primary-wide');
    await wait(()=>js("document.querySelector('.video-content video')?.readyState>=2"),'synthetic share');
    await wait(()=>js(`window.shareChatQa.getAnnotationState()?.enabled === ${allowed}`),'saved annotation allowance');
    check(await js("!document.querySelector('.annotation-toolbar') && !document.querySelector('.annotation-owner-status')"),
      'fresh share permits peers without activating owner drawing input');
  };
  try {
    await owner.loadURL(process.env.COVE_UI_QA_URL || 'http://127.0.0.1:55473/tests/ui/share-chat-qa.html?layout-animation');
    await wait(()=>js("Boolean(document.querySelector('button[title=\"加入语音\"]'))"),'voice');
    await click('button[title="加入语音"]');
    await wait(()=>js("Boolean(document.querySelector('.control-ball.voice-active'))"),'voice active');
    await start();
    await js('window.shareChatQa.addPeerAnnotation()');
    target.setAlwaysOnTop(true); target.show(); target.moveTop(); target.focus();
    await wait(()=>Boolean(overlay()?.isVisible()),'local overlay visible');
    await wait(async()=>{const p=await pixel(.6,.4);return p[0]>200&&p[1]>150&&p[3]>100;},'painted viewer stroke');
    const rgba = await pixel(.6,.4);
    check(rgba[0]>200&&rgba[1]>150&&rgba[3]>100,'viewer stroke appears on the real local target overlay');
    const policy = spawnSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'annotation-window-policy.ps1'),'-Hwnd',nativeHandle(overlay())],{encoding:'utf8',windowsHide:true});
    if(policy.status!==0)throw new Error(policy.stderr);
    const flags = JSON.parse(policy.stdout.trim());
    const targetPolicy=spawnSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'annotation-window-policy.ps1'),'-Hwnd',nativeHandle(target)],{encoding:'utf8',windowsHide:true});
    console.log('target-native',targetPolicy.stdout.trim());
    check(flags.affinityRead&&flags.affinity===0x11,'Win32 excludes the overlay from desktop capture');
    check(flags.mouseTransparent&&flags.noActivate&&!overlay().isFocusable(),'native overlay passes mouse input and cannot steal keyboard focus');
    check(overlay().isAlwaysOnTop(),'overlay stays above the shared application');
    const targetBounds = target.getBounds(), overlayBounds = overlay().getBounds();
    const displayScale = screen.getDisplayMatching(overlayBounds).scaleFactor;
    const contentBounds = overlay().getContentBounds();
    console.log('geometry',JSON.stringify({targetBounds,overlayBounds,contentBounds,desired:controller.bounds,capturedSize,displayScale}));
    check(Math.abs(contentBounds.width*displayScale-capturedSize.width)<=3&&Math.abs(contentBounds.height*displayScale-capturedSize.height)<=3,
      'overlay content dimensions match actual synthetic WGC capture at the current DPI');
    fs.writeFileSync(path.join(artifacts,'local-overlay.png'),(await overlay().webContents.capturePage()).toPNG());
    target.setBounds({x:180,y:160,width:800,height:450});
    const movedPolicy=spawnSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'annotation-window-policy.ps1'),'-Hwnd',nativeHandle(target)],{encoding:'utf8',windowsHide:true});
    if(movedPolicy.status!==0)throw new Error(movedPolicy.stderr);
    const moved=JSON.parse(movedPolicy.stdout.trim());
    const expectedMoved=screen.screenToDipRect(null,{x:moved.origin.X,y:moved.origin.Y,
      width:moved.client.Right,height:moved.client.Bottom});
    const followsMoved=()=>Boolean(overlay())&&['x','y','width','height'].every(k=>Math.abs(overlay().getContentBounds()[k]-expectedMoved[k])<=2);
    await wait(followsMoved,'target resize');
    check(followsMoved(),'overlay follows the actual native client box after movement and resizing');
    target.minimize(); await wait(()=>!overlay()?.isVisible(),'minimized target');
    check(!overlay().isVisible(),'minimizing shared window hides annotations');
    target.restore(); target.focus(); await wait(()=>overlay()?.isVisible(),'restored target');
    await click('.share-operations-trigger'); await clickText('在共享屏幕绘画');
    await wait(()=>Boolean(controller.inputActive&&overlay()?.isFocused()),'native drawing mode');
    check(await js("!document.querySelector('.annotation-input-surface') && Boolean(document.querySelector('.annotation-owner-status'))"),
      'desktop owner has native input and no video-preview drawing canvas');
    const inputFlags=JSON.parse(spawnSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'annotation-window-policy.ps1'),'-Hwnd',nativeHandle(overlay())],{encoding:'utf8',windowsHide:true}).stdout.trim());
    check(!inputFlags.mouseTransparent&&overlay().isFocusable(),'native window receives mouse only in drawing mode');
    check(require('electron').globalShortcut.isRegistered('Control+Alt+Shift+A'),'emergency exit is armed before intercepting input');
    const nativeMouse=async(type,x,y)=>{
      const b=overlay().getContentBounds();
      overlay().webContents.sendInputEvent({type,x:Math.round(x*b.width),y:Math.round(y*b.height),...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
      await delay(50);
    };
    await nativeMouse('mouseMove',.2,.65);await nativeMouse('mouseDown',.2,.65);
    await nativeMouse('mouseMove',.4,.65);await nativeMouse('mouseUp',.4,.65);
    await wait(()=>js("window.shareChatQa.getAnnotationState().strokes.some(s=>s.authorSocketId==='qa-self'&&s.points.length>=2)"),'native complete stroke');
    const own=await js("window.shareChatQa.getAnnotationState().strokes.find(s=>s.authorSocketId==='qa-self')");
    check(Math.abs(own.points[0].x-.2)<.01&&Math.abs(own.points.at(-1).x-.4)<.01,
      'native source coordinates synchronize a continuous stroke through the production annotation hook');
    check(!controller.handleInput(owner.webContents,controller.token,{type:'clear'})&&
      !controller.handleInput(overlay().webContents,'stale-token',{type:'clear'})&&
      !controller.handleInput(overlay().webContents,controller.token,{type:'stroke-point',point:{x:1.1,y:.5}}),
      'foreign sender, stale session and outside-window points are rejected');
    await overlay().webContents.executeJavaScript("document.querySelector('[data-tool=laser]').click()");
    await nativeMouse('mouseMove',.55,.6);
    await wait(()=>controller.frame.lasers.length===1,'native laser point');
    check(Math.abs(controller.frame.lasers[0].x-.55)<.01,'native laser uses source coordinates without adding a stroke');
    await overlay().webContents.executeJavaScript("document.querySelector('[data-tool=eraser]').click();document.querySelector('#width').value='12'");
    await nativeMouse('mouseMove',.25,.65);await nativeMouse('mouseDown',.25,.65);
    await nativeMouse('mouseMove',.35,.65);await nativeMouse('mouseUp',.35,.65);
    await wait(async()=>Boolean((await js("window.shareChatQa.getAnnotationState().strokes.some(s=>s.tool==='eraser'&&s.points.length>=2)")))&&(await pixel(.3,.65))[3]<50,'native eraser replay');
    check((await pixel(.3,.65))[3]<50&&(await pixel(.6,.4))[3]>100,'native eraser removes only drawn annotation pixels');
    await overlay().webContents.executeJavaScript("document.querySelector('#clear').click()");
    await wait(()=>js("window.shareChatQa.getAnnotationState().strokes.length===0"),'native clear');
    check(Boolean(overlay()&&controller.inputActive),'clearing all marks keeps active native drawing available');
    await overlay().webContents.executeJavaScript("document.querySelector('[data-tool=pen]').click()");
    await nativeMouse('mouseMove',.2,.65);await nativeMouse('mouseDown',.2,.65);
    await nativeMouse('mouseMove',.4,.65);await nativeMouse('mouseUp',.4,.65);
    fs.writeFileSync(path.join(artifacts,'native-drawing-tools.png'),(await overlay().webContents.capturePage()).toPNG());
    overlay().webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    overlay().webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait(()=>!controller.inputActive,'native Escape exit');
    await wait(()=>js("!document.querySelector('.annotation-owner-status')"),'renderer tool exit');
    const exitFlags=JSON.parse(spawnSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'annotation-window-policy.ps1'),'-Hwnd',nativeHandle(overlay())],{encoding:'utf8',windowsHide:true}).stdout.trim());
    check(exitFlags.mouseTransparent&&!overlay().isFocusable()&&!require('electron').globalShortcut.isRegistered('Control+Alt+Shift+A'),
      'Escape restores native mouse pass-through and releases emergency shortcut');
    await click('.share-operations-trigger'); await clickText('在共享屏幕绘画');
    await wait(()=>controller.inputActive,'native exit button reentry');
    await overlay().webContents.executeJavaScript("document.querySelector('#exit').click()");
    await wait(()=>!controller.inputActive,'native exit button');
    check(!overlay().isFocusable(),'visible exit button restores native pass-through');
    await js('window.shareChatQa.addPeerAnnotation()');
    // The read-only window mirror follows the foreground source. Windows may
    // activate another app when the drawing window gives up focus on exit.
    target.focus(); await wait(()=>overlay()?.isVisible(),'refocused shared window mirror');
    check(Boolean(overlay()?.isVisible()),'owner exits tools and the foreground shared window keeps its mirror');
    await click('.share-operations-trigger'); await clickText('在共享屏幕绘画');
    await wait(()=>controller.inputActive,'drawing reentry');
    await click('.share-operations-trigger'); await click('[aria-label="允许批注"]');
    await wait(()=>!overlay(),'session disabled');
    check(!overlay(),'disabling the authorized session removes the overlay');
    check(!controller.inputActive&&!require('electron').globalShortcut.isRegistered('Control+Alt+Shift+A'),
      'global disable immediately restores mouse input and releases shortcuts');
    await js('window.shareChatQa.endLocalShareTrack()');
    await wait(()=>js("!document.querySelector('.mode-self')"),'disabled share end');
    controller.setCaptureSource(source);await start(false);
    await click('.share-operations-trigger');
    check(await js("[...document.querySelectorAll('.share-operations-popover button')].find(b=>b.textContent.trim()==='在共享屏幕绘画').disabled"),
      'saved off persists across share restart and drawing does not reopen it');
    await click('[aria-label="允许批注"]');
    await wait(()=>js("window.shareChatQa.getAnnotationState().enabled"),'explicit allowance');
    await js('window.shareChatQa.addPeerAnnotation()');
    await wait(()=>Boolean(overlay()),'reenabled session');
    await clickText('在共享屏幕绘画');await wait(()=>controller.inputActive,'active track-end mode');
    await js('window.shareChatQa.endLocalShareTrack()');
    await wait(()=>!overlay(),'share stopped');
    check(!overlay(),'track-ended removes the native overlay');
    check(!controller.inputActive&&!require('electron').globalShortcut.isRegistered('Control+Alt+Shift+A'),
      'track-ended restores mouse input and releases shortcuts');
    controller.setCaptureSource(source);
    await start();
    check((await js('window.shareChatQa.getAnnotationState().strokes.length'))===0,'restart begins a fresh producer with no old drawings');
    await js('window.shareChatQa.addPeerAnnotation()');
    await wait(()=>Boolean(overlay()),'new overlay');
    target.close(); await wait(()=>!overlay(),'target close');
    check(!overlay(),'closing the captured window disposes geometry and overlay');
    check(failures.length===0,'normal source cleanup produces no native failure notification');
    const displays = screen.getAllDisplays();
    const display = displays[displays.length-1];
    controller.setCaptureSource({id:'screen:qa:0',display_id:String(display.id)});
    const first = controller.bind('producer-a').token, second = controller.bind('producer-b').token;
    const frame = {strokes:[{id:'s',authorSocketId:'qa',tool:'pen',color:'#3b82f6',width:.01,points:[{x:.2,y:.5},{x:.8,y:.5}]}],lasers:[]};
    check(!controller.update(first,frame),'stale session cannot draw over a replacement capture');
    controller.close(first);
    check(controller.update(second,frame),'stale cleanup cannot close the new session');
    await wait(()=>Boolean(overlay()?.isVisible()),'display overlay');
    check(['x','y','width','height'].every(k=>Math.abs(overlay().getContentBounds()[k]-display.bounds[k])<2),
      'screen overlay uses the selected display bounds at the current DPI');
    controller.close(second); check(!overlay(),'explicit share cleanup removes display overlay');
    const binding = controller.bind('producer-c');
    controller.update(binding.token,frame);
    await wait(()=>Boolean(overlay()),'close-owner overlay');
    owner.on('closed',()=>controller.setCaptureSource(null));
    owner.destroy(); check(!overlay(),'main window close removes overlay');
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks,failures,captioned,capturedSize,
      nativePolicy:flags,windowGeometry:{targetBounds,overlayBounds,contentBounds,displayScale},
      displays:displays.map(d=>({bounds:d.bounds,scaleFactor:d.scaleFactor}))},null,2));
    console.log(`PASS ${checks.length} native annotation overlay checks`);
    clearTimeout(timeout);app.exit(0);
  } catch(error) {
    const nativeState={targetFocused:!target.isDestroyed()&&target.isFocused(),bounds:controller.bounds,
      loaded:controller.loaded,source:controller.source,hasWindow:Boolean(overlay()),failed:controller.failed};
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,failures,nativeState},null,2));
    console.error('native-state',JSON.stringify(nativeState));
    console.error(error);controller.close();owner.destroy();if(!target.isDestroyed())target.destroy();clearTimeout(timeout);app.exit(1);
  }
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(2);});
