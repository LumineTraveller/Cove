'use strict';
// Measures real product publishing/viewing hooks through the existing isolated
// local SFU. The optional native source is this runner's own changing window.
const {app,BrowserWindow,session,desktopCapturer,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../../..'),directory=path.resolve(process.env.COVE_FPS_RUN_DIR||'');
const {validatePerformanceCases}=require(path.join(root,'tooling/screen-performance-config.cjs'));
const runtimeName=process.env.COVE_FPS_RUNTIME_NAME||'fps-candidate';
if(!/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/.test(runtimeName))throw Error('Invalid performance runtime namespace');
const relative=path.relative(path.join(root,'runtime',runtimeName),directory);
if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('An isolated fps-candidate directory is required');
const profile=path.join(directory,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile);
const captureFeatures=process.env.COVE_FPS_CAPTURE_FEATURES||'';
if(captureFeatures&&!['ZeroCopyDesktopCapture'].includes(captureFeatures))throw Error('Unsupported isolated capture feature');
app.commandLine.appendSwitch('enable-features',['AllowWgcScreenCapturer',captureFeatures].filter(Boolean).join(','));
if(process.env.COVE_FPS_CAPTURE_LOGS==='1'){app.commandLine.appendSwitch('enable-logging','file');app.commandLine.appendSwitch('log-file',path.join(directory,'native-capture.log'));app.commandLine.appendSwitch('vmodule','desktop_capture_device=2');}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Do not use --use-fake-device-for-media-stream: Chromium also replaces native
// getDisplayMedia with a 1000x564 test source. The renderer supplies test audio.
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={passed:false,startedAt:new Date().toISOString(),captureFeatures,scope:'two real Chromium peers, product media hooks, isolated loopback SFU; changing generated/native source',endToEndLatencyMeasured:false,cases:[]};
let backend,sourceWindow;const peers=[];let finished=false;let nativeRequests=0;let captureTarget='window';
const watchdog=setTimeout(()=>void finish(Error('Performance watchdog expired')),330000);
process.on('message',message=>{if(message?.type==='stop')void finish(Error('Performance measurement was interrupted'));});
function save(){fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');}
async function finish(error){
  if(finished)return;finished=true;clearTimeout(watchdog);
  if(error){result.error=error.stack||String(error);console.error(result.error);}
  try{let timer;try{result.environment.gpuAfter=await Promise.race([app.getGPUInfo('basic'),new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error('GPU info timeout')),2000);})]);}finally{clearTimeout(timer);}result.environment.gpuFeatureStatusAfter=app.getGPUFeatureStatus();}catch{}
  result.cleanupTimeouts=0;
  for(const win of peers)if(!win.isDestroyed())try{await boundedJs(win,process.env.COVE_FPS_CLEANUP_HANG_CHECK==='1'?'new Promise(()=>{})':'window.coveMediaQA?.rtc.stopScreenShare();window.coveScreenPerformance?.cleanup();window.coveMediaQA?.rtc.leaveVoice();window.coveMediaQA?.socket.disconnect();void 0',2000);}catch{result.cleanupTimeouts++;}
  await delay(150);for(const win of peers)if(!win.isDestroyed())win.destroy();if(sourceWindow&&!sourceWindow.isDestroyed())sourceWindow.destroy();
  if(backend&&backend.exitCode===null){if(backend.connected)backend.send({type:'stop'},()=>{});for(let n=0;n<50&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);if(backend.exitCode===null&&backend.signalCode===null){backend.kill();for(let n=0;n<20&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);}}
  result.backendStopped=!backend||backend.exitCode!==null||backend.signalCode!==null;result.finishedAt=new Date().toISOString();result.passed=!error&&result.backendStopped;save();app.exit(result.passed?0:1);
}
const js=(win,code)=>win.webContents.executeJavaScript(code,true);
async function boundedJs(win,code,timeoutMs=30000){let timer;try{return await Promise.race([js(win,code),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Renderer operation timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function wait(win,code,ms=25000){const until=Date.now()+ms;while(Date.now()<until){if(await js(win,code))return;await delay(100);}throw Error('Timed out: '+code);}
function rate(a,b,type,key){const y=b.reports?.filter(r=>r.type===type).sort((x,y)=>(y[key]||0)-(x[key]||0))[0],x=a.reports?.find(r=>r.type===type&&r.id===y?.id);if(!x||!y||typeof x[key]!=='number'||typeof y[key]!=='number')return null;const dt=(y.timestamp-x.timestamp)/1000,delta=y[key]-x[key];return dt>0&&delta>=0?delta/dt:null;}
function summary(samples){
  const a=samples[0],b=samples.at(-1),seconds=(b.at-a.at)/1000;
  const number=value=>value==null||!Number.isFinite(value)?null:Math.round(value*100)/100;
  const sourceFps=rate(a.sender,b.sender,'media-source','frames');
  const encodeFps=rate(a.sender,b.sender,'outbound-rtp','framesEncoded');
  const decodeFps=rate(a.viewer,b.viewer,'inbound-rtp','framesDecoded');
  const averageMs=(first,last,type,key,frames)=>{
    const time=rate(first,last,type,key);
    return time==null||frames==null||frames<=0?null:number(1000*time/frames);
  };
  const first=a.viewer.presentation?.[0],last=b.viewer.presentation?.[0];
  const presentationRate=key=>typeof first?.[key]==='number'&&typeof last?.[key]==='number'
    ?number((last[key]-first[key])/seconds):null;
  return {
    seconds,nativeSourceRafFps:number((b.nativeSourceFrames-a.nativeSourceFrames)/seconds),
    sourceFps:number(sourceFps),encodeFps:number(encodeFps),
    sendFps:number(rate(a.sender,b.sender,'outbound-rtp','framesSent')),
    receiveFps:number(rate(a.viewer,b.viewer,'inbound-rtp','framesReceived')),decodeFps:number(decodeFps),
    encodeTimeMs:averageMs(a.sender,b.sender,'outbound-rtp','totalEncodeTime',encodeFps),
    decodeTimeMs:averageMs(a.viewer,b.viewer,'inbound-rtp','totalDecodeTime',decodeFps),
    presentationCallbacksFps:presentationRate('callbacks'),presentedFramesFps:presentationRate('latestPresentedFrames'),
    playbackFramesFps:presentationRate('totalVideoFrames'),playbackDroppedFps:presentationRate('droppedVideoFrames'),
    senderLast:b.sender,viewerLast:b.viewer,
  };
}
app.whenReady().then(async()=>{
  try{
    console.log('[capture-features]',captureFeatures||'baseline defaults');
    result.environment={versions:process.versions,logTimezoneOffsetMinutes:new Date().getTimezoneOffset(),os:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,memoryGB:Math.round(os.totalmem()/1024**3)},displays:screen.getAllDisplays().map(d=>({size:d.size,bounds:d.bounds,scaleFactor:d.scaleFactor,displayFrequency:d.displayFrequency})),gpu:await app.getGPUInfo('basic'),gpuFeatureStatus:app.getGPUFeatureStatus()};
    backend=spawn(process.env.COVE_TEST_NODE,[path.join(__dirname,'screen-performance-backend.cjs')],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
    fs.writeFileSync(path.join(directory,'owned-processes.json'),JSON.stringify({electron:process.pid,backend:backend.pid},null,2));
    const info=await new Promise((resolve,reject)=>{backend.once('error',reject);backend.once('exit',code=>reject(Error('Backend exited '+code)));backend.on('message',m=>{if(m?.type==='ready')resolve(m);});});
    session.defaultSession.setPermissionRequestHandler((_wc,permission,done)=>done(['media','display-capture'].includes(permission)));session.defaultSession.setPermissionCheckHandler((_wc,permission)=>['media','display-capture'].includes(permission));
    const scale=screen.getPrimaryDisplay().scaleFactor;
    sourceWindow=new BrowserWindow({width:Math.round(1920/scale),height:Math.round(1080/scale),useContentSize:true,frame:false,show:false,title:'Cove isolated moving source',webPreferences:{backgroundThrottling:false}});
    const source=`<!doctype html><style>body{margin:0;overflow:hidden;background:#17324d}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script>const c=document.querySelector('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d');let frames=0;function draw(t){frames++;x.fillStyle=frames%2?'#17324d':'#18334e';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fcba35';x.fillRect((t*.35)%1800,300,120,400);x.fillStyle='white';x.font='72px sans-serif';x.fillText(String(frames),30,100);window.sourceFrames=frames;requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>`;
    await sourceWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(source));
    session.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{try{nativeRequests++;console.log('[capture] owned native request',nativeRequests,captureTarget);const sources=await desktopCapturer.getSources({types:[captureTarget],thumbnailSize:{width:0,height:0}});const owned=captureTarget==='screen'?sources.find(s=>s.display_id===String(screen.getPrimaryDisplay().id)):sources.find(s=>s.id===sourceWindow.getMediaSourceId());if(!owned)throw Error('Owned controlled source is unavailable');callback({video:owned});}catch(error){console.error(error);callback({});}});
    const cases=JSON.parse(process.env.COVE_FPS_CASES||JSON.stringify([{source:'generated',preset:'1080p',fps:120,game:true,compatibility:true},{source:'generated',preset:'540p',fps:120,game:true,compatibility:true},{source:'native',preset:'1080p',fps:120,game:true,compatibility:true},{source:'native',preset:'540p',fps:120,game:true,compatibility:true}]));
    validatePerformanceCases(cases);
    const sampleSeconds=Number(process.env.COVE_FPS_SAMPLE_SECONDS||8),warmupMs=Number(process.env.COVE_FPS_WARMUP_MS||5000);
    if(!Number.isInteger(sampleSeconds)||sampleSeconds<1||sampleSeconds>30||!Number.isInteger(warmupMs)||warmupMs<0||warmupMs>30000)throw Error('Invalid bounded sample duration');
    for(let index=0;index<2;index++){const win=new BrowserWindow({width:1000,height:760,show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});win.webContents.setFrameRate(144);win.webContents.setAudioMuted(true);peers.push(win);win.webContents.on('console-message',(_e,level,msg)=>{if(msg.includes('Error')||msg.includes('error'))console.log('[peer]',msg);});}
    for(const config of cases){
      captureTarget=config.captureTarget==='screen'?'screen':'window';
      if(config.source==='native'){sourceWindow.setFullScreen(captureTarget==='screen');sourceWindow.showInactive();sourceWindow.moveTop();await delay(300);}else sourceWindow.hide();
      for(let index=0;index<2;index++){
        const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index),performance:'1',source:config.source,width:'1920',height:'1080',fps:String(config.fps),...(config.captureWidth?{captureWidth:String(config.captureWidth),captureHeight:String(config.captureHeight)}:{})});
        await peers[index].loadURL(process.env.COVE_QA_RENDERER_URL+'/tests/ui/media-integration.html?'+query);await wait(peers[index],'Boolean(window.coveMediaQA?.ready)');await js(peers[index],"window.coveMediaQA.rtc.selectMicrophoneNoiseMode('system');window.coveMediaQA.rtc.joinVoice()");await wait(peers[index],'Boolean(window.coveMediaQA.rtc.inVoice)');
      }
      const [sender,viewer]=peers;
      await boundedJs(sender,`window.coveMediaQA.rtc.startScreenShare(${JSON.stringify(config.preset)},${config.fps},false,${Boolean(config.game)},false,${Boolean(config.compatibility)})`);await wait(sender,'Boolean(window.coveMediaQA.rtc.localScreen)');await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');
      if(config.source==='native'&&nativeRequests===0)throw Error('Native source was replaced before the Electron capture handler');
      await js(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');await wait(viewer,'document.querySelector("video").readyState>=2');
      await delay(warmupMs);const samples=[];
      for(let n=0;n<=sampleSeconds;n++){const [send,receive]=await Promise.all(peers.map(win=>js(win,'window.coveScreenPerformance.sample()')));samples.push({at:Date.now(),sender:send,viewer:receive,nativeSourceFrames:await js(sourceWindow,'window.sourceFrames'),cpu:app.getAppMetrics().map(m=>({type:m.type,cpu:m.cpu,memory:m.memory}))});if(n<sampleSeconds)await delay(1000);}
      const nativeSourceFrames=await js(sourceWindow,'window.sourceFrames');
      const measured={config,samples,summary:summary(samples),nativeSourceFrames,nativeRequests,comparisonContract:{passed:false}};
      result.cases.push(measured);save();
      // Optional dimensional/codec contract for comparisons: a preset label or
      // codec preference alone does not establish the actual measured path.
      try{for(const sample of samples){
        const capture=sample.sender.sources.find(source=>source.trackState==='live')?.settings;
        const outgoing=sample.sender.reports.find(report=>report.type==='outbound-rtp'&&report.codec);
        const incoming=sample.viewer.reports.find(report=>report.id===sample.viewer.currentVideo?.reportId);
        const rendered=sample.viewer.presentation[0];
        for(const [stage,width,height] of [['capture',capture?.width,capture?.height],['encoded',outgoing?.frameWidth,outgoing?.frameHeight],['decoded',incoming?.frameWidth,incoming?.frameHeight],['rendered',rendered?.width,rendered?.height]]){
          const requiredWidth=stage==='capture'?(config.expectCaptureWidth??config.expectWidth):(config.expectEncodedWidth??config.expectWidth);
          const requiredHeight=stage==='capture'?(config.expectCaptureHeight??config.expectHeight):(config.expectEncodedHeight??config.expectHeight);
          if(requiredWidth&&requiredHeight&&(width!==requiredWidth||height!==requiredHeight))throw Error(`${stage} dimensions ${width}x${height} do not match required ${requiredWidth}x${requiredHeight}`);
        }
        if(config.expectCodec&&(outgoing?.codec!==config.expectCodec||incoming?.codec!==config.expectCodec))throw Error('Negotiated codec does not match required '+config.expectCodec);
      }}catch(error){measured.comparisonContract.error=error.message;save();throw error;}
      measured.comparisonContract.passed=true;save();console.log('[performance]',JSON.stringify({config,sourceFps:measured.summary.sourceFps,encodeFps:measured.summary.encodeFps,sendFps:measured.summary.sendFps,decodeFps:measured.summary.decodeFps,nativeRequests}));
      if(process.env.COVE_FPS_RECOVERY_CHECKS==='1'){
        const pixels=await js(viewer,'(()=>{const v=document.querySelector("video"),c=document.createElement("canvas");c.width=1;c.height=1;const x=c.getContext("2d");x.drawImage(v,v.videoWidth*.8,v.videoHeight*.1,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data]})()');
        if(pixels[2]<30||pixels[3]!==255)throw Error('Controlled screen decoded black or transparent pixels');
        const gpu=app.getAppMetrics().find(m=>m.type==='GPU');if(!gpu?.pid)throw Error('No owned GPU process available for recovery check');
        const before=samples.at(-1).viewer.currentVideo;if(!before)throw Error('Current receiver statistics are unavailable');
        const recoveryStarted=Date.now();process.kill(gpu.pid);
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken===${before.trackToken}&&s.currentVideo.framesDecoded>${before.framesDecoded+20})`,20000);
        const replacedGpu=app.getAppMetrics().find(m=>m.type==='GPU');
        measured.recovery={decodedPixel:pixels,ownedGpuProcessRestarted:Boolean(replacedGpu?.pid&&replacedGpu.pid!==gpu.pid),decodedFramesResumed:true,gpuRecoveryMs:Date.now()-recoveryStarted};
        await boundedJs(sender,'window.coveMediaQA.rtc.stopScreenShare();void 0');await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===0');
        const stopped=await js(sender,'window.coveScreenPerformance.sample().then(s=>s.sources.every(t=>t.trackState==="ended"))');
        await boundedJs(sender,`window.coveMediaQA.rtc.startScreenShare(${JSON.stringify(config.preset)},${config.fps},false,${Boolean(config.game)},false,${Boolean(config.compatibility)})`);
        await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');await boundedJs(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId);void 0');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken!==${before.trackToken}&&s.currentVideo?.trackState==='live')`);
        const fresh=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken===${fresh.trackToken}&&s.currentVideo.reportId===${JSON.stringify(fresh.reportId)}&&s.currentVideo.framesDecoded>${fresh.framesDecoded+20})`);
        const progressed=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        measured.recovery.productStopEndedSourceTracks=stopped;measured.recovery.newConsumerTrack=fresh.trackToken!==before.trackToken;measured.recovery.freshDecodedFrames=progressed.framesDecoded-fresh.framesDecoded;measured.recovery.republicationDecodedFrames=true;save();
        if(!stopped||!measured.recovery.ownedGpuProcessRestarted)throw Error('Owned GPU/source recovery invariant failed');
      }
      for(const win of peers)await js(win,'window.coveMediaQA.rtc.stopScreenShare();window.coveScreenPerformance.cleanup();window.coveMediaQA.rtc.leaveVoice();window.coveMediaQA.socket.disconnect();void 0');await delay(500);
    }
    await finish();
  }catch(error){await finish(error);}
});
