'use strict';
// Measures real product publishing/viewing hooks through the existing isolated
// local SFU. The optional native source is this runner's own changing window.
const {app,BrowserWindow,session,desktopCapturer,screen,contentTracing}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../../..'),directory=path.resolve(process.env.COVE_FPS_RUN_DIR||'');
const {validatePerformanceCases,screenShareStartArguments,linkedVideoReport,linkedCounterRate,qualifyOwnedNativeBaseline,selectOwnedCaptureSource}=require(path.join(root,'tooling/screen-performance-config.cjs'));
const {TRACE_CATEGORIES,captureTraceOptions,sanitizeCaptureTrace,analyzeCaptureTrace,cleanupOwnedTraceExports}=require(path.join(root,'tooling/analyze-screen-performance-trace.cjs'));
const runtimeName=process.env.COVE_FPS_RUNTIME_NAME||'fps-candidate';
if(!/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/.test(runtimeName))throw Error('Invalid performance runtime namespace');
const relative=path.relative(path.join(root,'runtime',runtimeName),directory);
if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('An isolated fps-candidate directory is required');
const profile=path.join(directory,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile);
const captureFeatures=process.env.COVE_FPS_CAPTURE_FEATURES||'';
if(captureFeatures&&!['ZeroCopyDesktopCapture'].includes(captureFeatures))throw Error('Unsupported isolated capture feature');
app.commandLine.appendSwitch('enable-features',['AllowWgcScreenCapturer',captureFeatures].filter(Boolean).join(','));
// Test-only API selection diagnostic. Never accept arbitrary Chromium flags.
const disabledCaptureFeatures=process.env.COVE_FPS_DISABLE_CAPTURE_FEATURES||'';
if(disabledCaptureFeatures&&!['DirectXCapturer'].includes(disabledCaptureFeatures))throw Error('Unsupported disabled capture feature');
if(disabledCaptureFeatures)app.commandLine.appendSwitch('disable-features',disabledCaptureFeatures);
const peerRenderMode=process.env.COVE_FPS_PEER_RENDER_MODE||'offscreen';
if(!['offscreen','hidden'].includes(peerRenderMode))throw Error('Unsupported peer render mode');
const captureTraceEnabled=process.env.COVE_FPS_CONTENT_TRACE==='1';
if(process.env.COVE_FPS_CONTENT_TRACE&&!['0','1'].includes(process.env.COVE_FPS_CONTENT_TRACE))throw Error('Invalid content trace option');
if(process.env.COVE_FPS_CAPTURE_LOGS==='1'){app.commandLine.appendSwitch('enable-logging','file');app.commandLine.appendSwitch('log-file',path.join(directory,'native-capture.log'));app.commandLine.appendSwitch('vmodule','desktop_capture_device=2');}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Do not use --use-fake-device-for-media-stream: Chromium also replaces native
// getDisplayMedia with a 1000x564 test source. The renderer supplies test audio.
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={passed:false,startedAt:new Date().toISOString(),captureFeatures,disabledCaptureFeatures,peerRenderMode,profilingOnly:captureTraceEnabled,
  presentationMeaning:peerRenderMode==='hidden'?'Hidden regular windows may present zero frames; presentation is not a throughput or physical scan-out claim.':'Offscreen video/compositor counters are not physical display scan-out.',
  personalPixelsRetained:false,observerMeaning:'Native cases hold one VideoFrame from the existing receiver video per sample (normally 1 Hz), copy it once to RGBA, classify twenty points, zero the temporary buffer and close the frame; snapshot/copy/read wallclock and resource counts are saved separately. No per-frame readback.',
  scope:'two real Chromium peers, product media hooks, isolated loopback SFU; changing generated/native source',endToEndLatencyMeasured:false,cases:[]};
