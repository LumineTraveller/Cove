const {app,BrowserWindow,session}=require('electron');
const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..');
const {runRecoverySoak}=require(path.join(root,'tooling/recovery-soak-scenarios.cjs'));
const {runRecoveryBrowserScenarios}=require(path.join(root,'tooling/recovery-browser-scenarios.cjs'));
const testIce=process.argv.includes('--ice-restart');
const protocol=process.env.COVE_QA_PROTOCOL==='udp'?'udp':'tcp';const soakSeconds=Number(process.env.COVE_QA_SOAK_SECONDS||0);
if(!Number.isInteger(soakSeconds)||soakSeconds<0||soakSeconds>3600)throw new Error('Invalid bounded soak duration');
if(process.env.COVE_QA_RESULT_PATH){const relative=path.relative(path.join(root,'runtime'),path.resolve(process.env.COVE_QA_RESULT_PATH));if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Acceptance results must stay inside this checkout runtime directory');}
const {createLoopbackMediaProxy}=require(path.join(root,'tooling/loopback-media-proxy.cjs'));
if(!process.env.COVE_TEST_NODE)throw new Error('COVE_TEST_NODE must name the standalone Node runtime (not Electron).');
const renderer=new URL(process.env.COVE_QA_RENDERER_URL||'http://127.0.0.1:55173');
if(renderer.protocol!=='http:'||renderer.hostname!=='127.0.0.1'||renderer.username||renderer.password||renderer.pathname!=='/'||renderer.search||renderer.hash)
  throw new Error('COVE_QA_RENDERER_URL must be a loopback HTTP origin');
const reportDirectory=process.env.COVE_QA_RESULT_PATH?path.dirname(process.env.COVE_QA_RESULT_PATH):path.join(root,'runtime');
const temp=fs.mkdtempSync(path.join(reportDirectory,'electron-media-'));app.setPath('userData',temp);
// Deterministic PCM input, not Chromium's unspecified fake-device signal and
// never the physical microphone. A changing envelope avoids a stationary NS tone.
const sampleRate=48000;const sampleCount=sampleRate*4;const pcm=Buffer.alloc(sampleCount*2);let squared=0;let peak=0;
for(let i=0;i<sampleCount;i++){
  const t=i/sampleRate;const envelope=.15+.2*(.5+.5*Math.sin(2*Math.PI*3*t));
  const sample=envelope*(Math.sin(2*Math.PI*440*t)+.3*Math.sin(2*Math.PI*660*t));
  pcm.writeInt16LE(Math.round(sample*32767),i*2);squared+=sample*sample;peak=Math.max(peak,Math.abs(sample));
}
const wav=Buffer.alloc(44);wav.write('RIFF');wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*2,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);
const fakeAudioFile=path.join(temp,'microphone.wav');fs.writeFileSync(fakeAudioFile,Buffer.concat([wav,pcm]));
const syntheticAudioInput={type:'generated PCM WAV',sampleRate,channels:1,seconds:4,rms:Math.sqrt(squared/sampleCount),peak};
const resultPath=process.env.COVE_QA_RESULT_PATH||path.join(root,'runtime',testIce?'ice-restart-integration-result.json':'media-integration-result.json');
const runId=require('node:crypto').randomUUID();const startedAt=new Date().toISOString();
fs.writeFileSync(resultPath,JSON.stringify({passed:false,status:'running',runId,startedAt},null,2));
// Keep the process alive until owned backend cleanup and result persistence finish.
app.on('window-all-closed',()=>{});
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture',fakeAudioFile);
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
if(protocol==='udp')app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
const backend=spawn(process.env.COVE_TEST_NODE,[process.env.COVE_QA_BACKEND_MODULE||path.join(root,'tooling/runtime-smoke.cjs'),'--hold'],{cwd:root,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
const ready=new Promise((resolve,reject)=>{backend.on('message',message=>{if(message?.type==='ready')resolve(message);});backend.once('error',reject);backend.once('exit',code=>reject(new Error('Backend exited '+code)));});
const windows=[];let finished=false;let failure=null;let proxy=null;let iceEvidence=null;let soakEvidence=null;let extraEvidence=null;const audioEvidence={syntheticAudioInput};
let requestSequence=0;
function backendRequest(type){return new Promise((resolve,reject)=>{const requestId=++requestSequence;const timer=setTimeout(()=>{backend.off('message',receive);reject(Error('Backend IPC timeout: '+type));},15000);function receive(message){if(message?.requestId!==requestId)return;clearTimeout(timer);backend.off('message',receive);if(message.type==='backend-error')reject(Error(message.error));else resolve(message);}backend.on('message',receive);backend.send({type,requestId});});}
async function finish(code){
  if(finished)return;finished=true;clearTimeout(watchdog);
  // Let our synthetic Socket.IO clients finish their close handshake before
  // destroying renderers; an abrupt webContents teardown creates ws close timers.
  for(const win of windows)if(!win.isDestroyed())try{await win.webContents.executeJavaScript('window.coveMediaQA?.rtc.leaveVoice();window.coveMediaQA?.socket.disconnect()');}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
  for(const win of windows)if(!win.isDestroyed())win.destroy();
  const proxyCounts=proxy?.counts();
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
    audioEvidence,
    proxyCounts,
    soakEvidence,extraEvidence,
    ports:{renderer:Number(renderer.port),media:Number(process.env.COVE_QA_MEDIA_PORT||41020),proxy:proxy?.port??null},
    ...(testIce?{iceEvidence}:{}),
  },null,2));
  app.exit(passed?0:1);
}
const watchdog=setTimeout(()=>{failure='Media regression timed out';console.error(failure);void finish(1);},(soakSeconds+210)*1000);
async function waitFor(win,code,timeoutMs=24000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await win.webContents.executeJavaScript(code))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+code);}
app.whenReady().then(async()=>{
  try{
    const info=await ready;
    if(testIce)proxy=await createLoopbackMediaProxy(Number(process.env.COVE_QA_MEDIA_PORT||41020),protocol);
    session.defaultSession.setPermissionRequestHandler((_wc,permission,done)=>done(permission==='media'));
    session.defaultSession.setPermissionCheckHandler((_wc,permission)=>permission==='media');
    for(let index=0;index<2;index++){
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});windows.push(win);
      win.webContents.on('console-message',(_event,_level,message)=>{if(message.includes('Error')||message.includes('error')||message.includes('[media-recovery]')||message.includes('[mic-uplink]'))console.log('[renderer]',message);});
      const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index)});
      if(testIce&&index===1){query.set('iceProxy',String(proxy.port));query.set('iceProtocol',protocol);}
      await win.loadURL(renderer.origin+'/tests/ui/media-integration.html?'+query);
      await waitFor(win,'Boolean(window.coveMediaQA?.ready)');
      // The fixture checks transport recovery rather than RNNoise's response to
      // synthetic tones. Keep the normal gain/AEC/Opus/receive product paths.
      await win.webContents.executeJavaScript("window.coveMediaQA.rtc.selectMicrophoneNoiseMode('system')");
      await win.webContents.executeJavaScript('window.coveMediaQA.rtc.joinVoice()');
      await waitFor(win,'Boolean(window.coveMediaQA.rtc.inVoice)');
    }
    for(const win of windows)await waitFor(win,'window.coveMediaQA.rtc.voiceMembers.length===2');
    const [sender,viewer]=windows;
    async function grantControl(){
      await sender.webContents.executeJavaScript('window.coveMediaQA.control.requested=null');
      const senderId=await sender.webContents.executeJavaScript('window.coveMediaQA.socket.id');
      const requested=await viewer.webContents.executeJavaScript(`window.coveMediaQA.socket.timeout(4000).emitWithAck('remote-control:request',{roomId:${JSON.stringify(info.roomId)},sharerSocketId:${JSON.stringify(senderId)}})`);
      assert.equal(requested.ok,true,'synthetic peers must create a real server control request');
      await waitFor(sender,'Boolean(window.coveMediaQA.control.requested)');
      const accepted=await sender.webContents.executeJavaScript("window.coveMediaQA.socket.timeout(4000).emitWithAck('remote-control:respond',{requestId:window.coveMediaQA.control.requested.requestId,accepted:true})");
      assert.equal(accepted.ok,true);await waitFor(viewer,'window.coveMediaQA.control.active');
    }
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
      const selectedProtocols=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.selectedProtocols()');
      assert.ok(selectedProtocols.some(p=>p.direction==='recv'&&p.protocol===protocol),'actual selected receive candidate must use requested proxy protocol');
      assert.ok(recv&&recv.consumers.length>=2,'viewer receives voice and screen');
      await waitFor(viewer,'window.coveMediaQA.ice.audioProgress().then(a=>a.packets>5)');
      const audioBefore=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      audioEvidence.before={sender:await sender.webContents.executeJavaScript('window.coveMediaQA.ice.audioDiagnostics()'),viewer:await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioDiagnostics()'),progress:audioBefore};
      console.log('[audio-baseline]',JSON.stringify(audioEvidence.before));
      const nonSilent=diagnostics=>diagnostics.taps.some(tap=>tap.label==='consumer'&&tap.rms>1e-5&&tap.tracks.some(track=>track.enabled&&track.state==='live'));
      assert.ok(nonSilent(audioEvidence.before.viewer),'non-silent decoded consumer PCM must exist before injecting a media fault');
      assert.ok(audioEvidence.before.sender.transports.some(t=>t.producers.some(p=>!p.paused&&p.trackEnabled&&p.trackState==='live'&&p.stats.some(s=>s.packetsSent>5))),'sender must publish actual audio RTP');
      for(const peer of [audioEvidence.before.sender,audioEvidence.before.viewer])assert.ok(peer.contexts.every(c=>c.state==='running'&&c.sinkType==='none'),'all analysis/playback contexts must run on silent sinks');
      await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.toggleMute()');
      await waitFor(viewer,'window.coveMediaQA.rtc.isMuted');
      await grantControl();
      const controlStarts=await viewer.webContents.executeJavaScript('window.coveMediaQA.control.started');
      proxy.setBlocked(true);
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&["disconnected","failed"].includes(t.state))');
      const blockedFrames=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.decodedFrames()');
      const blockedAudio=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      audioEvidence.blocked=blockedAudio;
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.restartCalls>0)');
      proxy.setBlocked(false);
      await waitFor(viewer,'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.state==="connected")');
      await waitFor(viewer,`window.coveMediaQA.ice.decodedFrames().then(n=>n>${blockedFrames}+2)`);
      await waitFor(viewer,`window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${blockedAudio.packets}+2&&a.samples>${blockedAudio.samples}&&a.nonConcealedSamples>${blockedAudio.nonConcealedSamples}+960)`);
      const audioAfter=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioProgress()');
      await waitFor(viewer,'window.coveMediaQA.ice.audioDiagnostics().then(d=>d.taps.some(t=>t.label==="consumer"&&t.rms>1e-5))');
      // Sample two distinct render windows after fresh RTP/sample counters have
      // advanced. RTC inbound energy is preserved verbatim: Chromium may report
      // zero there even while this actual consumer track decodes non-zero PCM.
      const firstDecode=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioDiagnostics()');
      await new Promise(resolve=>setTimeout(resolve,300));
      const secondDecode=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.audioDiagnostics()');
      audioEvidence.after={firstDecode,secondDecode,progress:audioAfter};
      console.log('[audio-resumed]',JSON.stringify(audioEvidence.after));
      assert.ok(nonSilent(firstDecode)&&nonSilent(secondDecode),'decoded audio must remain non-silent across separate post-recovery render windows');
      const after=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.snapshot()');
      const restarted=after.find(t=>t.id===recv.id);
      assert.ok(restarted?.credentialsChanged,'real SFU restart must change the ICE username fragment');
      assert.deepEqual(restarted.consumers,recv.consumers,'restart must retain consumers');
      assert.deepEqual(after.flatMap(t=>t.producers.map(p=>p.id)),before.flatMap(t=>t.producers.map(p=>p.id)),'restart must retain producers');
      assert.equal(await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.inVoice&&window.coveMediaQA.rtc.isMuted&&Boolean(window.coveMediaQA.rtc.remoteScreen)'),true);
      await waitFor(viewer,'!window.coveMediaQA.control.active&&window.coveMediaQA.control.stopped>0');
      assert.equal(await viewer.webContents.executeJavaScript('window.coveMediaQA.control.started'),controlStarts,'ICE recovery must not restore remote-control authorization');
      iceEvidence={fault:`owned loopback ${protocol.toUpperCase()} proxy interrupts actual RTP/STUN forwarding`,protocol,selectedProtocols,interruptedConnections:proxy.counts().interruptedConnections,
        restartCalls:restarted.restartCalls,credentialsChanged:true,transportRetained:true,consumersRetained:true,
        producersRetained:true,muteRetained:true,watchRetained:true,decodedFramesResumed:true,
        syntheticAudioPacketsAndSamplesResumed:true,
        nonConcealedAudioSamplesResumed:true,
        nonSilentAudioDecodeVerified:nonSilent(audioEvidence.before.viewer)&&nonSilent(firstDecode)&&nonSilent(secondDecode),
        audioVerificationMethod:'actual consumer MediaStreamTrack PCM analyser on a running silent AudioContext, with RTP/sample growth',
        inboundEnergyMetricReportedZero:audioBefore.energy===0&&audioAfter.energy===0,
        remoteControlRevokedOnMediaRecovery:true,
        speakerAudibilityMeasured:false};
      assert.ok(iceEvidence.interruptedConnections>0);
    }
    await grantControl();
    const stoppedBeforeSignal=await viewer.webContents.executeJavaScript('window.coveMediaQA.control.stopped');
    const recovery=await viewer.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const socket=window.coveMediaQA.socket;const id=socket.id;
      const timer=setTimeout(()=>reject(new Error('Synthetic reconnect timed out')),8000);
      socket.once('connect',()=>{clearTimeout(timer);resolve({sameId:socket.id===id,recovered:socket.recovered});});
      socket.io.engine.close();
    })`);
    assert.equal(recovery.sameId,true,'short outage must retain the server session');
    assert.equal(recovery.recovered,true,'loopback transport must report recovered session');
    await waitFor(viewer,`!window.coveMediaQA.control.active&&window.coveMediaQA.control.stopped>${stoppedBeforeSignal}`);
    extraEvidence={signalOnlyRecovery:true,remoteControlRevokedOnSignalLoss:true};
    if(testIce){const calls=await viewer.webContents.executeJavaScript('window.coveMediaQA.ice.snapshot().filter(t=>t.direction==="recv").reduce((n,t)=>n+t.restartCalls,0)');assert.equal(calls,iceEvidence.restartCalls,'healthy media signal loss must not restart ICE');}
    await waitFor(viewer,'window.coveMediaQA.rtc.inVoice&&Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector("video").readyState>=2');
    if(process.env.COVE_QA_EXTENDED==='true')extraEvidence.browserCases=await runRecoveryBrowserScenarios({sender,viewer,proxy,waitFor,backendRequest,grantControl});
    if(soakSeconds){soakEvidence=await runRecoverySoak({sender,viewer,proxy,waitFor,backendRequest,durationSeconds:soakSeconds,onProgress:record=>{fs.writeFileSync(resultPath+'.progress.json',JSON.stringify({runId,cycle:record.cycle,elapsedMs:record.elapsedMs,clean:record.clean,protocol},null,2));console.log('[soak]',JSON.stringify({cycle:record.cycle,elapsedMs:record.elapsedMs,clean:record.clean}));}});await finish(0);return;}
    await sender.webContents.executeJavaScript('window.coveMediaQA.rtc.stopScreenShare()');
    await waitFor(viewer,'!window.coveMediaQA.rtc.remoteScreen');
    for(const win of windows)assert.equal(await win.webContents.executeJavaScript('window.coveMediaQA.rtc.inVoice'),true,'stopping screen must preserve voice');
    for(const win of windows)await win.webContents.executeJavaScript('window.coveMediaQA.rtc.leaveVoice()');
    console.log('PASS: two real Chromium/WebRTC peers, synthetic mic/video, negotiated VP8, non-black decoded frame, short transport recovery and independent screen teardown.');
    clearTimeout(watchdog);await finish(0);
  }catch(error){failure=error.stack||String(error);console.error(error);audioEvidence.failure=[];for(const win of windows)try{audioEvidence.failure.push(await win.webContents.executeJavaScript('window.coveMediaQA?.ice.candidateDiagnostics()'));}catch{}clearTimeout(watchdog);await finish(1);}
});
