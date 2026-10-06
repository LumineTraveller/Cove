const {app,BrowserWindow,ipcMain,globalShortcut}=require('electron');
const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{once}=require('events'),assert=require('assert/strict');
require('tsx/cjs');
const {createServer}=require('http'),{Server}=require('socket.io');
const root=path.resolve(__dirname,'..'),appRoot=path.join(root,'apps/desktop'),out=path.join(root,'runtime/remote-input-live');
const label=process.env.COVE_LIVE_LABEL||'normal';
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.setPath('sessionData',path.join(out,'session'));app.setAppPath(appRoot);
const {RemoteControlRegistry}=require('../apps/server/src/features/remote-control/remoteControl.ts');
const {registerRemoteControlSocketHandlers}=require('../apps/server/src/features/remote-control/socketHandlers.ts');
 const journal=[];const stamp=()=>performance.timeOrigin+performance.now();
const cp=require('child_process'),originalSpawn=cp.spawn;
cp.spawn=function(file,args,options){if(path.basename(String(file))==='remote-input-helper.exe')args=[...args,'--diagnostic'];const child=originalSpawn.call(this,file,args,options);if(path.basename(String(file))==='remote-input-helper.exe'){
 const write=child.stdin.write.bind(child.stdin);child.stdin.write=(line,...rest)=>{const command=JSON.parse(line);journal.push({stage:'pipe',at:stamp(),...command});return write(line,...rest)};
 child.stdout.on('data',data=>{for(const line of data.toString().trim().split('\n'))try{journal.push({stage:'native',at:stamp(),...JSON.parse(line)})}catch{}});
 }return child;};