let backend,sourceWindow;const peers=[];let finished=false;let nativeRequests=0;let captureTarget='window';let selectedCaptureSource=null;
const watchdog=setTimeout(()=>void finish(Error('Performance watchdog expired')),330000);
process.on('message',message=>{if(message?.type==='stop')void finish(Error('Performance measurement was interrupted'));});
function save(){fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');}
let traceStopPromise=null,traceLimitTimer=null;
async function traceOperation(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
async function startOwnedTrace(){
  if(!captureTraceEnabled)return;
  const categories=await traceOperation(contentTracing.getCategories(),3000,'Trace category query');
  const processIds=[process.pid,...app.getAppMetrics().map(metric=>metric.pid)];
  const options=captureTraceOptions(processIds,categories);
  result.trace={profilingOnly:true,normalFpsComparisonEligible:false,options,
    reviewedCategoryAllowlist:TRACE_CATEGORIES,availableReviewedCategories:options.included_categories,
    missingReviewedCategories:TRACE_CATEGORIES.filter(category=>!options.included_categories.includes(category)),
    startedAt:new Date().toISOString(),maximumRecordingMs:3000,coverage:'Capture startup and first 3 seconds only; ordinary 8-second samples remain unchanged.',recordingRequested:true,sanitized:false};save();
  traceLimitTimer=setTimeout(()=>{result.trace.plannedWindowElapsed=true;void stopOwnedTrace('three-second-profile-window').catch(error=>{result.trace.error=error.message;save();});},3000);
  await traceOperation(contentTracing.startRecording(options),3000,'Trace start');
  result.trace.recordingStarted=true;save();
}
async function stopOwnedTrace(reason){
  if(!result.trace?.recordingRequested)return null;
  if(traceStopPromise)return traceStopPromise;
  clearTimeout(traceLimitTimer);traceLimitTimer=null;
  traceStopPromise=(async()=>{
    const rawPath=path.join(directory,'capture-trace.raw.json'),safePath=path.join(directory,'capture-trace.json');
    result.trace.stopReason=reason;
    try{
      try{result.trace.bufferUsage=await traceOperation(contentTracing.getTraceBufferUsage(),2000,'Trace buffer query');}catch(error){result.trace.bufferUsageError=error.message;}
      const exportPromise=contentTracing.stopRecording(rawPath);
      // Promise.race does not cancel Chromium's exporter. Process its eventual
      // completion too; the launcher also audits this exact run after exit.
      exportPromise.then(()=>{if(result.trace.stopTimedOut){try{result.trace.lateExportCleanup=cleanupOwnedTraceExports(directory,result.trace.options.included_process_ids);result.trace.rawFileRetained=result.trace.lateExportCleanup.rawFileRetained;}catch(error){result.trace.lateExportCleanupError=error.message;}save();}},()=>{});
      try{await traceOperation(exportPromise,20000,'Trace stop');}catch(error){result.trace.stopTimedOut=true;throw error;}
      result.trace.stoppedAt=new Date().toISOString();
      const sanitized=sanitizeCaptureTrace(JSON.parse(fs.readFileSync(rawPath,'utf8')),result.trace.options.included_process_ids);
      fs.writeFileSync(safePath,JSON.stringify(sanitized));
      const analysis=analyzeCaptureTrace(sanitized);fs.writeFileSync(path.join(directory,'capture-trace-summary.json'),JSON.stringify(analysis,null,2)+'\n');
      result.trace.sanitized=true;result.trace.file='capture-trace.json';result.trace.summaryFile='capture-trace-summary.json';
      result.trace.eventCount=analysis.eventCount;result.trace.completedSliceCount=analysis.completedSliceCount;
      result.trace.capturePathMarkers=analysis.capturePathMarkers;result.trace.threadCpuFieldsPresent=analysis.threadCpuFieldsPresent;
      result.trace.completed=true;return result.trace;
    }catch(error){result.trace.error=error.message;throw error;}
    finally{
      // This exact raw file is owned by the current isolated trace, never a user-selected path.
      if(fs.existsSync(rawPath))try{fs.unlinkSync(rawPath);}catch(error){result.trace.rawRemovalError=error.message;result.trace.sanitized=false;}
      result.trace.rawFileRetained=result.trace.stopTimedOut?null:fs.existsSync(rawPath);
      result.trace.postExitExportAuditRequired=true;save();
    }
  })();
  return traceStopPromise;
}
function sourceWindowState(){return !sourceWindow||sourceWindow.isDestroyed()?null:{
  bounds:sourceWindow.getBounds(),contentBounds:sourceWindow.getContentBounds(),fullscreen:sourceWindow.isFullScreen(),
  visible:sourceWindow.isVisible(),minimized:sourceWindow.isMinimized(),focused:sourceWindow.isFocused(),alwaysOnTop:sourceWindow.isAlwaysOnTop()};}
let snapshotRequest=0;
async function backendSnapshot(){
  if(!backend?.connected)return {error:'Owned backend IPC is unavailable'};
  const requestId='cleanup-'+(++snapshotRequest);
  return new Promise(resolve=>{const timer=setTimeout(()=>{backend.off('message',receive);resolve({error:'Owned backend snapshot timed out'});},1500);
    function receive(message){if(message?.requestId!==requestId)return;clearTimeout(timer);backend.off('message',receive);resolve(message.type==='snapshot'?message.resources:{error:message.error||'Snapshot failed'});}
    backend.on('message',receive);backend.send({type:'snapshot',requestId},error=>{if(error){clearTimeout(timer);backend.off('message',receive);resolve({error:error.message});}});
  });
}
async function cleanupPeers(){
  const renderers=[];
  for(const [index,win] of peers.entries())if(!win.isDestroyed())try{
    const evidence=await boundedJs(win,process.env.COVE_FPS_CLEANUP_HANG_CHECK==='1'?'new Promise(()=>{})':
      `(async()=>{
        if(window.covePerformanceCleanupPromise)return window.covePerformanceCleanupPromise;
        window.covePerformanceCleanupPromise=(async()=>{
          const qa=window.coveMediaQA,getResources=qa?.resources,started=performance.now();
          qa?.rtc.stopScreenShare();const fixture=await window.coveScreenPerformance?.cleanup();
          qa?.rtc.leaveVoice();qa?.socket.disconnect();
          const unmountAvailable=typeof window.covePerformanceUnmount==='function';
          window.covePerformanceUnmount?.();
          const keys=['peerConnections','liveTracks','liveTransports','liveProducers','liveConsumers','audioContexts','analysisTaps','timeouts','intervals','socketListeners'];
          let product;
          do{await new Promise(r=>setTimeout(r,50));product=getResources?.();if(product&&keys.every(key=>product[key]===0))break;}while(performance.now()-started<1700);
          return {fixture,product,unmountAvailable,unmounted:unmountAvailable,normalEffectsCleanupWaitMs:performance.now()-started};
        })();
        return window.covePerformanceCleanupPromise;
      })()`,2000);
    renderers.push({index,...evidence});
  }catch(error){renderers.push({index,error:error.message});}
  await delay(150);const backendResources=await backendSnapshot();
  const productKeys=['peerConnections','liveTracks','liveTransports','liveProducers','liveConsumers','audioContexts','analysisTaps','timeouts','intervals','socketListeners'];
  const rendererResourcesZero=renderers.length===2&&renderers.every(renderer=>renderer.fixture?.passed===true&&renderer.unmountAvailable&&productKeys.every(key=>renderer.product?.[key]===0));
  const backendResourcesZero=['peers','transports','producers','consumers'].every(key=>backendResources[key]===0);
  return {renderers,backendResources,rendererResourcesZero,backendResourcesZero,timeouts:renderers.filter(renderer=>renderer.error).length,passed:rendererResourcesZero&&backendResourcesZero};
}
async function finish(error){
  if(finished)return;finished=true;clearTimeout(watchdog);
  try{await stopOwnedTrace('finally');}catch(cause){error??=cause;}
  if(error){result.error=error.stack||String(error);console.error(result.error);}
  try{let timer;try{result.environment.gpuAfter=await Promise.race([app.getGPUInfo('basic'),new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error('GPU info timeout')),2000);})]);}finally{clearTimeout(timer);}result.environment.gpuFeatureStatusAfter=app.getGPUFeatureStatus();}catch{}
  result.cleanup=await cleanupPeers();result.cleanupTimeouts=result.cleanup.timeouts;
  await delay(150);for(const win of peers)if(!win.isDestroyed())win.destroy();if(sourceWindow&&!sourceWindow.isDestroyed())sourceWindow.destroy();
  if(backend&&backend.exitCode===null){if(backend.connected)backend.send({type:'stop'},()=>{});for(let n=0;n<50&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);if(backend.exitCode===null&&backend.signalCode===null){backend.kill();for(let n=0;n<20&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);}}
  result.backendStopped=!backend||backend.exitCode!==null||backend.signalCode!==null;result.finishedAt=new Date().toISOString();result.passed=!error&&result.backendStopped&&result.cleanup.passed;save();app.exit(result.passed?0:1);
}
const js=(win,code)=>win.webContents.executeJavaScript(code,true);
async function boundedJs(win,code,timeoutMs=30000){let timer;try{return await Promise.race([js(win,code),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Renderer operation timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function wait(win,code,ms=25000){const until=Date.now()+ms;while(Date.now()<until){if(await js(win,code))return;await delay(100);}throw Error('Timed out: '+code);}
function summary(samples){
  const a=samples[0],b=samples.at(-1),seconds=(b.at-a.at)/1000;
  const number=value=>value==null||!Number.isFinite(value)?null:Math.round(value*100)/100;
  const sourceFps=linkedCounterRate(a.sender,b.sender,'source','frames');
  const encodeFps=linkedCounterRate(a.sender,b.sender,'outbound','framesEncoded');
  const decodeFps=linkedCounterRate(a.viewer,b.viewer,'inbound','framesDecoded');
  const averageMs=(first,last,stage,key,frames)=>{
    const time=linkedCounterRate(first,last,stage,key);
    return time==null||frames==null||frames<=0?null:number(1000*time/frames);
  };
  const first=a.viewer.presentation?.find(p=>p.isCurrentVideo),last=b.viewer.presentation?.find(p=>p.isCurrentVideo);
  const presentationRate=key=>first?.trackToken===last?.trackToken&&typeof first?.[key]==='number'&&typeof last?.[key]==='number'
    ?number((last[key]-first[key])/seconds):null;
  return {
    seconds,nativeSourceRafFps:number((b.nativeSourceFrames-a.nativeSourceFrames)/seconds),
    sourceFps:number(sourceFps),encodeFps:number(encodeFps),
    sendFps:number(linkedCounterRate(a.sender,b.sender,'outbound','framesSent')),
    receiveFps:number(linkedCounterRate(a.viewer,b.viewer,'inbound','framesReceived')),decodeFps:number(decodeFps),
    encodeTimeMs:averageMs(a.sender,b.sender,'outbound','totalEncodeTime',encodeFps),
    decodeTimeMs:averageMs(a.viewer,b.viewer,'inbound','totalDecodeTime',decodeFps),
    activityAnalysisDelta:Object.fromEntries(['drawCalls','readCalls','drawMs','readMs','errors'].map(key=>[key,number((b.sender.activityAnalysis?.[key]??0)-(a.sender.activityAnalysis?.[key]??0))])),
    observerCost:{method:'VideoFrame.copyTo(RGBA)',drawCalls:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerDrawCalls??0),0),drawMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerDrawMs??0),0)),readMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerReadMs??0),0)),copyMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerCopyMs??0),0)),copiedBytes:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerCopiedBytes??0),0),snapshotMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.frameSnapshotMs??0),0)),snapshotsCreated:samples.filter(s=>s.viewer.ownedPattern?.frameSnapshotCreated).length,snapshotsClosed:samples.filter(s=>s.viewer.ownedPattern?.frameSnapshotClosed).length},
    nativeTimingMeaning:'Capture/conversion/delivery segment timing requires native-capture.log; pure converter CPU time and encoder queue delay remain unavailable.',
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
    const source=`<!doctype html><style>body{margin:0;overflow:hidden;background:#17324d}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script>const c=document.querySelector('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d');let frames=0;function draw(t){frames++;x.fillStyle=frames%2?'#17324d':'#18334e';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fcba35';x.fillRect((t*.35)%1800,600,120,400);x.fillStyle='white';x.font='72px sans-serif';x.fillText(String(frames),240,100);for(const [color,a,b] of [['#e84a5f',0,0],['#41b3a3',1728,0],['#e8d0a9',0,972],['#4b2e83',1728,972]]){x.fillStyle=color;x.fillRect(a,b,192,108)}for(let bit=0;bit<16;bit++){x.fillStyle=frames&(1<<bit)?'#fff':'#000';x.fillRect(384+bit*72,432,72,108)}window.sourceFrames=frames;requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>`;
    await sourceWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(source));
    session.defaultSession.setDisplayMediaRequestHandler((_request,callback)=>{
      try{nativeRequests++;console.log('[capture] owned native request',nativeRequests,captureTarget);
        if(!selectedCaptureSource)throw Error('No prevalidated owned source for display capture');
        callback({video:selectedCaptureSource});
      }catch(error){console.error(error);void finish(error);}
    });
    const cases=JSON.parse(process.env.COVE_FPS_CASES||JSON.stringify([{source:'generated',preset:'1080p',fps:120,game:true,compatibility:true},{source:'generated',preset:'540p',fps:120,game:true,compatibility:true},{source:'native',preset:'1080p',fps:120,game:true,compatibility:true},{source:'native',preset:'540p',fps:120,game:true,compatibility:true}]));
    validatePerformanceCases(cases);
    const sampleSeconds=Number(process.env.COVE_FPS_SAMPLE_SECONDS||8),warmupMs=Number(process.env.COVE_FPS_WARMUP_MS||5000);
    if(!Number.isInteger(sampleSeconds)||sampleSeconds<1||sampleSeconds>30||!Number.isInteger(warmupMs)||warmupMs<0||warmupMs>30000)throw Error('Invalid bounded sample duration');
    if(captureTraceEnabled&&(cases.length!==1||cases[0].source!=='native'||sampleSeconds>8||warmupMs>5000||process.env.COVE_FPS_RECOVERY_CHECKS==='1'))throw Error('Capture profiling requires one native case, at most 5s warmup/8s sample and no recovery injection');
    for(let index=0;index<2;index++){const win=new BrowserWindow({width:1000,height:760,show:false,webPreferences:{offscreen:peerRenderMode==='offscreen',backgroundThrottling:false}});if(peerRenderMode==='offscreen')win.webContents.setFrameRate(144);win.webContents.setAudioMuted(true);peers.push(win);win.webContents.on('console-message',(_e,level,msg)=>{if(msg.includes('Error')||msg.includes('error'))console.log('[peer]',msg);});}
    for(const config of cases){
      captureTarget=config.captureTarget==='screen'?'screen':'window';
      if(config.source==='native'){
        sourceWindow.setFullScreen(captureTarget==='screen'||Boolean(config.ownedWindowFullscreen));
        // Native runs are explicitly scheduled foreground tests. Showing
        // inactive can leave another app covering the supposed monitor source.
        sourceWindow.show();sourceWindow.focus();await delay(300);
        sourceWindow.setAlwaysOnTop(true,'floating');sourceWindow.moveTop();
      }else{sourceWindow.setAlwaysOnTop(false);sourceWindow.hide();}
      let sourceSelection=null;selectedCaptureSource=null;
      if(config.source==='native'){
        const selected=selectOwnedCaptureSource({captureTarget,
          sources:await desktopCapturer.getSources({types:[captureTarget],thumbnailSize:{width:0,height:0}}),
          displays:screen.getAllDisplays(),primaryDisplayId:screen.getPrimaryDisplay().id,ownedWindowId:sourceWindow.getMediaSourceId(),nativeWindowPath:Boolean(config.nativeWindowPath)});
        selectedCaptureSource=selected.source;sourceSelection=selected.metadata;
        result.sourceSelections??=[];result.sourceSelections.push(sourceSelection);save();
      }
      for(let index=0;index<2;index++){
        const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index),performance:'1',source:config.source,width:'1920',height:'1080',fps:String(config.fps),...(config.source==='native'&&index===1?{ownedPattern:'1'}:{}),...(config.captureWidth?{captureWidth:String(config.captureWidth),captureHeight:String(config.captureHeight)}:{})});
        await peers[index].loadURL(process.env.COVE_QA_RENDERER_URL+'/tests/ui/media-integration.html?'+query);await wait(peers[index],'Boolean(window.coveMediaQA?.ready)');await js(peers[index],"window.coveMediaQA.rtc.selectMicrophoneNoiseMode('system');window.coveMediaQA.rtc.joinVoice()");await wait(peers[index],'Boolean(window.coveMediaQA.rtc.inVoice)');
      }
      const [sender,viewer]=peers;
      if(config.source==='native'){
        const readerCheck=await boundedJs(viewer,'window.coveScreenPerformance.verifyPatternReader()');
        result.patternReaderChecks??=[];result.patternReaderChecks.push(readerCheck);save();
        if(!readerCheck.passed)throw Error('Owned-pattern VideoFrame/ROI self-test failed before native capture');
      }
      const nativeRequestsBefore=nativeRequests;
      if(config.source==='native')sourceWindow.moveTop();
      await startOwnedTrace();
      await boundedJs(sender,`window.coveMediaQA.rtc.startScreenShare(...${JSON.stringify(screenShareStartArguments(config))})`);await wait(sender,'Boolean(window.coveMediaQA.rtc.localScreen)');await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');
      await wait(sender,`window.coveMediaQA.rtc.screenNativeResolution===${Boolean(config.nativeResolution)}`);
      if(config.source==='native'&&nativeRequests<=nativeRequestsBefore)throw Error('Native source was replaced before the Electron capture handler');
      await js(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');await wait(viewer,'document.querySelector("video").readyState>=2');
      await delay(warmupMs);const samples=[];
      if(config.source==='native')sourceWindow.moveTop();
      const measured={config,sourceSelection,sourceWindowBeforeSampling:sourceWindowState(),samples,summary:null,nativeSourceFrames:0,nativeRequests,comparisonContract:{passed:false},nativeBaseline:{required:config.source==='native',passed:false}};
      result.cases.push(measured);save();
      for(let n=0;n<=sampleSeconds;n++){
        const [send,receive]=await Promise.all(peers.map(win=>boundedJs(win,'window.coveScreenPerformance.sample()')));
        samples.push({at:Date.now(),sender:send,viewer:receive,nativeSourceFrames:await js(sourceWindow,'window.sourceFrames'),sourceWindowState:sourceWindowState(),cpu:app.getAppMetrics().map(m=>({type:m.type,cpu:m.cpu,memory:m.memory}))});
        if(samples.length>=2){measured.summary=summary(samples);measured.nativeBaseline=qualifyOwnedNativeBaseline(config,samples);}
        save();
        if(samples.length>=2&&!measured.nativeBaseline.passed)throw Error('Owned native baseline failed: '+JSON.stringify(measured.nativeBaseline));
        if(n<sampleSeconds)await delay(1000);
      }
      if(captureTraceEnabled){await stopOwnedTrace('sample-complete');if(!result.trace.completed||!result.trace.sanitized||result.trace.rawFileRetained)throw Error('Capture profiling did not complete with a sanitized trace');}
      const nativeSourceFrames=await js(sourceWindow,'window.sourceFrames');
      measured.nativeSourceFrames=nativeSourceFrames;measured.nativeRequests=nativeRequests;save();
      // Optional dimensional/codec contract for comparisons: a preset label or
      // codec preference alone does not establish the actual measured path.
      try{for(const sample of samples){
        const capture=sample.sender.sources.find(source=>source.trackState==='live')?.settings;
        const outgoing=linkedVideoReport(sample.sender,'outbound');
        const incoming=linkedVideoReport(sample.viewer,'inbound');
        if(!linkedVideoReport(sample.sender,'source')||!outgoing||!incoming)throw Error('Live video pipeline statistics could not be bound unambiguously');
        const rendered=sample.viewer.presentation.find(p=>p.isCurrentVideo);
        for(const [stage,width,height] of [['capture',capture?.width,capture?.height],['encoded',outgoing?.frameWidth,outgoing?.frameHeight],['decoded',incoming?.frameWidth,incoming?.frameHeight],['rendered',rendered?.width,rendered?.height]]){
          const requiredWidth=stage==='capture'?(config.expectCaptureWidth??config.expectWidth):(config.expectEncodedWidth??config.expectWidth);
          const requiredHeight=stage==='capture'?(config.expectCaptureHeight??config.expectHeight):(config.expectEncodedHeight??config.expectHeight);
          if(requiredWidth&&requiredHeight&&(width!==requiredWidth||height!==requiredHeight))throw Error(`${stage} dimensions ${width}x${height} do not match required ${requiredWidth}x${requiredHeight}`);
        }
        if(config.expectCodec&&(outgoing?.codec!==config.expectCodec||incoming?.codec!==config.expectCodec))throw Error('Negotiated codec does not match required '+config.expectCodec);
      }}catch(error){measured.comparisonContract.error=error.message;save();throw error;}
      measured.comparisonContract.passed=true;save();console.log('[performance]',JSON.stringify({config,sourceFps:measured.summary.sourceFps,encodeFps:measured.summary.encodeFps,sendFps:measured.summary.sendFps,decodeFps:measured.summary.decodeFps,nativeRequests}));
      if(process.env.COVE_FPS_RECOVERY_CHECKS==='1'||process.env.COVE_FPS_REPUBLISH_CHECKS==='1'){
        const before=samples.at(-1).viewer.currentVideo;if(!before)throw Error('Current receiver statistics are unavailable');
        measured.recovery={gpuProcessRestartRequested:process.env.COVE_FPS_RECOVERY_CHECKS==='1'};
        if(process.env.COVE_FPS_RECOVERY_CHECKS==='1'){
        const pixels=await js(viewer,'(()=>{const v=document.querySelector("video"),c=document.createElement("canvas");c.width=1;c.height=1;const x=c.getContext("2d");x.drawImage(v,v.videoWidth*.8,v.videoHeight*.1,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data]})()');
        if(pixels[2]<30||pixels[3]!==255)throw Error('Controlled screen decoded black or transparent pixels');
        const gpu=app.getAppMetrics().find(m=>m.type==='GPU');if(!gpu?.pid)throw Error('No owned GPU process available for recovery check');
        const recoveryStarted=Date.now();process.kill(gpu.pid);
        try{await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken===${before.trackToken}&&s.currentVideo.framesDecoded>${before.framesDecoded+20})`,20000);}
        catch(error){measured.recovery.failure=error.message;measured.recovery.senderAfterFailure=await boundedJs(sender,'window.coveScreenPerformance.sample()');measured.recovery.viewerAfterFailure=await boundedJs(viewer,'window.coveScreenPerformance.sample()');save();throw error;}
        const replacedGpu=app.getAppMetrics().find(m=>m.type==='GPU');
        Object.assign(measured.recovery,{decodedPixel:pixels,ownedGpuProcessRestarted:Boolean(replacedGpu?.pid&&replacedGpu.pid!==gpu.pid),decodedFramesResumed:true,gpuRecoveryMs:Date.now()-recoveryStarted});
        }
        await boundedJs(sender,'window.coveMediaQA.rtc.stopScreenShare();void 0');await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===0');
        const stopped=await js(sender,'window.coveScreenPerformance.sample().then(s=>s.sources.every(t=>t.trackState==="ended"))');
        await boundedJs(sender,`window.coveMediaQA.rtc.startScreenShare(...${JSON.stringify(screenShareStartArguments(config))})`);
        await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');await boundedJs(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId);void 0');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken!==${before.trackToken}&&s.currentVideo?.trackState==='live')`);
        const fresh=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken===${fresh.trackToken}&&s.currentVideo.reportId===${JSON.stringify(fresh.reportId)}&&s.currentVideo.framesDecoded>${fresh.framesDecoded+20})`);
        const progressed=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        measured.recovery.productStopEndedSourceTracks=stopped;measured.recovery.newConsumerTrack=fresh.trackToken!==before.trackToken;measured.recovery.freshDecodedFrames=progressed.framesDecoded-fresh.framesDecoded;measured.recovery.republicationDecodedFrames=true;save();
        if(!stopped||(measured.recovery.gpuProcessRestartRequested&&!measured.recovery.ownedGpuProcessRestarted))throw Error('Owned GPU/source recovery invariant failed');
      }
      measured.cleanup=await cleanupPeers();save();
      if(!measured.cleanup.passed)throw Error('Owned media cleanup invariants failed');
      await delay(350);
    }
    await finish();
  }catch(error){await finish(error);}
});
