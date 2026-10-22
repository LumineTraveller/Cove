const {app,BrowserWindow,session}=require('electron');
const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..');
const testIce=process.argv.includes('--ice-restart');
const {createLoopbackMediaProxy}=require(path.join(root,'tooling/loopback-media-proxy.cjs'));
if(!process.env.COVE_TEST_NODE)throw new Error('COVE_TEST_NODE must name the standalone Node runtime (not Electron).');
const renderer=new URL(process.env.COVE_QA_RENDERER_URL||'http://127.0.0.1:55173');
if(renderer.protocol!=='http:'||renderer.hostname!=='127.0.0.1'||renderer.username||renderer.password||renderer.pathname!=='/'||renderer.search||renderer.hash)
  throw new Error('COVE_QA_RENDERER_URL must be a loopback HTTP origin');
const temp=fs.mkdtempSync(path.join(root,'runtime','electron-media-'));app.setPath('userData',temp);
const resultPath=path.join(root,'runtime',testIce?'ice-restart-integration-result.json':'media-integration-result.json');
const runId=require('node:crypto').randomUUID();const startedAt=new Date().toISOString();
fs.writeFileSync(resultPath,JSON.stringify({passed:false,status:'running',runId,startedAt},null,2));
// Keep the process alive until owned backend cleanup and result persistence finish.
app.on('window-all-closed',()=>{});
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const backend=spawn(process.env.COVE_TEST_NODE,[path.join(root,'tooling/runtime-smoke.cjs'),'--hold'],{cwd:root,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
const ready=new Promise((resolve,reject)=>{backend.on('message',message=>{if(message?.type==='ready')resolve(message);});backend.once('error',reject);backend.once('exit',code=>reject(new Error('Backend exited '+code)));});
const windows=[];let finished=false;let failure=null;let proxy=null;let iceEvidence=null;
async function finish(code){
  if(finished)return;finished=true;for(const win of windows)if(!win.isDestroyed())win.destroy();
  if(proxy)await proxy.close();
  if(backend.exitCode===null){
    await new Promise(resolve=>{
      const kill=setTimeout(()=>backend.kill(),5000);
      const deadline=setTimeout(resolve,10000);
      backend.once('exit',()=>{clearTimeout(kill);clearTimeout(deadline);resolve();});
      if(backend.connected)backend.send({type:'stop'},error=>{if(error)backend.kill();});
      else backend.kill();
    });
  }
  const cleaned=backend.exitCode!==null;
  const passed=code===0&&cleaned;
  fs.writeFileSync(resultPath,JSON.stringify({
    passed,status:'completed',runId,startedAt,finishedAt:new Date().toISOString(),backendStopped:cleaned,error:failure,
    scope:'two real Chromium peers; synthetic devices; VP8; decoded frame; short signal recovery; independent screen teardown',
    endToEndLatencyMeasured:false,
    ...(testIce?{iceEvidence}:{}),
  },null,2));
  app.exit(passed?0:1);
}
const watchdog=setTimeout(()=>{failure='Media regression timed out';console.error(failure);void finish(1);},90000);
async function waitFor(win,code){for(let attempt=0;attempt<240;attempt++){if(await win.webContents.executeJavaScript(code))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+code);}
app.whenReady().then(async()=>{
  try{
    const info=await ready;
    if(testIce)proxy=await createLoopbackMediaProxy(41020);
    session.defaultSession.setPermissionRequestHandler((_wc,permission,done)=>done(permission==='media'));
    session.defaultSession.setPermissionCheckHandler((_wc,permission)=>permission==='media');
    for(let index=0;index<2;index++){
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});windows.push(win);win.webContents.setAudioMuted(true);
      win.webContents.on('console-message',(_event,_level,message)=>{if(message.includes('Error')||message.includes('error')||message.includes('[media-recovery]'))console.log('[renderer]',message);});
      const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index)});
      if(testIce&&index===1)query.set('iceProxy',String(proxy.port));
      await win.loadURL(renderer.origin+'/tests/ui/media-integration.html?'+query);
      await waitFor(win,'Boolean(window.coveMediaQA?.ready)');
      await win.webContents.executeJavaScript('window.coveMediaQA.rtc.joinVoice()');
      await waitFor(win,'Boolean(window.coveMediaQA.rtc.inVoice)');
    }
    for(const win of windows)await waitFor(win,'window.coveMediaQA.rtc.voiceMembers.length===2');
    const [sender,viewer]=windows;
    await sender.webContents.executeJavaScript("window.coveMediaQA.rtc.startScreenShare('1080p',30,false,false,true,true)");
    await waitFor(sender,'Boolean(window.coveMediaQA.rtc.localScreen)');
    await waitFor(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');
    await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');
    await waitFor(viewer,'document.querySelector("video").videoWidth===640&&document.querySelector("video").readyState>=2');
    const pixel=await viewer.webContents.executeJavaScript('(()=>{const c=document.createElement("canvas");c.width=1;c.height=1;c.getContext("2d").drawImage(document.querySelector("video"),0,0,1,1);return [...c.getContext("2d").getImageData(0,0,1,1).data]})()');
    assert.ok(pixel[0]+pixel[1]+pixel[2]>100,'remote frame must not be black');
    await sender.webContents.executeJavaScript('window.coveMediaQA.rtc.toggleStats()');
    await waitFor(sender,'window.coveMediaQA.rtc.stats.codec==="VP8"');
    if(testIce){
      const before=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.snapshot()');
      const recv=before.find(t=>t.direction==='recv');
      assert.ok(recv&&recv.consumers.length>=2,'viewer receives voice and screen');
      await waitFor(viewer,'window.coveMediaQA.ice.audioProgress().then(a=>a.packets>5)');
      const audioBefore=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.toggleMute()');
      await waitFor(viewer,'window.coveMediaQA.rtc.isMuted');
      proxy.setBlocked(true);
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&["disconnected","failed"].includes(t.state))');
      const blockedFrames=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.decodedFrames()');
      const blockedAudio=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.restartCalls>0)');
      proxy.setBlocked(false);
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.state==="connected")');
      await waitFor(viewer,`window.coveMediaQA.ice.decodedFrames().then(n=>n>${blockedFrames}+2)`);
      await waitFor(viewer,`window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${blockedAudio.packets}+2&&a.samples>${blockedAudio.samples})`);
      const audioAfter=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      const after=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.snapshot()');
      const restarted=after.find(t=>t.id===recv.id);
      assert.ok(restarted?.credentialsChanged,'real SFU restart must change the ICE username fragment');
      assert.deepEqual(restarted.consumers,recv.consumers,'restart must retain consumers');
      assert.deepEqual(after.flatMap(t=>t.producers.map(p=>p.id)),before.flatMap(t=>t.producers.map(p=>p.id)),'restart must retain producers');
      assert.equal(await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.inVoice&&window.coveMediaQA.rtc.isMuted&&Boolean(window.coveMediaQA.rtc.remoteScreen)'),true);
      iceEvidence={fault:'owned loopback TCP proxy stalls actual RTP/STUN forwarding',interruptedConnections:proxy.counts().interruptedConnections,
        restartCalls:restarted.restartCalls,credentialsChanged:true,transportRetained:true,consumersRetained:true,
        producersRetained:true,muteRetained:true,watchRetained:true,decodedFramesResumed:true,
        syntheticAudioPacketsAndSamplesResumed:true,
        nonSilentAudioDecodeVerified:audioBefore.energy>0&&audioAfter.energy>blockedAudio.energy,
        speakerAudibilityMeasured:false};
      assert.ok(iceEvidence.interruptedConnections>0);
    }
    const recovery=await viewer.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const socket=window.coveMediaQA.socket;const id=socket.id;
      const timer=setTimeout(()=>reject(new Error('Synthetic reconnect timed out')),8000);
      socket.once('connect',()=>{clearTimeout(timer);resolve({sameId:socket.id===id,recovered:socket.recovered});});
      socket.io.engine.close();
    })`);
    assert.equal(recovery.sameId,true,'short outage must retain the server session');
    assert.equal(recovery.recovered,true,'loopback transport must report recovered session');
    if(testIce){const calls=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.snapshot().filter(t=>t.direction==="recv").reduce((n,t)=>n+t.restartCalls,0)');assert.equal(calls,iceEvidence.restartCalls,'healthy media signal loss must not restart ICE');}
    await waitFor(viewer,'window.coveMediaQA.rtc.inVoice&&Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector("video").readyState>=2');
    await sender.webContents.executeJavaScript('window.coveMediaQA.rtc.stopScreenShare()');
    await waitFor(viewer,'!window.coveMediaQA.rtc.remoteScreen');
    for(const win of windows)assert.equal(await win.webContents.executeJavaScript('window.coveMediaQA.rtc.inVoice'),true,'stopping screen must preserve voice');
    for(const win of windows)await win.webContents.executeJavaScript('window.coveMediaQA.rtc.leaveVoice()');
    console.log('PASS: two real Chromium/WebRTC peers, synthetic mic/video, negotiated VP8, non-black decoded frame, short transport recovery and independent screen teardown.');
    clearTimeout(watchdog);await finish(0);
  }catch(error){failure=error.stack||String(error);console.error(error);clearTimeout(watchdog);await finish(1);}
});