const {RemoteInputController}=require('../apps/desktop/dist-electron/remote-control.js');
const failures=[];const native=new RemoteInputController(reason=>failures.push(reason));let boundaryOnly=false;let emergencyAt=null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const stat=a=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return{count:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)}};
app.whenReady().then(async()=>{
 let control,sharer,observer,relay,http;const watchdog=setTimeout(()=>app.exit(2),25000);
 try{
  observer=spawn(path.join(root,'runtime/remote-input-windows-probe.exe'),['--observe',path.join(out,`windows-${label}.json`)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const closed=once(observer,'close');let buffered='';const bounds=await new Promise((resolve,reject)=>{observer.stdout.on('data',data=>{buffered+=data.toString();if(buffered.includes('\n'))resolve(JSON.parse(buffered.split('\n')[0]))});observer.on('error',reject)});
  http=createServer();relay=new Server(http);await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const port=http.address().port;
  const registry=new RemoteControlRegistry(),members=new Map([['owned',new Set()]]),caps=new Set(),names=new Map(),roles=new Map();
  let resolveStarted;const started=new Promise(resolve=>resolveStarted=resolve);
  relay.on('connection',socket=>{
   members.get('owned').add(socket.id);caps.add(socket.id);
   registerRemoteControlSocketHandlers({socket,io:relay,roomMembers:members,remoteControlCapabilities:caps,remoteControls:registry,
    isSharingScreen:()=>true,isRemoteControlAllowed:()=>true,userNames:names,publicUserId:id=>id,
    emitRemoteRequestCancelled:()=>{},emitRemoteControlStopped:(s,reason)=>{relay.to(s.controllerSocketId).emit('remote-control:stopped',{sessionId:s.sessionId,reason});relay.to(s.sharerSocketId).emit('remote-control:stopped',{sessionId:s.sessionId,reason});}});
   socket.on('remote-control:input',({input})=>journal.push({stage:'server',at:stamp(),...input}));
   socket.on('probe:ready',role=>{roles.set(role,socket.id);if(roles.size===2){const request=registry.createRequest('owned',roles.get('controller'),roles.get('sharer'));const accepted=registry.respond(request.value.requestId,roles.get('sharer'),true);const session=accepted.value.session;
    for(const r of ['sharer','controller'])relay.to(roles.get(r)).emit('remote-control:started',{sessionId:session.sessionId,roomId:'owned',role:r});resolveStarted();}});
  });
  sharer=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,preload:path.join(__dirname,'remote-input-live-preload.cjs')}});
  control=new BrowserWindow({x:20,y:40,width:480,height:300,frame:false,show:!process.env.COVE_LIVE_OFFSCREEN_FPS,webPreferences:{backgroundThrottling:false,offscreen:!!process.env.COVE_LIVE_OFFSCREEN_FPS}});
  if(process.env.COVE_LIVE_OFFSCREEN_FPS)control.webContents.setFrameRate(Number(process.env.COVE_LIVE_OFFSCREEN_FPS));
  ipcMain.handle('probe:active',async(event,id)=>{
   if(event.sender!==sharer.webContents)return{ok:false,reason:'foreign'};
   if(id!==null&&!globalShortcut.isRegistered('Control+Alt+Shift+X'))if(!globalShortcut.register('Control+Alt+Shift+X',()=>{emergencyAt=stamp();native.stop();sharer.webContents.send('probe:emergency','emergency')}))return{ok:false,reason:'shortcut'};
   const ok=await native.setActive(id);if(id===null)globalShortcut.unregister('Control+Alt+Shift+X');return{ok};
  });
  ipcMain.handle('probe:input',(event,id,input)=>{if(event.sender!==sharer.webContents)return false;journal.push({stage:'ipc',at:stamp(),...input});if(boundaryOnly)return true;return native.send(id,input)});
  const url=`http://127.0.0.1:${process.env.COVE_LIVE_VITE_PORT||55179}/tests/ui/remote-input-live.html?relay=${port}`;
  await Promise.all([sharer.loadURL(url+'&role=sharer'),control.loadURL(url+'&role=controller&baseline=true')]);await started;
  await delay(600);observer.stdin.write('start\n');
  const results=[];
  for(const baseline of [true,false]){
   if(!baseline){await control.webContents.executeJavaScript('liveProbe.lifecycle.stop()');await delay(100);await sharer.webContents.executeJavaScript("liveProbe.lifecycle.expectStart('sharer')");roles.delete('controller');await control.loadURL(url+'&role=controller&baseline=false');await delay(500);}
   await control.webContents.executeJavaScript('liveProbe.rows.length=0');await delay(80);
   const begin=stamp();const targetY=bounds.bounds.top+(baseline?120:240);const y=Math.round(targetY/bounds.screenHeight*300);
   for(let i=0;i<150;i++){
    const due=begin+i*8;while(stamp()<due)await delay(1);
    const cycle=i%100;const px=bounds.bounds.left+80+(cycle<50?cycle:100-cycle)*10;const x=Math.round(px/bounds.screenWidth*480);
    journal.push({stage:'driver',at:stamp(),index:i,x,y,baseline});control.webContents.sendInputEvent({type:'mouseMove',x,y});
   }await delay(100);
   const origin=await control.webContents.executeJavaScript('performance.timeOrigin');
   const rows=(await control.webContents.executeJavaScript('liveProbe.rows')).map(row=>({...row,at:row.at+origin}));
   const pipeline=journal.filter(r=>r.at>=begin&&r.stage!=='driver');const sent=rows.filter(r=>r.stage==='sent'&&r.type==='pointer');
   boundaryOnly=true;await control.webContents.executeJavaScript('liveProbe.rows.length=0');
   for(const x of [160,200,240]){control.webContents.sendInputEvent({type:'mouseMove',x,y:10});await delay(25);}
   const topInputs=await control.webContents.executeJavaScript('liveProbe.rows.filter(row=>row.stage===\'sent\').length');boundaryOnly=false;
   results.push({baseline,begin,rows,pipeline,summary:{sent:sent.length,topInputs,sendGapMs:stat(sent.slice(1).map((r,i)=>r.at-sent[i].at)),pipe:pipeline.filter(r=>r.stage==='pipe'&&r.type==='pointer').length,ipc:pipeline.filter(r=>r.stage==='ipc').length,
    topHit:await control.webContents.executeJavaScript("({tag:document.elementFromPoint(200,10)?.tagName,className:document.elementFromPoint(200,10)?.className})"),greenFrames:await control.webContents.executeJavaScript("document.querySelectorAll('.remote-control-frame').length")}});
  }
  const last=journal.filter(r=>r.stage==='pipe'&&r.type==='pointer').at(-1);
  boundaryOnly=true;
  await control.webContents.executeJavaScript("liveProbe.rows.length=0;document.querySelector('.remote-video-surface').dispatchEvent(new PointerEvent('pointerrawupdate',{pointerType:'mouse',clientX:210,clientY:120,bubbles:true}));document.querySelector('.remote-video-surface').dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:210,clientY:120,bubbles:true}));");
  await delay(30);
  const rawWithoutDuplicate=await control.webContents.executeJavaScript("liveProbe.rows.filter(row=>row.stage==='sample').length");
  await control.webContents.executeJavaScript('liveProbe.setActive(false)');await delay(30);
  await control.webContents.executeJavaScript("liveProbe.rows.length=0;document.querySelector('.remote-video-surface').dispatchEvent(new PointerEvent('pointerrawupdate',{pointerType:'mouse',clientX:220,clientY:120,bubbles:true}));");await delay(30);
  const inactiveSamples=await control.webContents.executeJavaScript("liveProbe.rows.filter(row=>row.stage==='sample').length");
  await control.webContents.executeJavaScript('liveProbe.setActive(true)');await delay(30);boundaryOnly=false;
  if(bounds.initialHeld)throw Error('Physical key/button interference: '+bounds.initialHeld);
  // Real drag/Shift hold and actual registered Windows emergency hotkey. The
  // target remains inside the owned native form, never a user application.
  await control.webContents.executeJavaScript(`liveProbe.lifecycle.send({type:'button',button:'left',down:true,x:${last.x},y:${last.y}});liveProbe.lifecycle.send({type:'key',code:'ShiftLeft',down:true});`);
  await delay(30);
  await control.webContents.executeJavaScript("for(const code of ['ControlLeft','AltLeft','KeyX'])liveProbe.lifecycle.send({type:'key',code,down:true})");
  await delay(100);
  if(emergencyAt===null)throw Error('Actual Windows emergency hotkey did not fire');
  await control.webContents.executeJavaScript('liveProbe.lifecycle.stop()');await delay(100);
  const rejectedAfterStop=await sharer.webContents.executeJavaScript(`probeBridge.sendInput('revoked-session',{type:'pointer',x:.5,y:.5})`);
  await closed;const windows=JSON.parse(fs.readFileSync(path.join(out,`windows-${label}.json`),'utf8'));
  assert.equal(failures.length,0);assert.equal(rejectedAfterStop,false);assert.equal(windows.finalHeld,'');
  assert.equal(rawWithoutDuplicate,1);assert.equal(inactiveSamples,0);
  assert.equal(results[0].summary.topInputs,0);assert.equal(results[1].summary.topInputs,3);
  assert.equal(results[1].summary.topHit.tag,'VIDEO');assert.equal(results[1].summary.greenFrames,0);
  if(process.env.COVE_LIVE_OFFSCREEN_FPS)assert.ok(results[1].summary.sent>results[0].summary.sent*2);
  for(const result of results){for(const command of result.pipeline.filter(row=>row.stage==='pipe'&&row.type==='pointer')){
   const ack=result.pipeline.find(row=>row.stage==='native'&&row.seq===command.seq);
   assert.ok(ack&&!ack.suppressed);assert.ok(Math.abs(ack.cursorX-Math.round(command.x*(bounds.screenWidth-1)))<=1);
   assert.ok(Math.abs(ack.cursorY-Math.round(command.y*(bounds.screenHeight-1)))<=1);
  }}
  const report={passed:true,observedUTC:new Date().toISOString(),label,offscreenRenderingFps:Number(process.env.COVE_LIVE_OFFSCREEN_FPS)||null,scope:'actual React component, trusted Chromium input, original authorized Socket.IO relay, renderer IPC, original controller/queue and production SendInput; same machine, no WAN or video capture latency',failures,rejectedAfterStop,rawWithoutDuplicate,inactiveSamples,emergencyAt,finalHeld:windows.finalHeld,keyChanges:windows.keyChanges,
   results:results.map(r=>r.summary),lastTarget:last,windowsChanges:windows.rows.length};
  fs.writeFileSync(path.join(out,`result-${label}.json`),JSON.stringify({report,results,journal,bounds},null,2));console.log(JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'controller.png'),(await control.webContents.capturePage()).toPNG());
 }finally{native.stop();globalShortcut.unregisterAll();control?.destroy();sharer?.destroy();if(relay)await new Promise(resolve=>relay.close(resolve));clearTimeout(watchdog);app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
