'use strict';
// Measures real product publishing/viewing hooks through the existing isolated
// local SFU. The optional native source is this runner's own changing window.
const {app,BrowserWindow,session,desktopCapturer,screen,contentTracing,ipcMain,powerMonitor,powerSaveBlocker}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../../..'),directory=path.resolve(process.env.COVE_FPS_RUN_DIR||'');
const {validatePerformanceCases,screenShareStartArguments,linkedVideoReport,linkedCounterRate,qualifyOwnedNativeBaseline,selectOwnedCaptureSource}=require(path.join(root,'tooling/screen-performance-config.cjs'));
const {TRACE_CATEGORIES,captureTraceOptions,sanitizeCaptureTrace,analyzeCaptureTrace,cleanupOwnedTraceExports}=require(path.join(root,'tooling/analyze-screen-performance-trace.cjs'));
const {performanceSourceAgeEnabled,createSourceAgeRing,safeSourceAgeObservation}=require(path.join(root,'tooling/screen-performance-source-age.cjs'));
const sourceAgeEnabled=performanceSourceAgeEnabled();
const {nativePerformanceEnabled,nativePerformancePaths,nativeUpgradeRequired,nativeBrokerSnapshot,nativeResourcesReleased,nativeUpgradeEvidence,captureCpuSummary,createNativeTimingCollector,createNativeStartupCollector,nativePerformanceTracePhase,nativeProviderDiagnosticsDelta,nativePerformancePixelFormat,nativePerformanceStorage,nativePerformanceCompletion,nativeHelperCompletionEvidence,nativeStopRequestEvidence,performanceDisplaySleepPrevention,stockFallbackPlaybackEvidence}=require(path.join(root,'tooling/screen-performance-native.cjs'));
const {nativeHelperTimingSnapshot,nativeHelperTimingSummary}=require(path.join(root,'tooling/screen-performance-native.cjs'));
const nativeGpuEnabled=nativePerformanceEnabled(),nativePaths=nativeGpuEnabled?nativePerformancePaths(root):null;
const nativePixelFormat=nativePerformancePixelFormat();
const nativeStorage=nativePerformanceStorage(process.env,nativePixelFormat);
const nativeFrameSink=process.env.COVE_FPS_NATIVE_FRAME_SINK??'generator';
if(!['generator','canvas'].includes(nativeFrameSink))throw Error('Invalid native frame sink');
if(nativeFrameSink==='canvas'&&(!nativeGpuEnabled||nativeStorage!=='gpu'||nativePixelFormat!=='bgra'))
  throw Error('Canvas handoff requires explicit native GPU BGRA measurement');
const stockCaptureKeepaliveFlag=process.env.COVE_FPS_STOCK_CAPTURE_KEEPALIVE??'0';
if(!['0','1'].includes(stockCaptureKeepaliveFlag))throw Error('Invalid stock capture keepalive diagnostic');
const stockCaptureKeepalive=stockCaptureKeepaliveFlag==='1';
if(stockCaptureKeepalive&&nativeFrameSink!=='canvas')throw Error('Stock capture keepalive is only a Canvas upgrade diagnostic');
const preloadFrameTimingFlag=process.env.COVE_FPS_PRELOAD_TIMING??'0';
if(!['0','1'].includes(preloadFrameTimingFlag))throw Error('Invalid CPU preload timing option');
const preloadFrameTiming=preloadFrameTimingFlag==='1';
const cpuOwnership=process.env.COVE_FPS_CPU_OWNERSHIP??'final-ack';
if(!['final-ack','copy-complete'].includes(cpuOwnership))throw Error('Invalid CPU buffer ownership');
const cpuDeliveryScheduling=process.env.COVE_FPS_CPU_DELIVERY_SCHEDULING??'immediate';
if(!['immediate','yield'].includes(cpuDeliveryScheduling))throw Error('Invalid CPU delivery scheduling');
const nativeCompletion=nativePerformanceCompletion(process.env,nativeGpuEnabled);
if(process.env.COVE_FPS_GENERATED_NV12!==undefined&&!['0','1'].includes(process.env.COVE_FPS_GENERATED_NV12))throw Error('Invalid generated NV12 option');
const generatedNv12Enabled=process.env.COVE_FPS_GENERATED_NV12==='1';
if(generatedNv12Enabled&&(nativeGpuEnabled||process.env.COVE_FPS_NATIVE_GPU!=='0'))throw Error('Generated NV12 requires explicit COVE_FPS_NATIVE_GPU=0');
if(process.env.COVE_NATIVE_GPU_CAPTURE_TIMING&&!['0','1'].includes(process.env.COVE_NATIVE_GPU_CAPTURE_TIMING))throw Error('Invalid native timing option');
const nativeTimingEnabled=process.env.COVE_NATIVE_GPU_CAPTURE_TIMING==='1';
if(nativeCompletion==='fence'&&!nativeTimingEnabled)throw Error('Fence measurement requires COVE_NATIVE_GPU_CAPTURE_TIMING=1 for actual helper completion evidence');
const nativeController=nativeGpuEnabled?new (require(path.join(root,nativePaths.broker)).NativeScreenCaptureController)({enabled:true,helperPath:path.join(root,nativePaths.helper),timing:nativeTimingEnabled,pixelFormat:nativePixelFormat,storage:nativeStorage,cpuDeliveryScheduling,cpuOwnership,
  ...(nativeCompletion!==undefined?{completion:nativeCompletion}:{})}):null;
// Test-only aggregate around the existing stdout callback. Retain no payload,
// handle, serial or session data; a tag count is not a parsed-frame count.
const nativeChunkTiming={callbacks:0,frameTagBuckets:[0,0,0,0],totalMs:0,maxMs:0,
  meaning:'Main stdout callback wall time; frame-tag buckets are 0,1,2,3-or-more. Yield-mode work occurs after this callback.'};
if(nativeController&&nativeTimingEnabled){
  const receive=nativeController.receive;
  const tag=Buffer.from('"type":"frame"');
  nativeController.receive=function(session,chunk){
    let count=0,offset=0;
    if(Buffer.isBuffer(chunk)){while((offset=chunk.indexOf(tag,offset))>=0){count++;offset+=tag.length;}}
    const started=performance.now();
    try{return receive.call(this,session,chunk);}
    finally{const elapsed=performance.now()-started;nativeChunkTiming.callbacks++;
      nativeChunkTiming.frameTagBuckets[Math.min(3,count)]++;nativeChunkTiming.totalMs+=elapsed;
      nativeChunkTiming.maxMs=Math.max(nativeChunkTiming.maxMs,elapsed);}
  };
}
if(process.env.COVE_FPS_NATIVE_LIFECYCLE_CHECKS&&!['0','1'].includes(process.env.COVE_FPS_NATIVE_LIFECYCLE_CHECKS))throw Error('Invalid native lifecycle option');
const nativeLifecycleEnabled=process.env.COVE_FPS_NATIVE_LIFECYCLE_CHECKS==='1';
if(nativeLifecycleEnabled&&!nativeGpuEnabled)throw Error('Native lifecycle checks require COVE_FPS_NATIVE_GPU=1 without the disable override');
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
if(process.env.COVE_FPS_MINIMIZE_SENDER&&!['0','1'].includes(process.env.COVE_FPS_MINIMIZE_SENDER))throw Error('Invalid minimized-sender option');
const minimizeSender=process.env.COVE_FPS_MINIMIZE_SENDER==='1';
if(minimizeSender&&peerRenderMode!=='hidden')throw Error('Minimized-sender checks require an ordinary publisher window');
const minimizedThrottlingFlag=process.env.COVE_FPS_MINIMIZED_THROTTLING??'1';
if(!['0','1'].includes(minimizedThrottlingFlag))throw Error('Invalid minimized background policy diagnostic');
const minimizedThrottling=minimizedThrottlingFlag==='1';
const minimizedVisibilityMatches=value=>minimizedThrottling?value==='hidden':['hidden','visible'].includes(value);
const minimizedViewerMode=process.env.COVE_FPS_MINIMIZED_VIEWER??'hidden';
if(!['offscreen','hidden'].includes(minimizedViewerMode))throw Error('Invalid minimized observer mode');
const preventDisplaySleep=performanceDisplaySleepPrevention(process.env,null,minimizeSender);
const patternReadbackMode=process.env.COVE_FPS_PATTERN_READBACK??'full';
if(!['full','roi'].includes(patternReadbackMode))throw Error('Invalid owned-pattern readback mode');
if(process.env.COVE_FPS_LOW_OBSERVER!==undefined&&!['0','1'].includes(process.env.COVE_FPS_LOW_OBSERVER))throw Error('Invalid low-observer option');
const lowObserverMode=process.env.COVE_FPS_LOW_OBSERVER==='1';
// Full GPU enumeration can synchronously load drivers on the active GPU main
// thread. Keep it out of measured capture; explicit opt-in is a diagnostic.
const liveGpuInfoFlag=process.env.COVE_FPS_LIVE_GPU_INFO??'0';
if(!['0','1'].includes(liveGpuInfoFlag))throw Error('Invalid live GPU info diagnostic');
const liveGpuInfo=liveGpuInfoFlag==='1';
const captureTraceEnabled=process.env.COVE_FPS_CONTENT_TRACE==='1';
if(process.env.COVE_FPS_CONTENT_TRACE&&!['0','1'].includes(process.env.COVE_FPS_CONTENT_TRACE))throw Error('Invalid content trace option');
const captureTracePhase=nativePerformanceTracePhase(process.env,nativeGpuEnabled);
if(process.env.COVE_FPS_CAPTURE_LOGS==='1'){app.commandLine.appendSwitch('enable-logging','file');app.commandLine.appendSwitch('log-file',path.join(directory,'native-capture.log'));app.commandLine.appendSwitch('vmodule','desktop_capture_device=2');}
const rendererBackgroundingFlag=process.env.COVE_FPS_DISABLE_RENDERER_BACKGROUNDING;
if(rendererBackgroundingFlag!==undefined&&!['0','1'].includes(rendererBackgroundingFlag))throw Error('Invalid renderer backgrounding diagnostic');
const rendererBackgroundingDisabled=rendererBackgroundingFlag==='1';
if(rendererBackgroundingDisabled)app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Do not use --use-fake-device-for-media-stream: Chromium also replaces native
// getDisplayMedia with a 1000x564 test source. The renderer supplies test audio.
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={passed:false,startedAt:new Date().toISOString(),captureFeatures,disabledCaptureFeatures,peerRenderMode,profilingOnly:captureTraceEnabled,captureTracePhase,
  generatedNv12Enabled,generatedNv12Meaning:generatedNv12Enabled?'Controlled generated CPU NV12 source: full coded dimensions with equal 1728x1080 active content, no desktop capture claim.':null,
  minimizedSenderRequested:minimizeSender,rendererBackgroundingDisabled:app.commandLine.hasSwitch('disable-renderer-backgrounding'),
  minimizedSenderExpectedBackgroundThrottling:minimizeSender?minimizedThrottling:null,
  minimizedViewerMode:minimizeSender?minimizedViewerMode:null,
  stockCaptureKeepaliveDiagnostic:stockCaptureKeepalive,
  liveGpuInfoRequested:liveGpuInfo,
  powerDiagnostics:{monitorAvailable:false,systemIdleTimeSeconds:null,events:{suspend:0,resume:0,lockScreen:0,unlockScreen:0}},
  displaySleepPrevention:{requested:preventDisplaySleep,started:false,activeAtStart:null,active:false,stopped:null},
  nativeGpu:{requested:process.env.COVE_FPS_NATIVE_GPU==='1',enabled:nativeGpuEnabled,requestedPixelFormat:nativePixelFormat,requestedStorage:nativeStorage,cpuDeliveryScheduling,cpuOwnership,preloadFrameTiming,nativeChunkTiming,requestedCompletion:nativeCompletion??null,variant:process.env.COVE_FPS_NATIVE_VARIANT??null,startAttempts:[],stopRequests:[],stopRequestsDropped:0,snapshots:[],paths:nativePaths,
    helperTiming:{enabled:nativeTimingEnabled,schemaVersion:1,maximumSamples:120,records:[],collectors:[],limited:false,
      timingMeaning:'Stage totalUs/maxUs are wall-clock microseconds, not GPU compute time.',
      cpuReadbackBoundaryMeaning:'When cpuMapAttempts is reported, cpuMapWait covers Map/input-pump/timer waiting and cpuReadback covers row copy plus Unmap. Older helpers can include Map waiting in cpuReadback; these stage totals have different measurement boundaries.'},
    helperStartup:{enabled:nativeTimingEnabled,schemaVersion:1,maximumSamples:120,records:[],collectors:[],limited:false,
      timingMeaning:'Independent helper startup wall-clock microseconds; stages do not contribute to loop timing statistics.'}},
  nativeLifecycleRequested:nativeLifecycleEnabled,
  presentationMeaning:peerRenderMode==='hidden'?'Hidden regular windows may present zero frames; presentation is not a throughput or physical scan-out claim.':'Offscreen video/compositor counters are not physical display scan-out.',
  personalPixelsRetained:false,patternReadbackMode,lowObserverMode,
  sourceAge:{enabled:sourceAgeEnabled,historyCapacity:sourceAgeEnabled?4096:0,
    meaning:'Opt-in controlled-source draw-start to HTML video immutable snapshot age estimate, including paint/capture/encode/local SFU/decode. Both clocks use Chromium performance.timeOrigin plus their local performance/rAF timestamp; Node clocks are not used. Snapshot time is taken before copyTo. This is not calibrated end-to-end latency, glass-to-glass latency or physical scan-out; approximately 1 Hz small-sample quantiles do not establish a latency tail or strict cross-renderer clock accuracy.'},
  mainObserverMeaning:'Every sample retains real peer getStats, owned-pixel checks, native broker evidence and source frame counters. Low observer mode collects full CPU/window state only at the first and last samples and defers sample-loop JSON writes until completion/failure. Main stage durations are local wall milliseconds; skipped stages are null. Observer changes are harness overhead comparisons, not product performance gains.',
  observerComparisonMeaning:'Full/ROI readback comparisons measure harness overhead; changing this setting alone is not a product performance gain.',observerMeaning:'Native cases hold one immutable VideoFrame from the existing receiver video per sample (normally 1 Hz), copy full RGBA or five RGBA regions according to patternReadbackMode, classify the same twenty points, zero temporary buffers and close the frame; snapshot/copy/read wallclock and resource counts are saved separately. No per-frame readback.',
  scope:'two real Chromium peers, product media hooks, isolated loopback SFU; changing generated/native source',endToEndLatencyMeasured:false,
  startupJournal:{maximumEntries:128,droppedEntries:0,entries:[]},lifecycleEvents:[],lifecycleEventsDropped:0,cases:[]};
let backend,sourceWindow;const peers=[];let finished=false,shuttingDown=false;let nativeRequests=0;let captureTarget='window';let selectedCaptureSource=null;
let displaySleepBlockerId=null;
const watchdog=setTimeout(()=>void finish(Error('Performance watchdog expired')),330000);
process.on('message',message=>{if(message?.type==='stop')void finish(Error('Performance measurement was interrupted'));});
function save(timing){
  const started=performance.now(),payload=JSON.stringify(result,null,2)+'\n',serialized=performance.now();
  try{fs.writeFileSync(path.join(directory,'result.json'),payload);}
  finally{if(timing){const ended=performance.now();Object.assign(timing,{performed:true,serializeMs:serialized-started,writeMs:ended-serialized,totalMs:ended-started});}}
}
function systemIdleTimeSeconds(){
  try{const value=powerMonitor?.getSystemIdleTime();return Number.isFinite(value)&&value>=0?value:null;}catch{return null;}
}
function installPowerDiagnostics(){
  result.powerDiagnostics.monitorAvailable=typeof powerMonitor?.getSystemIdleTime==='function';
  result.powerDiagnostics.systemIdleTimeSeconds=systemIdleTimeSeconds();
  if(typeof powerMonitor?.on==='function')for(const [event,key] of [['suspend','suspend'],['resume','resume'],['lock-screen','lockScreen'],['unlock-screen','unlockScreen']])
    powerMonitor.on(event,()=>{result.powerDiagnostics.events[key]++;result.powerDiagnostics.systemIdleTimeSeconds=systemIdleTimeSeconds();save();});
}
function startOwnedDisplaySleepBlocker(){
  if(!preventDisplaySleep||displaySleepBlockerId!==null)return;
  const state=sourceWindowState();
  if(!state?.visible||state.minimized||!state.focused)throw Error('Display sleep prevention requires the owned native source in the foreground');
  if(typeof powerSaveBlocker?.start!=='function'||typeof powerSaveBlocker?.stop!=='function'||typeof powerSaveBlocker?.isStarted!=='function')
    throw Error('Display sleep prevention API is unavailable');
  displaySleepBlockerId=powerSaveBlocker.start('prevent-display-sleep');
  result.displaySleepPrevention.started=true;result.displaySleepPrevention.active=powerSaveBlocker.isStarted(displaySleepBlockerId);
  result.displaySleepPrevention.activeAtStart=result.displaySleepPrevention.active;
  save();if(!result.displaySleepPrevention.active)throw Error('Owned display sleep prevention did not become active');
}
function releaseOwnedDisplaySleepBlocker(){
  if(displaySleepBlockerId===null)return;
  try{powerSaveBlocker.stop(displaySleepBlockerId);}catch{}
  try{result.displaySleepPrevention.active=powerSaveBlocker.isStarted(displaySleepBlockerId);
    if(!result.displaySleepPrevention.active){displaySleepBlockerId=null;result.displaySleepPrevention.stopped=true;}}
  catch{result.displaySleepPrevention.active=null;result.displaySleepPrevention.stopped=null;}
}
app.on('will-quit',releaseOwnedDisplaySleepBlocker);
function lifecycleReason(value){return ['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction'].includes(value)?value:'unknown';}
function lifecycleExitCode(value){return Number.isSafeInteger(value)?value:null;}
function recordLifecycleEvent(event){
  if(result.lifecycleEvents.length<64)result.lifecycleEvents.push({at:Date.now(),...event});
  else result.lifecycleEventsDropped++;
  save();
}
function rendererNavigationClass(value){
  try{return new URL(value).origin===new URL(process.env.COVE_QA_RENDERER_URL).origin?'sameRendererOrigin':'other';}
  catch{return 'invalid';}
}
function observePeerLifecycle(win,index){
  win.webContents.on('render-process-gone',(_event,details)=>{
    const reason=lifecycleReason(details?.reason),exitCode=lifecycleExitCode(details?.exitCode);
    recordLifecycleEvent({event:'render-process-gone',index,reason,exitCode});
    if(finished||shuttingDown)return;
    const error=Error('Owned peer renderer exited: index='+index+', reason='+reason+', exitCode='+(exitCode??'unknown'));
    result.error=error.message;save();void finish(error);
  });
  win.webContents.on('did-start-navigation',(details,url,isInPlace,isMainFrame)=>{
    if((typeof details?.isMainFrame==='boolean'?details.isMainFrame:isMainFrame)!==true)return;
    recordLifecycleEvent({event:'did-start-navigation',index,
      inPlace:typeof details?.isSameDocument==='boolean'?details.isSameDocument:isInPlace===true,
      urlClass:rendererNavigationClass(typeof details?.url==='string'?details.url:url)});
  });
}
app.on('child-process-gone',(_event,details)=>{
  const type=['Utility','Zygote','Sandbox helper','GPU','Pepper Plugin','Pepper Plugin Broker','Unknown'].includes(details?.type)?details.type:'Unknown';
  recordLifecycleEvent({event:'child-process-gone',type,reason:lifecycleReason(details?.reason),exitCode:lifecycleExitCode(details?.exitCode)});
});
function brokerSnapshot(){return nativeBrokerSnapshot(nativeController);}
function activeNativeHelperIndex(){
  const active=nativeController?.sessions instanceof Set?[...nativeController.sessions].filter(owned=>owned.active&&!owned.closed&&owned.target===peers[0]?.webContents):[];
  return active.length===1?helperTimingSessionIndexes.get(active[0].child):undefined;
}
function currentNativeHelperTiming(broker){
  const mode=broker?.frameStorage==='gpu'?'gpu':broker?.frameStorage==='cpu'?broker.cpuOwnership:null;
  return nativeHelperTimingSnapshot(result.nativeGpu.helperTiming.records,activeNativeHelperIndex(),mode);
}
function nativeEvidence(sample,broker){
  const evidence=nativeUpgradeEvidence(sample,broker,nativePixelFormat,nativeStorage);
  const sessionIndex=activeNativeHelperIndex();
  const completion=nativeHelperCompletionEvidence([...result.nativeGpu.helperStartup.records,...result.nativeGpu.helperTiming.records],nativeCompletion,sessionIndex);
  const scheduling={expected:cpuDeliveryScheduling,selected:broker?.cpuDeliveryScheduling??null,
    matched:nativeStorage!=='cpu'||broker?.cpuDeliveryScheduling===cpuDeliveryScheduling};
  const ownership={expected:cpuOwnership,selected:broker?.cpuOwnership??null,
    matched:nativeStorage!=='cpu'||broker?.cpuOwnership===cpuOwnership};
  const boundedBuffers=nativeStorage!=='cpu'||cpuOwnership!=='copy-complete'||
    ['activeNativeLeases','mainBuffersInUse','cpuFrameBuffers','cpuFramesInFlight'].every(key=>Number.isSafeInteger(broker?.[key])&&broker[key]>=0&&broker[key]<=3)&&
    Number.isSafeInteger(broker?.pendingFrames)&&broker.pendingFrames>=0&&broker.pendingFrames<=1;
  const frameSink={expected:nativeFrameSink,selected:sample?.nativeCaptureCounters?.frameSink??'generator'};
  frameSink.matched=frameSink.expected===frameSink.selected;
  return {...evidence,completion,scheduling,ownership,boundedBuffers,frameSink,
    passed:evidence.passed&&completion.matched&&scheduling.matched&&ownership.matched&&boundedBuffers&&frameSink.matched};
}
let gpuAfterPublicationCaptured=false;
async function captureGpuAfterPublication(){
  if(gpuAfterPublicationCaptured)return;gpuAfterPublicationCaptured=true;
  Object.assign(result.environment,{gpuAfterPublication:null,gpuAfterPublicationStatus:'pending',
    gpuFeatureStatusAfterPublication:null,hardwareAccelerationEnabled:null,
    gpuAfterPublicationCollectionStage:'First case after publication/native upgrade and before warmup; no diagnostic WebGL context created.',
    gpuCommandLineSwitches:Object.fromEntries(['disable-gpu','disable-gpu-compositing','in-process-gpu'].map(name=>[name,app.commandLine.hasSwitch(name)]))});save();
  if(!liveGpuInfo){
    result.environment.gpuAfterPublicationStatus='skipped-owned-control';
    result.environment.gpuAfterPublicationCollectionStage='Explicit control skips GPU collection during live capture; startup basic GPU information is retained.';
    save();return;
  }
  try{result.environment.gpuAfterPublication=await traceOperation(app.getGPUInfo('complete'),5000,'Post-publication GPU info');
    result.environment.gpuAfterPublicationStatus='recorded';}
  catch{result.environment.gpuAfterPublicationStatus='unknown';}
  try{result.environment.gpuFeatureStatusAfterPublication=app.getGPUFeatureStatus();}catch{}
  try{if(typeof app.isHardwareAccelerationEnabled==='function')result.environment.hardwareAccelerationEnabled=app.isHardwareAccelerationEnabled();}catch{}
  result.environment.gpuAfterPublicationCollectedAt=new Date().toISOString();save();
}
async function recordStartupSample(sender,phase){
  const journal=result.startupJournal;
  if(journal.entries.length>=journal.maximumEntries){journal.droppedEntries++;save();return;}
  const entry={phase,at:Date.now(),sampleStatus:'pending',sample:null,nativeGpuBefore:brokerSnapshot(),nativeGpuAfter:null,
    systemIdleTimeSeconds:systemIdleTimeSeconds(),displaySleepPreventionActive:result.displaySleepPrevention.active,
    ownedSource:{sampleStatus:'pending',metadata:null,windowState:sourceWindowState()}};
  journal.entries.push(entry);save();
  await Promise.allSettled([(async()=>{
    if(!sender||sender.isDestroyed()){entry.sampleStatus='renderer_unavailable';return;}
    try{entry.sample=await boundedJs(sender,'window.coveScreenPerformance.sample()',3000);entry.sampleStatus='recorded';}
    catch{entry.sampleStatus='bounded_sample_failed';}
  })(),(async()=>{
    if(!sourceWindow||sourceWindow.isDestroyed()){entry.ownedSource.sampleStatus='renderer_unavailable';return;}
    try{entry.ownedSource.metadata=await boundedJs(sourceWindow,`({sourceFrames:Number.isSafeInteger(window.sourceFrames)&&window.sourceFrames>=0?window.sourceFrames:null,
      performanceNow:performance.now(),documentVisibilityState:['visible','hidden','prerender'].includes(document.visibilityState)?document.visibilityState:'unknown'})`,1000);
      entry.ownedSource.sampleStatus='recorded';}
    catch{entry.ownedSource.sampleStatus='bounded_sample_failed';}
  })()]);
  entry.nativeGpuAfter=brokerSnapshot();save();
}
async function startOwnedScreenShare(sender,config,phase,timeoutMs=30000){
  await boundedJs(sender,`window.coveMediaQA.rtc.startScreenShare(...${JSON.stringify(screenShareStartArguments(config))})`,timeoutMs);
  // Save the returned operation's actual state before a localScreen wait can
  // time out, including alerts, stock stop provenance and current RTC flags.
  await recordStartupSample(sender,phase);
}
const helperTimingChildren=new WeakSet(),helperTimingSessionIndexes=new WeakMap();
function attachNativeHelperTiming(){
  if(!nativeTimingEnabled||!(nativeController?.sessions instanceof Set))return;
  for(const owned of nativeController.sessions){
    const child=owned.child;
    if(owned.target!==peers[0]?.webContents||!child?.stderr||helperTimingChildren.has(child))continue;
    helperTimingChildren.add(child);
    const timing=result.nativeGpu.helperTiming,sessionIndex=timing.collectors.length+1;
    helperTimingSessionIndexes.set(child,sessionIndex);
    const state={sessionIndex,samples:0,rejectedLines:0,limited:false,pendingBytes:0};timing.collectors.push(state);
    const startup=result.nativeGpu.helperStartup,startupState={sessionIndex,samples:0,rejectedLines:0,limited:false,pendingBytes:0};
    startup.collectors.push(startupState);
    const collector=createNativeTimingCollector(sample=>{
      if(timing.records.length<timing.maximumSamples)timing.records.push({sessionIndex,...sample});
      else timing.limited=true;
    },timing.maximumSamples);
    const startupCollector=createNativeStartupCollector(sample=>{
      if(startup.records.length<startup.maximumSamples)startup.records.push({sessionIndex,...sample});
      else startup.limited=true;
    },startup.maximumSamples);
    const receive=chunk=>{collector.write(chunk);Object.assign(state,collector.snapshot());timing.limited||=state.limited||timing.records.length>=timing.maximumSamples;
      startupCollector.write(chunk);Object.assign(startupState,startupCollector.snapshot());startup.limited||=startupState.limited||startup.records.length>=startup.maximumSamples;};
    child.stderr.on('data',receive);
    child.stderr.once('end',()=>{child.stderr.off('data',receive);Object.assign(state,collector.snapshot());Object.assign(startupState,startupCollector.snapshot());});
  }
}
async function waitNativeResources(timeoutMs=2500){
  let snapshot=brokerSnapshot();const until=Date.now()+timeoutMs;
  while(snapshot&&!nativeResourcesReleased(snapshot)&&Date.now()<until){await delay(50);snapshot=brokerSnapshot();}
  return snapshot;
}
async function waitNativeUpgrade(sender,viewer,measured,phase,budgetMs=null){
  const until=Date.now()+(budgetMs??7000);let sample,evidence;
  do{
    sample=await boundedJs(sender,'window.coveScreenPerformance.sample()',budgetMs===null?30000:Math.min(3000,Math.max(1,until-Date.now())));
    const broker=brokerSnapshot();evidence=nativeEvidence(sample,broker);
    measured.nativeGpu={...measured.nativeGpu,phase,broker,evidence};
    measured.nativeUpgradeSucceeded=evidence.passed;save();
    if(evidence.passed)return;
    if(broker?.disabled)break;
    await delay(100);
  }while(Date.now()<until);
  measured.nativeGpu.failureSender=sample;
  measured.nativeGpu.failureCode=brokerSnapshot()?.failureCode??result.nativeGpu.startAttempts.at(-1)?.reason??'upgrade_not_observed';
  measured.nativeGpu.stockFallbackStillLive=sample?.sources?.some(source=>source.kind==='native-display-capture'&&source.trackState==='live'&&source.isLiveSenderSource)===true;
  if(measured.nativeGpu.stockFallbackStillLive){
    const first=await boundedJs(viewer,'window.coveScreenPerformance.sample()');await delay(350);
    const last=await boundedJs(viewer,'window.coveScreenPerformance.sample()');
    const playback=stockFallbackPlaybackEvidence(first,last);
    measured.nativeGpu.stockFallbackDecodedFrames=playback.decodedFramesDelta;
    measured.nativeGpu.stockFallbackDecodedFramesDelta=playback.decodedFramesDelta;
    measured.nativeGpu.stockFallbackSequenceAdvanced=playback.sequenceAdvanced;
    measured.nativeGpu.stockFallbackPatternMatched=playback.markersMatched;
    measured.nativeGpu.stockFallbackPlaybackContinues=playback.playbackContinues;
  }
  save();throw Error('Native GPU upgrade was not observed; stock fallback is not a native performance pass ('+measured.nativeGpu.failureCode+')');
}
async function nativeLifecyclePeerState(win){
  // IDs are compared only in main memory. Result evidence contains booleans and
  // resource counts, never ICE credentials, media pixels or native handles.
  return boundedJs(win,`(async()=>{const qa=window.coveMediaQA,rtc=qa.rtc;return {
    inVoice:rtc.inVoice,isSharing:rtc.isSharing,isWatchingScreen:rtc.isWatchingScreen,
    localScreen:!!rtc.localScreen,remoteScreen:!!rtc.remoteScreen,localScreenProducerId:rtc.localScreenProducerId,
    screenViewerCount:rtc.screenViewerCount,shareAudio:rtc.shareAudio,isMuted:rtc.isMuted,
    applicationAudioSharing:rtc.isApplicationAudioSharing,screenPreset:rtc.screenPreset,fps:rtc.fps,
    publications:rtc.availableScreens.map(s=>({videoProducerId:s.videoProducerId,audioProducerId:s.audioProducerId??null})),
    transports:qa.ice.snapshot(),audio:await qa.ice.audioProgress(),resources:qa.resources()};})()`,3000);
}
async function runNativeLifecycle(sender,viewer,config,measured){
  const lifecycle={required:true,passed:false,startedAt:Date.now(),maximumMs:100000,steps:[],
    staticMeaning:'Frozen owned canvas pixels and sequence are expected to remain unchanged; this stage checks refresh delivery to a new consumer, not advancing source pixels.',
    audioScope:'Synthetic fixture microphone/voice remains connected; screen/system audio is disabled throughout.'};
  measured.nativeLifecycle=lifecycle;save();
  const deadline=lifecycle.startedAt+lifecycle.maximumMs;
  const check=(condition,message)=>{if(!condition)throw Error('Native lifecycle: '+message);};
  const remaining=()=>{const ms=deadline-Date.now();check(ms>0,'bounded lifecycle deadline expired');return ms;};
  const until=async(predicate,label,limit=8000)=>{const end=Date.now()+Math.min(remaining(),limit);do{if(await predicate())return;await delay(100);}while(Date.now()<end);throw Error('Native lifecycle: timed out waiting for '+label);};
  const stage=name=>{const value={name,startedAt:Date.now(),passed:false,nativeBefore:brokerSnapshot()};lifecycle.steps.push(value);save();return value;};
  const finishStage=value=>{value.nativeAfter=brokerSnapshot();value.elapsedMs=Date.now()-value.startedAt;value.passed=true;save();};
  const samplePeer=win=>boundedJs(win,'window.coveScreenPerformance.sample()',3000);
  const pattern=sample=>sample.ownedPattern?.markersMatched?.length===4&&sample.ownedPattern.markersMatched.every(Boolean);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const producerIds=state=>state.transports.flatMap(transport=>transport.producers.map(producer=>producer.id)).sort();
  const voiceIdentity=(state,screenId)=>({transports:state.transports.map(transport=>transport.id).sort(),
    producers:producerIds(state).filter(id=>id!==screenId),shareAudio:state.shareAudio,isMuted:state.isMuted,
    applicationAudioSharing:state.applicationAudioSharing});
  const baseline=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);
  const producerId=baseline[0].localScreenProducerId;
  check(typeof producerId==='string'&&baseline[1].publications.length===1&&baseline[1].publications[0].videoProducerId===producerId,'current producer identity is unavailable');
  check(baseline.every(state=>state.inVoice&&state.shareAudio===false),'both peers must have voice with screen audio disabled');
  const originalVoice=baseline.map(state=>voiceIdentity(state,producerId));
  let previousAudio=baseline.map(state=>state.audio);
  const voiceCheck=async(expectedScreenId=producerId)=>{
    const states=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);
    const identityUnchanged=states.every((state,index)=>state.inVoice&&same(voiceIdentity(state,expectedScreenId),originalVoice[index]));
    const audioProgress=states.every((state,index)=>state.audio.packets>previousAudio[index].packets&&state.audio.nonConcealedSamples>previousAudio[index].nonConcealedSamples);
    check(identityUnchanged,'voice/audio identity changed');check(audioProgress,'voice decoded audio did not progress');
    previousAudio=states.map(state=>state.audio);return {inVoice:true,identityUnchanged,audioProgress};
  };
  const samePublication=async()=>{
    const states=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);
    return states[0].localScreenProducerId===producerId&&same(producerIds(states[0]),producerIds(baseline[0]))&&
      states[1].publications.length===1&&states[1].publications[0].videoProducerId===producerId;
  };
  const settleNative=()=>until(async()=>{const snapshot=brokerSnapshot();return snapshot?.sessions===1&&snapshot.activeSessions===1&&snapshot.helpers===1&&snapshot.childHandles===1;},'one native session with old sessions released',3500);
  try{
    check(measured.comparisonContract.passed&&measured.nativeBaseline.passed&&measured.nativeUpgradeSucceeded,'performance prerequisites did not pass');
    const before=await samplePeer(viewer);check(before.currentVideo&&pattern(before),'initial receiver/pattern evidence is unavailable');
    const staticStep=stage('static-late-viewer');
    const requestsBefore=nativeRequests,refreshBefore=brokerSnapshot().refreshFrames;
    await boundedJs(sourceWindow,'window.sourceFrozen=true;void 0',2000);
    try{
      const frozenFrames=await boundedJs(sourceWindow,'window.sourceFrames',2000);
      await boundedJs(viewer,'window.coveMediaQA.rtc.stopWatchingScreen();void 0',2000);
      await until(async()=>{const state=await nativeLifecyclePeerState(viewer);return !state.isWatchingScreen&&!state.remoteScreen&&state.resources.liveConsumers===baseline[1].resources.liveConsumers-1;},'viewer video consumer stopped');
      await until(async()=>{const state=await nativeLifecyclePeerState(sender);return state.screenViewerCount===0&&state.localScreenProducerId===producerId;},'no screen viewers');
      const idleStarted=Date.now();await delay(1100);
      check(await samePublication(),'late-viewer idle replaced the producer');
      const idleState=await nativeLifecyclePeerState(sender);
      check(idleState.transports.flatMap(transport=>transport.producers).some(producer=>producer.id===producerId&&producer.paused===true),'unwatched producer was not paused');
      const idleBroker=brokerSnapshot(),idleMs=Date.now()-idleStarted;
      await boundedJs(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)',5000);
      let fresh,progressed;
      await until(async()=>{fresh=await samplePeer(viewer);return fresh.currentVideo?.trackToken!==before.currentVideo.trackToken&&fresh.currentVideo?.framesDecoded>0&&pattern(fresh);},'new static consumer decoded controlled pixels');
      const initialDecoded=fresh.currentVideo.framesDecoded;
      await until(async()=>{progressed=await samplePeer(viewer);return progressed.currentVideo?.trackToken===fresh.currentVideo.trackToken&&progressed.currentVideo.framesDecoded>initialDecoded&&pattern(progressed);},'static refresh decode progress');
      check(await boundedJs(sourceWindow,'window.sourceFrames',2000)===frozenFrames,'owned static counter advanced');
      check(progressed.ownedPattern.capturedSequence===frozenFrames%65536,'late consumer did not receive the frozen owned sequence');
      const refreshAdded=brokerSnapshot().refreshFrames-refreshBefore;
      // A frozen canvas does not force DWM to stop presenting the desktop.
      // Keep the real late-viewer assertion separate from whether this OS run
      // exercised our no-present heartbeat branch. Never claim that branch ran
      // merely because the owned pixels/counter were static.
      if(refreshAdded===0){
        lifecycle.unverifiedBranches=['forced-no-desktop-present-idle-refresh'];
        if(process.env.COVE_FPS_REQUIRE_IDLE_REFRESH==='1')
          throw Error('Native lifecycle: OS continued desktop updates; forced idle refresh was not exercised');
      }
      check(nativeRequests===requestsBefore&&await samePublication(),'late viewer requested capture or replaced the producer');
      Object.assign(staticStep,{idleMs,idleBroker,sourceCounterUnchanged:true,newConsumerTrack:true,
        producerUnchanged:true,producerPausedWhileIdle:true,captureRequestsAdded:0,decodedFramesAdded:progressed.currentVideo.framesDecoded-initialDecoded,
        patternMatched:true,frozenSequenceMatched:true,refreshFramesAdded:refreshAdded,idleRefreshBranchObserved:refreshAdded>0,
        voice:await voiceCheck()});finishStage(staticStep);
    }finally{await boundedJs(sourceWindow,'if(window.sourceFrozen){window.sourceFrozen=false;requestAnimationFrame(draw);}void 0',2000);}

    const stableConsumer=(await samplePeer(viewer)).currentVideo;
    check(stableConsumer,'configuration-change receiver is unavailable');
    const backendBeforeUpdates=await backendSnapshot();
    for(let cycle=0;cycle<3;cycle++)for(const target of [{preset:'720p',fps:60,width:1152,height:720},{preset:'540p',fps:120,width:864,height:540}]){
      remaining();const step=stage('configuration-'+(cycle+1)+'-'+target.preset+'-'+target.fps);
      const requests=nativeRequests,prior=await samplePeer(viewer),targetConfig={...config,preset:target.preset,fps:target.fps};
      check(prior.currentVideo,'current consumer disappeared before a configuration update');
      await boundedJs(sender,`window.coveMediaQA.rtc.updateScreenShare(...${JSON.stringify(screenShareStartArguments(targetConfig))})`,Math.min(remaining(),12000));
      await waitNativeUpgrade(sender,viewer,measured,step.name,Math.min(remaining(),7000));await settleNative();
      let send,receive;
      await until(async()=>{
        [send,receive]=await Promise.all([samplePeer(sender),samplePeer(viewer)]);
        const outgoing=linkedVideoReport(send,'outbound'),incoming=linkedVideoReport(receive,'inbound');
        return outgoing?.frameWidth===target.width&&outgoing.frameHeight===target.height&&incoming?.frameWidth===target.width&&incoming.frameHeight===target.height&&
          receive.currentVideo?.trackToken===stableConsumer.trackToken&&receive.currentVideo.reportId===stableConsumer.reportId&&
          receive.currentVideo.framesDecoded>prior.currentVideo.framesDecoded&&pattern(receive);
      },'updated native encoded/decoded dimensions');
      const backend=await backendSnapshot(),senderState=await nativeLifecyclePeerState(sender);
      check(senderState.screenPreset===target.preset&&senderState.fps===target.fps,'requested configuration was not committed');
      check(nativeRequests===requests+1,'configuration update did not use exactly one stock capture selection');
      check(await samePublication()&&backend.producers===backendBeforeUpdates.producers,'configuration update replaced or added a producer');
      check(backend.consumers===backendBeforeUpdates.consumers,'configuration update replaced the viewer subscription');
      Object.assign(step,{configuration:{preset:target.preset,fps:target.fps},encoded:{width:target.width,height:target.height},
        decoded:{width:target.width,height:target.height},consumerTrackUnchanged:true,producerUnchanged:true,
        captureRequestsAdded:nativeRequests-requests,oldNativeSessionsReleased:true,patternMatched:true,backend,
        voice:await voiceCheck()});finishStage(step);
    }

    const fault=stage('owned-native-helper-exit'),beforeFault=await samplePeer(viewer),requestsBeforeFault=nativeRequests;
    const beforeKill=brokerSnapshot();
    // TS private fields compile to ordinary properties. This test-main-only
    // probe signals the exact ChildProcess owned by this active broker session;
    // no PID lookup, process-name selection or product test API is involved.
    const ownedSessions=nativeController.sessions instanceof Set?[...nativeController.sessions].filter(value=>value.active&&!value.closed&&value.target===sender.webContents):[];
    check(ownedSessions.length===1&&ownedSessions[0].child&&typeof ownedSessions[0].child.kill==='function','the exact active owned helper is unavailable');
    check(ownedSessions[0].child.exitCode===null&&ownedSessions[0].child.signalCode===null,'owned helper already exited');
    check(ownedSessions[0].child.kill()===true,'owned helper exit request failed');
    await until(async()=>{const states=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);return states[0].localScreen===false&&states[0].isSharing===false&&states[1].publications.length===0&&states.every(state=>state.inVoice);},'helper failure stopped sharing and retained voice');
    await until(async()=>nativeResourcesReleased(brokerSnapshot()),'native resources released after helper failure',4000);
    const stoppedBroker=brokerSnapshot();check(stoppedBroker.disabled&&stoppedBroker.failureCode,'broker did not disable native capture after the owned helper failed');
    await delay(500);
    const stoppedStates=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);
    check(nativeRequests===requestsBeforeFault&&!stoppedStates[0].localScreen&&stoppedStates[1].publications.length===0&&brokerSnapshot().started===beforeKill.started,'capture restarted automatically after helper failure');
    Object.assign(fault,{exactOwnedChildSignalled:true,sharingStopped:true,noAutomaticCaptureForMs:500,captureRequestsAdded:0,
      nativeResourcesReleased:true,stoppedBroker,voice:await voiceCheck(null)});finishStage(fault);

    const fallback=stage('manual-stock-republication-after-native-failure'),requestsBeforeFallback=nativeRequests,attemptsBefore=result.nativeGpu.startAttempts.length;
    await startOwnedScreenShare(sender,config,'manual-stock-republication-returned',Math.min(remaining(),12000));
    await until(async()=>{const state=await nativeLifecyclePeerState(viewer);return state.publications.length===1;},'manual fallback publication');
    await boundedJs(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)',5000);
    let fallbackSample,fallbackProgress;
    await until(async()=>{fallbackSample=await samplePeer(viewer);return fallbackSample.currentVideo?.trackToken!==beforeFault.currentVideo.trackToken&&fallbackSample.currentVideo?.framesDecoded>0&&pattern(fallbackSample);},'fresh stock fallback consumer');
    await until(async()=>{fallbackProgress=await samplePeer(viewer);return fallbackProgress.currentVideo?.trackToken===fallbackSample.currentVideo.trackToken&&fallbackProgress.currentVideo.framesDecoded>fallbackSample.currentVideo.framesDecoded+20&&pattern(fallbackProgress)&&fallbackProgress.ownedPattern.capturedSequence!==fallbackSample.ownedPattern.capturedSequence;},'stock fallback decoded frame and owned sequence progress');
    await until(async()=>result.nativeGpu.startAttempts.length>attemptsBefore,'disabled broker candidate response',2500);
    const fallbackSender=await samplePeer(sender),fallbackState=await nativeLifecyclePeerState(sender),fallbackBroker=brokerSnapshot();
    const currentSource=fallbackSender.sources.find(source=>source.isLiveSenderSource);
    check(currentSource?.kind==='native-display-capture'&&currentSource.trackState==='live'&&!fallbackSender.nativeGpu.upgraded,'manual fallback did not retain stock capture');
    check(nativeRequests===requestsBeforeFallback+1&&typeof fallbackState.localScreenProducerId==='string'&&fallbackState.localScreenProducerId!==producerId,'manual stock publication did not use one new capture and producer');
    check(fallbackBroker.disabled&&fallbackBroker.started===beforeKill.started&&nativeResourcesReleased(fallbackBroker),'manual publication started another native helper');
    Object.assign(fallback,{stockCapture:true,newConsumerTrack:true,newProducer:true,captureRequestsAdded:1,patternMatched:true,
      decodedFramesAdded:fallbackProgress.currentVideo.framesDecoded-fallbackSample.currentVideo.framesDecoded,ownedSequenceAdvanced:true,
      expectedNativeRejection:result.nativeGpu.startAttempts.at(-1)?.ok===false&&result.nativeGpu.startAttempts.at(-1)?.reason==='unavailable',
      nativeRejectionReason:result.nativeGpu.startAttempts.at(-1)?.reason??null,nativeResourcesReleased:true,
      voice:await voiceCheck(fallbackState.localScreenProducerId)});
    check(fallback.expectedNativeRejection,'disabled native candidate did not report rejection');finishStage(fallback);
    await boundedJs(sender,'window.coveMediaQA.rtc.stopScreenShare();void 0',2500);
    await until(async()=>{const states=await Promise.all([nativeLifecyclePeerState(sender),nativeLifecyclePeerState(viewer)]);return !states[0].localScreen&&states[1].publications.length===0;},'manual fallback stop');
    const finalBroker=await waitNativeResources();check(nativeResourcesReleased(finalBroker),'final native resources are not zero');
    remaining();lifecycle.finalNativeSnapshot=finalBroker;lifecycle.finalNativeResourcesReleased=true;lifecycle.passed=true;
    lifecycle.elapsedMs=Date.now()-lifecycle.startedAt;save();
  }catch(error){lifecycle.error=error.message;lifecycle.failedNativeSnapshot=brokerSnapshot();lifecycle.elapsedMs=Date.now()-lifecycle.startedAt;save();throw error;}
  finally{if(sourceWindow&&!sourceWindow.isDestroyed())await boundedJs(sourceWindow,'if(window.sourceFrozen){window.sourceFrozen=false;requestAnimationFrame(draw);}void 0',2000);}
}
let traceStopPromise=null,traceLimitTimer=null;
async function traceOperation(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
async function startOwnedTrace(actualNativeBaseline=null){
  if(!captureTraceEnabled)return;
  const categories=await traceOperation(contentTracing.getCategories(),3000,'Trace category query');
  const processIds=[process.pid,...app.getAppMetrics().map(metric=>metric.pid)];
  const options=captureTraceOptions(processIds,categories);
  result.trace={profilingOnly:true,normalFpsComparisonEligible:false,phase:captureTracePhase,actualNativeBaseline,options,
    reviewedCategoryAllowlist:TRACE_CATEGORIES,availableReviewedCategories:options.included_categories,
    missingReviewedCategories:TRACE_CATEGORIES.filter(category=>!options.included_categories.includes(category)),
    startedAt:new Date().toISOString(),maximumRecordingMs:3000,
    coverage:captureTracePhase==='native-steady'?'First 3 seconds after the real native upgrade and configured warmup; profiling samples are not normal FPS comparisons.':'Capture startup and first 3 seconds only; profiling samples are not normal FPS comparisons.',
    recordingRequested:true,sanitized:false};save();
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
  let nativeGpu=null;
  if(nativeController){
    const afterRendererCleanup=brokerSnapshot(),afterProductCleanup=await waitNativeResources();
    // Audit normal product stop before the safety reset so reset cannot conceal
    // a missing adapter release/stop. Still retire every owned child on failure.
    nativeController.reset();const afterReset=await waitNativeResources();
    nativeGpu={afterRendererCleanup,afterProductCleanup,afterReset,
      productResourcesReleased:nativeResourcesReleased(afterProductCleanup),resetResourcesReleased:nativeResourcesReleased(afterReset)};
    result.nativeGpu.snapshots.push({phase:'cleanup',at:Date.now(),...nativeGpu});save();
  }
  return {renderers,backendResources,rendererResourcesZero,backendResourcesZero,nativeGpu,timeouts:renderers.filter(renderer=>renderer.error).length,
    passed:rendererResourcesZero&&backendResourcesZero&&(!nativeGpu||(nativeGpu.productResourcesReleased&&nativeGpu.resetResourcesReleased))};
}
async function finish(error){
  if(finished)return;finished=true;shuttingDown=true;clearTimeout(watchdog);
  try{
  try{await stopOwnedTrace('finally');}catch(cause){error??=cause;}
  if(error){result.error=error.stack||String(error);console.error(result.error);await recordStartupSample(peers[0],'failure-before-cleanup');}
  try{let timer;try{result.environment.gpuAfter=await Promise.race([app.getGPUInfo('basic'),new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error('GPU info timeout')),2000);})]);}finally{clearTimeout(timer);}result.environment.gpuFeatureStatusAfter=app.getGPUFeatureStatus();}catch{}
  result.cleanup=await cleanupPeers();result.cleanupTimeouts=result.cleanup.timeouts;
  await delay(150);for(const win of peers)if(!win.isDestroyed())win.destroy();if(sourceWindow&&!sourceWindow.isDestroyed())sourceWindow.destroy();
  if(nativeController){
    nativeController.reset();result.nativeGpu.finalSnapshot=await waitNativeResources();
    result.nativeGpu.finalResourcesReleased=nativeResourcesReleased(result.nativeGpu.finalSnapshot);save();
  }
  if(backend&&backend.exitCode===null){if(backend.connected)backend.send({type:'stop'},()=>{});for(let n=0;n<50&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);if(backend.exitCode===null&&backend.signalCode===null){backend.kill();for(let n=0;n<20&&backend.exitCode===null&&backend.signalCode===null;n++)await delay(100);}}
  releaseOwnedDisplaySleepBlocker();
  result.backendStopped=!backend||backend.exitCode!==null||backend.signalCode!==null;result.finishedAt=new Date().toISOString();result.passed=!error&&result.backendStopped&&result.cleanup.passed&&(!nativeController||result.nativeGpu.finalResourcesReleased)&&result.displaySleepPrevention.active===false;save();app.exit(result.passed?0:1);
  }finally{releaseOwnedDisplaySleepBlocker();try{save();}catch{}}
}
const js=(win,code)=>win.webContents.executeJavaScript(code,true);
async function boundedJs(win,code,timeoutMs=30000){let timer;try{return await Promise.race([js(win,code),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Renderer operation timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function wait(win,code,ms=25000){const until=Date.now()+ms;while(Date.now()<until){if(await js(win,code))return;await delay(100);}throw Error('Timed out: '+code);}
function sourceAgeSummary(samples){
  if(!sourceAgeEnabled)return null;
  const observations=samples.slice(0,31).map(sample=>safeSourceAgeObservation(sample.sourceAge));
  const values=observations.filter(value=>value.status==='matched').map(value=>value.ageMs).sort((a,b)=>a-b);
  const rejectedByReason={};for(const value of observations)if(value.status!=='matched')rejectedByReason[value.status]=(rejectedByReason[value.status]??0)+1;
  const rounded=value=>value===null?null:Math.round(value*100)/100;
  const quantile=rank=>values.length?rounded(values[Math.max(0,Math.ceil(values.length*rank)-1)]):null;
  return {sampleCount:observations.length,matchedSamples:values.length,rejectedSamples:observations.length-values.length,rejectedByReason,
    minimumMs:values.length?rounded(values[0]):null,meanMs:values.length?rounded(values.reduce((a,b)=>a+b,0)/values.length):null,
    sampleP50Ms:quantile(.5),sampleP95Ms:quantile(.95),maximumMs:values.length?rounded(values.at(-1)):null,
    meaning:'Approximately 1 Hz observations, at most 31 per case; nearest-rank sample quantiles are descriptive only, not a latency-tail or physical scan-out guarantee. See result.sourceAge for clock and measurement boundaries.'};
}
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
  const nativeCounterRate=key=>typeof a.sender.nativeCaptureCounters?.[key]==='number'&&typeof b.sender.nativeCaptureCounters?.[key]==='number'
    ?number((b.sender.nativeCaptureCounters[key]-a.sender.nativeCaptureCounters[key])/seconds):null;
  const nativeWritten=nativeCounterRate('framesWritten');
  const nativeWriteMs=nativeCounterRate('totalWriteMs');
  const firstCanvas=a.sender.nativeCaptureCounters?.canvas,lastCanvas=b.sender.nativeCaptureCounters?.canvas;
  const canvasDelta=key=>Number.isFinite(firstCanvas?.[key])&&Number.isFinite(lastCanvas?.[key])&&lastCanvas[key]>=firstCanvas[key]
    ?lastCanvas[key]-firstCanvas[key]:null;
  const canvasMean=(time,count)=>canvasDelta(count)>0&&canvasDelta(time)!==null?number(canvasDelta(time)/canvasDelta(count)):null;
  const firstGenerated=a.sender.sources.find(source=>source.isLiveSenderSource&&source.kind==='generated-cpu-nv12');
  const lastGenerated=b.sender.sources.find(source=>source.isLiveSenderSource&&source.kind==='generated-cpu-nv12');
  const generatedDelta=(key,detail=false)=>{
    const first=detail?firstGenerated?.generatedNv12:firstGenerated,last=detail?lastGenerated?.generatedNv12:lastGenerated;
    return Number.isFinite(first?.[key])&&Number.isFinite(last?.[key])&&last[key]>=first[key]?last[key]-first[key]:null;
  };
  const generatedDrawn=generatedDelta('uniqueFramesDrawn'),generatedWritten=generatedDelta('uniqueFramesWritten'),generatedWriteMs=generatedDelta('totalWriteMs');
  const sameBrokerSession=Number.isSafeInteger(a.nativeGpu?.started)&&a.nativeGpu.started===b.nativeGpu?.started&&
    a.nativeGpu?.cpuOwnership===b.nativeGpu?.cpuOwnership;
  const brokerDelta=key=>sameBrokerSession&&Number.isSafeInteger(a.nativeGpu?.[key])&&a.nativeGpu[key]>=0&&
    Number.isSafeInteger(b.nativeGpu?.[key])&&b.nativeGpu[key]>=a.nativeGpu[key]?b.nativeGpu[key]-a.nativeGpu[key]:null;
  const copiedFrames=a.nativeGpu?.frameStorage==='cpu'&&b.nativeGpu?.frameStorage==='cpu'?brokerDelta('sourceCopied'):null;
  const refreshCopied=brokerDelta('refreshFrames');
  // The broker's refresh counter is at its accepted/sent boundary. Subtract it
  // only when both endpoint copy/accepted totals coincide; otherwise it cannot
  // establish how many copied frames were refreshes.
  const copiedUpdates=copiedFrames!==null&&refreshCopied!==null&&copiedFrames>=refreshCopied&&
    a.nativeGpu.sourceCopied===a.nativeGpu.frames&&b.nativeGpu.sourceCopied===b.nativeGpu.frames?copiedFrames-refreshCopied:null;
  const copyOwnership=a.nativeGpu?.cpuOwnership==='copy-complete'||b.nativeGpu?.cpuOwnership==='copy-complete';
  const helperTiming=nativeGpuEnabled?nativeHelperTimingSummary(samples.map(sample=>sample.nativeHelperTiming)):null;
  return {
    seconds,cpu: captureCpuSummary(samples,nativeGpuEnabled),nativeSourceRafFps:number((b.nativeSourceFrames-a.nativeSourceFrames)/seconds),
    sourceAge:sourceAgeSummary(samples),
    nativeHelper:helperTiming?{...helperTiming,nominalReportIntervalUs:1000000,
      meaning:'Unique helper capture rate is delta newFrames divided by delta helper elapsedUs, not the JS sample interval. Approximately 1 Hz reports: each endpoint nominally lags its JS sample by up to one report interval; scheduling/pipe delays can add more. These helper-clock endpoints are not synchronized with source/writer/encode/decode FPS intervals.'}:null,
    actualSenderEncodings:b.sender.connections.flatMap(connection=>connection.senders).find(sender=>sender.isLiveCaptureSource)?.encodings??null,
    generatedProvider:generatedNv12Enabled?{sourceKind:'generated-cpu-nv12',nativeCaptureClaim:false,
      contentRect:lastGenerated?.generatedNv12?.contentRect??null,bytesPerFrame:lastGenerated?.generatedNv12?.bytesPerFrame??null,
      drawnFps:generatedDrawn!==null?number(generatedDrawn/seconds):null,writtenFps:generatedWritten!==null?number(generatedWritten/seconds):null,
      meanWriteWallMs:generatedWritten>0&&generatedWriteMs!==null?number(generatedWriteMs/generatedWritten):null,
      skippedDeadlines:generatedDelta('skippedDeadlines'),inputBytes:generatedDelta('totalInputBytes',true),
      transferDetachedFrames:generatedDelta('transferDetachedFrames',true),transferRetainedFrames:generatedDelta('transferRetainedFrames',true)}:null,
    nativeProvider: nativeGpuEnabled ? {
      helperNewUpdateFps:copyOwnership?null:number(((b.nativeGpu.frames-b.nativeGpu.refreshFrames)-(a.nativeGpu.frames-a.nativeGpu.refreshFrames))/seconds),
      helperNewUpdateFpsDeprecated:true,
      helperNewUpdateFpsMeaning:'Deprecated broker accepted/sent counter rate over the JS sample interval; not independent helper capture. Null for copy-complete ownership. Use nativeHelper.uniqueCaptureFps for helper capture.',
      mainCopiedFrameFps:copiedFrames!==null&&seconds>0?number(copiedFrames/seconds):null,
      mainCopiedUpdateFps:copiedUpdates!==null&&seconds>0?number(copiedUpdates/seconds):null,
      mainCopiedMeaning:'Main sourceCopied counter over the JS sample interval. Frame rate includes refreshes; update rate subtracts refreshFrames only when endpoint sourceCopied and accepted totals coincide, otherwise null. This is not helper capture FPS.',
      receivedFps: nativeCounterRate('framesReceived'), refreshReceivedFps: nativeCounterRate('refreshFrames'),
      writtenFps: nativeWritten, droppedWhileBusyFps: nativeCounterRate('framesDroppedWhileBusy'),
      meanWriteWallMs: nativeWritten>0 ? number(nativeWriteMs/nativeWritten) : null,
      canvasStages:firstCanvas&&lastCanvas?{
        capturesPerSecond:canvasDelta('capturesCompleted')!==null?number(canvasDelta('capturesCompleted')/seconds):null,
        copiesPerSecond:canvasDelta('copiesCompleted')!==null?number(canvasDelta('copiesCompleted')/seconds):null,
        meanDrawMs:canvasMean('totalDrawMs','draws'),meanCaptureMs:canvasMean('totalCaptureMs','capturesCompleted'),
        meanCopyMs:canvasMean('totalCopyMs','copiesCompleted'),
        lifetimeMaxDrawMs:lastCanvas.maxDrawMs??null,lifetimeMaxCaptureMs:lastCanvas.maxCaptureMs??null,lifetimeMaxCopyMs:lastCanvas.maxCopyMs??null,
        meaning:'Browser-local wall times: synchronous draw; admitted draw to actual new Processor output; prepare including CPU frame construction. Aggregate interval means and lifetime maxima, not GPU execution time. Prime excluded from capture/copy counts.'}:null,
      ...nativeProviderDiagnosticsDelta(a.sender.nativeCaptureCounters,b.sender.nativeCaptureCounters),
    } : null,
    sourceFps:number(sourceFps),encodeFps:number(encodeFps),
    sendFps:number(linkedCounterRate(a.sender,b.sender,'outbound','framesSent')),
    receiveFps:number(linkedCounterRate(a.viewer,b.viewer,'inbound','framesReceived')),decodeFps:number(decodeFps),
    encodeTimeMs:averageMs(a.sender,b.sender,'outbound','totalEncodeTime',encodeFps),
    decodeTimeMs:averageMs(a.viewer,b.viewer,'inbound','totalDecodeTime',decodeFps),
    activityAnalysisDelta:Object.fromEntries(['drawCalls','readCalls','drawMs','readMs','errors'].map(key=>[key,number((b.sender.activityAnalysis?.[key]??0)-(a.sender.activityAnalysis?.[key]??0))])),
    observerCost:{method:`VideoFrame.copyTo(RGBA:${patternReadbackMode})`,drawCalls:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerDrawCalls??0),0),drawMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerDrawMs??0),0)),readMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerReadMs??0),0)),copyMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerCopyMs??0),0)),copyCalls:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerCopyCalls??0),0),maxCopyMs:number(Math.max(...samples.map(s=>s.viewer.ownedPattern?.observerCopyMaxMs??0))),copiedBytes:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerCopiedBytes??0),0),readbackPixels:samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.observerReadbackPixels??0),0),snapshotMs:number(samples.reduce((sum,s)=>sum+(s.viewer.ownedPattern?.frameSnapshotMs??0),0)),snapshotsCreated:samples.filter(s=>s.viewer.ownedPattern?.frameSnapshotCreated).length,snapshotsClosed:samples.filter(s=>s.viewer.ownedPattern?.frameSnapshotClosed).length},
    nativeTimingMeaning:'Capture/conversion/delivery segment timing requires native-capture.log; pure converter CPU time and encoder queue delay remain unavailable.',
    presentationCallbacksFps:presentationRate('callbacks'),presentedFramesFps:presentationRate('latestPresentedFrames'),
    playbackFramesFps:presentationRate('totalVideoFrames'),playbackDroppedFps:presentationRate('droppedVideoFrames'),
    senderLast:b.sender,viewerLast:b.viewer,
  };
}
function qualifyGeneratedNv12(config,samples){
  const width=Math.min(config.captureWidth||1920,1920),height=Math.min(config.captureHeight||1080,1080);
  const sources=samples.map(sample=>sample.sender.sources.find(source=>source.isLiveSenderSource&&source.kind==='generated-cpu-nv12'));
  const owned=qualifyOwnedNativeBaseline({...config,source:'native'},samples.map((sample,index)=>({...sample,
    nativeSourceFrames:sources[index]?.uniqueFramesDrawn})));
  const exactDimensions=samples.every((sample,index)=>{
    const source=sources[index],outgoing=linkedVideoReport(sample.sender,'outbound'),incoming=linkedVideoReport(sample.viewer,'inbound');
    return source?.width===width&&source.height===height&&source.settings?.width===width&&source.settings.height===height&&
      outgoing?.frameWidth===width&&outgoing.frameHeight===height&&incoming?.frameWidth===width&&incoming.frameHeight===height;
  });
  const realNv12Writes=sources.every(source=>source&&source.uniqueFramesWritten>0&&source.error===null&&
    source.generatedNv12?.framesConstructed>0&&source.generatedNv12.bytesPerFrame===width*height*3/2);
  return {...owned,sourceKind:'generated-cpu-nv12',nativeCaptureClaim:false,exactDimensions,realNv12Writes,
    passed:owned.passed&&exactDimensions&&realNv12Writes,
    meaning:'Same owned marker/advancing-sequence/nonfuture-count guard applied to generated CPU NV12 writes; all capture/encode/decode dimensions must equal the controlled full coded size. This is not native capture acceptance.'};
}
app.whenReady().then(async()=>{
  try{
    installPowerDiagnostics();
    console.log('[capture-features]',captureFeatures||'baseline defaults');
    result.environment={versions:process.versions,logTimezoneOffsetMinutes:new Date().getTimezoneOffset(),os:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,memoryGB:Math.round(os.totalmem()/1024**3)},displays:screen.getAllDisplays().map(d=>({size:d.size,bounds:d.bounds,scaleFactor:d.scaleFactor,displayFrequency:d.displayFrequency})),gpu:await app.getGPUInfo('basic'),gpuFeatureStatus:app.getGPUFeatureStatus(),
      gpuInitialCollectionStage:'app.whenReady before any window is created; the runtime GPU backend may not yet be initialized.'};
    backend=spawn(process.env.COVE_TEST_NODE,[path.join(__dirname,'screen-performance-backend.cjs')],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
    fs.writeFileSync(path.join(directory,'owned-processes.json'),JSON.stringify({electron:process.pid,backend:backend.pid},null,2));
    const info=await new Promise((resolve,reject)=>{backend.once('error',reject);backend.once('exit',code=>reject(Error('Backend exited '+code)));backend.on('message',m=>{if(m?.type==='ready')resolve(m);});});
    session.defaultSession.setPermissionRequestHandler((_wc,permission,done)=>done(['media','display-capture'].includes(permission)));session.defaultSession.setPermissionCheckHandler((_wc,permission)=>['media','display-capture'].includes(permission));
    const scale=screen.getPrimaryDisplay().scaleFactor;
    sourceWindow=new BrowserWindow({width:Math.round(1920/scale),height:Math.round(1080/scale),useContentSize:true,frame:false,show:false,title:'Cove isolated moving source',webPreferences:{backgroundThrottling:false}});
    const sourceAgeSetup=sourceAgeEnabled?`const sourceAgeRing=(${createSourceAgeRing.toString()})();window.coveSourceAge=sourceAgeRing;`:'';
    const sourceAgeDraw=sourceAgeEnabled?'sourceAgeRing.record(frames,Number.isFinite(performance.timeOrigin)&&performance.timeOrigin>0&&Number.isFinite(t)&&t>=0?performance.timeOrigin+t:NaN);':'';
    const source=generatedNv12Enabled?'<!doctype html><script>window.sourceFrames=0</script>':`<!doctype html><style>body{margin:0;overflow:hidden;background:#17324d}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script>const c=document.querySelector('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d');let frames=0;${sourceAgeSetup}function draw(t){${nativeLifecycleEnabled?'if(window.sourceFrozen===true){return;}':''}frames++;${sourceAgeDraw}x.fillStyle=frames%2?'#17324d':'#18334e';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fcba35';x.fillRect((t*.35)%1800,600,120,400);x.fillStyle='white';x.font='72px sans-serif';x.fillText(String(frames),240,100);for(const [color,a,b] of [['#e84a5f',0,0],['#41b3a3',1728,0],['#e8d0a9',0,972],['#4b2e83',1728,972]]){x.fillStyle=color;x.fillRect(a,b,192,108)}for(let bit=0;bit<16;bit++){x.fillStyle=frames&(1<<bit)?'#fff':'#000';x.fillRect(384+bit*72,432,72,108)}window.sourceFrames=frames;requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>`;
    await sourceWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(source));
    session.defaultSession.setDisplayMediaRequestHandler((request,callback)=>{
      try{nativeRequests++;console.log('[capture] owned native request',nativeRequests,captureTarget);
        if(!selectedCaptureSource)throw Error('No prevalidated owned source for display capture');
        if(nativeController){
          if(request.frame!==peers[0]?.webContents.mainFrame)throw Error('Display capture did not originate in the owned publisher main frame');
          const displays=screen.getAllDisplays(),primary=screen.getPrimaryDisplay();
          const display=displays.find(value=>String(value.id)===selectedCaptureSource.display_id)??(displays.length===1?displays[0]:null);
          nativeController.noteStockSelection({sourceId:selectedCaptureSource.id,displayId:display?String(display.id):'',
            primaryDisplayId:String(primary.id),displayCount:displays.length,selectedAt:Date.now(),
            sourceWidth:display?Math.round(display.size.width*display.scaleFactor):undefined,
            sourceHeight:display?Math.round(display.size.height*display.scaleFactor):undefined});
        }
        callback({video:selectedCaptureSource});
      }catch(error){console.error(error);void finish(error);}
    });
    const cases=JSON.parse(process.env.COVE_FPS_CASES||JSON.stringify([{source:'generated',preset:'1080p',fps:120,game:true,compatibility:true},{source:'generated',preset:'540p',fps:120,game:true,compatibility:true},{source:'native',preset:'1080p',fps:120,game:true,compatibility:true},{source:'native',preset:'540p',fps:120,game:true,compatibility:true}]));
    validatePerformanceCases(cases);
    if(sourceAgeEnabled&&cases.some(config=>config.source!=='native'))throw Error('Source age requires only native cases capturing the owned source HTML; generated counters belong to another renderer');
    performanceDisplaySleepPrevention(process.env,cases,minimizeSender);
    if(generatedNv12Enabled&&cases.some(config=>config.source!=='generated'||config.preset!=='1080p'||config.fps!==120))
      throw Error('Generated NV12 requires generated 1080p120 cases');
    nativePerformanceTracePhase(process.env,nativeGpuEnabled,cases);
    if(minimizeSender&&(cases.length!==1||cases[0].source!=='native'||captureTraceEnabled||nativeLifecycleEnabled||process.env.COVE_FPS_REPUBLISH_CHECKS==='1'||process.env.COVE_FPS_RECOVERY_CHECKS==='1'))throw Error('Minimized-sender checks require one native case without trace, republish or recovery injection');
    if(nativeLifecycleEnabled){
      const primary=screen.getPrimaryDisplay();
      if(cases.length!==1||!nativeUpgradeRequired(cases[0],nativeGpuEnabled)||cases[0].preset!=='540p'||cases[0].fps!==120||
        captureTraceEnabled||process.env.COVE_FPS_RECOVERY_CHECKS==='1'||screen.getAllDisplays().length!==1||
        Math.abs(Math.round(primary.size.width*primary.scaleFactor)-2560)>2||Math.abs(Math.round(primary.size.height*primary.scaleFactor)-1600)>2)
        throw Error('Native lifecycle checks require one non-profiling native monitor 540p120 case on the owned single 2560x1600 display');
    }
    const sampleSeconds=Number(process.env.COVE_FPS_SAMPLE_SECONDS||8),warmupMs=Number(process.env.COVE_FPS_WARMUP_MS||5000);
    if(!Number.isInteger(sampleSeconds)||sampleSeconds<1||sampleSeconds>30||!Number.isInteger(warmupMs)||warmupMs<0||warmupMs>30000)throw Error('Invalid bounded sample duration');
    if(captureTraceEnabled&&(cases.length!==1||cases[0].source!=='native'||sampleSeconds>8||warmupMs>5000||process.env.COVE_FPS_RECOVERY_CHECKS==='1'))throw Error('Capture profiling requires one native case, at most 5s warmup/8s sample and no recovery injection');
    for(let index=0;index<2;index++){const offscreen=peerRenderMode==='offscreen'||(minimizeSender&&index===1&&minimizedViewerMode==='offscreen');
      const win=new BrowserWindow({width:1000,height:760,show:minimizeSender&&index===0,webPreferences:{offscreen,backgroundThrottling:minimizeSender&&index===0&&minimizedThrottling,
      ...(nativeGpuEnabled?{preload:path.join(root,nativePaths.preload),additionalArguments:index===0?['--cove-native-gpu-capture=1',...(preloadFrameTiming?['--cove-native-cpu-frame-timing=1']:[]),...(nativeFrameSink==='canvas'?['--cove-native-frame-sink=canvas']:[])]:[],contextIsolation:true,sandbox:true,nodeIntegration:false}:{})}});if(offscreen)win.webContents.setFrameRate(144);win.webContents.setAudioMuted(true);peers.push(win);observePeerLifecycle(win,index);win.webContents.on('console-message',(_e,level,msg)=>{if(msg.includes('Error')||msg.includes('error'))console.log('[peer]',msg);});}
    if(nativeController){
      const ownsEvent=event=>!peers[0].isDestroyed()&&event.sender===peers[0].webContents&&event.senderFrame===peers[0].webContents.mainFrame;
      // Product preload also exposes native audio cleanup. This video-only
      // fixture owns no native audio children; acknowledge stop for its two
      // trusted peers without starting any audio capture implementation.
      result.nativeGpu.isolatedNoopAudioStops={};
      for(const channel of ['cove:screen-audio:stop','cove:application-audio:stop','cove:system-audio:stop']){
        result.nativeGpu.isolatedNoopAudioStops[channel]=0;
        ipcMain.handle(channel,event=>{
          if(!peers.some(win=>!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame))return false;
          result.nativeGpu.isolatedNoopAudioStops[channel]++;return true;
        });
      }
      ipcMain.handle('cove:native-screen:start',async(event,requestId,options)=>{
        if(!ownsEvent(event))return {ok:false,reason:'untrusted_frame'};
        if(minimizeSender&&!minimizedThrottling)peers[0].webContents.setBackgroundThrottling(false);
        const started=Date.now(),monotonicStarted=process.hrtime.bigint();let response;
        try{const pending=nativeController.start(peers[0].webContents,requestId,options);attachNativeHelperTiming();response=await pending;attachNativeHelperTiming();}
        catch{response={ok:false,reason:'ipc_start_failed'};}
        result.nativeGpu.startAttempts.push({at:started,durationMs:Number(process.hrtime.bigint()-monotonicStarted)/1e6,ok:response.ok===true,
          ...(response.ok?{width:response.width,height:response.height}:{reason:/^[a-z_]{1,50}$/.test(response.reason)?response.reason:'start_failed'})});save();return response;
      });
      ipcMain.handle('cove:native-screen:stop',(event,requestId,fault)=>{
        if(!ownsEvent(event))return false;
        if(result.nativeGpu.stopRequests.length<128)result.nativeGpu.stopRequests.push(nativeStopRequestEvidence(fault,brokerSnapshot()));
        else result.nativeGpu.stopRequestsDropped++;
        try{return nativeController.stop(peers[0].webContents,requestId,fault);}finally{save();}
      });
      ipcMain.on('cove:native-screen:cpu-frame-done',(event,metadata)=>ownsEvent(event)&&nativeController.acknowledgeCpuFrame(peers[0].webContents,metadata));
    }
    for(const config of cases){
      captureTarget=config.captureTarget==='screen'?'screen':'window';
      if(config.source==='native'){
        sourceWindow.setFullScreen(captureTarget==='screen'||Boolean(config.ownedWindowFullscreen));
        // Native runs are explicitly scheduled foreground tests. Showing
        // inactive can leave another app covering the supposed monitor source.
        sourceWindow.show();sourceWindow.focus();await delay(300);
        sourceWindow.setAlwaysOnTop(true,'floating');sourceWindow.moveTop();
      }else{sourceWindow.setAlwaysOnTop(false);sourceWindow.hide();}
      startOwnedDisplaySleepBlocker();
      let sourceSelection=null;selectedCaptureSource=null;
      if(config.source==='native'){
        const selected=selectOwnedCaptureSource({captureTarget,
          sources:await desktopCapturer.getSources({types:[captureTarget],thumbnailSize:{width:0,height:0}}),
          displays:screen.getAllDisplays(),primaryDisplayId:screen.getPrimaryDisplay().id,ownedWindowId:sourceWindow.getMediaSourceId(),nativeWindowPath:Boolean(config.nativeWindowPath)});
        selectedCaptureSource=selected.source;sourceSelection=selected.metadata;
        result.sourceSelections??=[];result.sourceSelections.push(sourceSelection);save();
      }
      for(let index=0;index<2;index++){
        const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index),performance:'1',source:config.source,width:'1920',height:'1080',fps:String(config.fps),...(nativeGpuEnabled&&index===0?{nativeGpu:'1',...(stockCaptureKeepalive?{stockCaptureKeepalive:'1'}:{})}:{}),...(generatedNv12Enabled?{generatedNv12:'1'}:{}),...((config.source==='native'||generatedNv12Enabled)&&index===1?{ownedPattern:'1',ownedPatternReadback:patternReadbackMode,...(sourceAgeEnabled?{sourceAge:'1'}:{})}:{}),...(config.captureWidth?{captureWidth:String(config.captureWidth),captureHeight:String(config.captureHeight)}:{})});
        await peers[index].loadURL(process.env.COVE_QA_RENDERER_URL+'/tests/ui/media-integration.html?'+query);await wait(peers[index],'Boolean(window.coveMediaQA?.ready)');await js(peers[index],"window.coveMediaQA.rtc.selectMicrophoneNoiseMode('system');window.coveMediaQA.rtc.joinVoice()");await wait(peers[index],'Boolean(window.coveMediaQA.rtc.inVoice)');
      }
      const [sender,viewer]=peers;
      if(config.source==='native'||generatedNv12Enabled){
        const readerCheck=await boundedJs(viewer,'window.coveScreenPerformance.verifyPatternReader()');
        result.patternReaderChecks??=[];result.patternReaderChecks.push(readerCheck);save();
        if(!readerCheck.passed)throw Error('Owned-pattern VideoFrame/ROI self-test failed before native capture');
      }
      const nativeRequestsBefore=nativeRequests;
      if(config.source==='native')sourceWindow.moveTop();
      if(captureTracePhase==='startup')await startOwnedTrace();
      await startOwnedScreenShare(sender,config,'initial-publication-returned');await wait(sender,'Boolean(window.coveMediaQA.rtc.localScreen)');await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');
      await wait(sender,`window.coveMediaQA.rtc.screenNativeResolution===${Boolean(config.nativeResolution)}`);
      if(config.source==='native'&&nativeRequests<=nativeRequestsBefore)throw Error('Native source was replaced before the Electron capture handler');
      await js(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');await wait(viewer,'document.querySelector("video").readyState>=2');
      const samples=[],requiresNativeUpgrade=nativeUpgradeRequired(config,nativeGpuEnabled);
      const measured={config,sourceSelection,sourceWindowBeforeSampling:sourceWindowState(),samples,summary:null,nativeSourceFrames:0,nativeRequests,
        nativeUpgradeRequired:requiresNativeUpgrade,nativeUpgradeSucceeded:false,
        nativeGpu:nativeGpuEnabled?{eligible:requiresNativeUpgrade,brokerBeforeSampling:brokerSnapshot()}:null,
        comparisonContract:{passed:false},nativeBaseline:{required:config.source==='native',passed:false},
        generatedNv12Baseline:{required:generatedNv12Enabled,passed:!generatedNv12Enabled}};
      result.cases.push(measured);save();
      if(requiresNativeUpgrade)await waitNativeUpgrade(sender,viewer,measured,'initial-publication');
      await captureGpuAfterPublication();
      if(minimizeSender){
        // Only the publisher minimizes. Keep the receiver at the same ordinary
        // hidden mode as non-minimized measurements by default. Bitmap OSR is
        // an explicit stress control because it adds compositor/readback work.
        sender.minimize();
        for(let attempt=0;attempt<60&&!sender.isMinimized();attempt++)await delay(50);
        if(!sender.isMinimized())throw Error('Ordinary sender did not minimize within 3 seconds');
        const visibilityDeadline=Date.now()+3000;
        do{
          measured.minimizedSender={offscreen:sender.webContents.isOffscreen(),
            backgroundThrottling:sender.webContents.getBackgroundThrottling(),minimized:sender.isMinimized(),
            visibilityState:await boundedJs(sender,'document.visibilityState',1000)};
          if(minimizedVisibilityMatches(measured.minimizedSender.visibilityState))break;
          await delay(50);
        }while(Date.now()<visibilityDeadline);
        const state=measured.minimizedSender;
        measured.observerWindow={offscreen:viewer.webContents.isOffscreen(),backgroundThrottling:viewer.webContents.getBackgroundThrottling()};
        if(state.offscreen||state.backgroundThrottling!==minimizedThrottling||!state.minimized||!minimizedVisibilityMatches(state.visibilityState)||measured.observerWindow.offscreen!==(minimizedViewerMode==='offscreen')||measured.observerWindow.backgroundThrottling)throw Error('Minimized sender / independent rendering observer policy was not established');
        sourceWindow.focus();sourceWindow.moveTop();save();
      }
      await delay(warmupMs);
      if(config.source==='native')sourceWindow.moveTop();
      measured.sourceWindowBeforeSampling=sourceWindowState();
      if(captureTraceEnabled&&captureTracePhase==='native-steady'){
        const actualSender=await boundedJs(sender,'window.coveScreenPerformance.sample()'),nativeAtTraceStart=brokerSnapshot();
        const evidence=nativeEvidence(actualSender,nativeAtTraceStart);
        if(!requiresNativeUpgrade||!evidence.passed)throw Error('Native-steady profiling lost its real native upgrade before recording');
        await startOwnedTrace({required:true,upgradeObserved:true,evidence,broker:nativeAtTraceStart,
          configuredWarmupMs:warmupMs,ownedPixelsDuringSampling:null});
      }
      for(let n=0;n<=sampleSeconds;n++){
        const fullObservation=!lowObserverMode||n===0||n===sampleSeconds;
        const mainStages={jsWaitMs:null,brokerSnapshotMs:null,sourceFramesMs:null,sourceStateMs:null,metricsMs:null,
          save:{performed:false,serializeMs:null,writeMs:null,totalMs:null}};
        const sampleCode=minimizeSender?'(async()=>{const sample=await window.coveScreenPerformance.sample();return {...sample,documentVisibilityState:document.visibilityState}})()':'window.coveScreenPerformance.sample()';
        let stageStarted=performance.now();
        const [send,receive]=await Promise.all(peers.map(win=>boundedJs(win,sampleCode)));
        mainStages.jsWaitMs=performance.now()-stageStarted;stageStarted=performance.now();
        if(preloadFrameTiming&&(n===0||n===sampleSeconds)){
          send.preloadCpuFrameTiming=await boundedJs(sender,'window.coveNativeScreen?.getCpuFrameTiming?.()??null');
          if(!send.preloadCpuFrameTiming?.stages)throw Error('CPU preload timing was requested but unavailable');
        }
        const nativeGpu=brokerSnapshot();
        const nativeHelperTiming=currentNativeHelperTiming(nativeGpu);
        mainStages.brokerSnapshotMs=performance.now()-stageStarted;
        if(minimizeSender&&(!sender.isMinimized()||sender.webContents.getBackgroundThrottling()!==minimizedThrottling||!minimizedVisibilityMatches(send.documentVisibilityState)))throw Error('Minimized background state changed during measurement');
        const at=Date.now();stageStarted=performance.now();
        // Source counters remain per-sample: the owned-pixel nonfuture/lag guard needs them.
        const sequence=receive.ownedPattern?.capturedSequence,snapshotAt=receive.ownedPattern?.snapshotAt;
        const sourceSample=sourceAgeEnabled?await js(sourceWindow,`({frames:window.sourceFrames,age:window.coveSourceAge?.resolve(${JSON.stringify(Number.isInteger(sequence)&&sequence>=0&&sequence<65536?sequence:null)},${JSON.stringify(Number.isFinite(snapshotAt)&&snapshotAt>0&&snapshotAt<=Number.MAX_SAFE_INTEGER?snapshotAt:null)})??null})`):null;
        const nativeSourceFrames=sourceAgeEnabled?sourceSample?.frames:await js(sourceWindow,'window.sourceFrames');mainStages.sourceFramesMs=performance.now()-stageStarted;
        let sourceAge=sourceAgeEnabled?safeSourceAgeObservation(sourceSample?.age):null;
        if(sourceAge?.status==='matched'&&(sourceAge.counter%65536!==sequence||sourceAge.snapshotAt!==snapshotAt))sourceAge=safeSourceAgeObservation(null);
        let sourceState=null,cpu=null;
        if(fullObservation){
          stageStarted=performance.now();sourceState=sourceWindowState();mainStages.sourceStateMs=performance.now()-stageStarted;
          stageStarted=performance.now();cpu=app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,cpu:m.cpu,memory:m.memory}));mainStages.metricsMs=performance.now()-stageStarted;
        }
        samples.push({at,sender:send,viewer:receive,nativeGpu,nativeHelperTiming,nativeSourceFrames,sourceWindowState:sourceState,cpu,
          fullMainObservation:fullObservation,mainStages,...(sourceAgeEnabled?{sourceAge}:{})});
        if(requiresNativeUpgrade&&!nativeEvidence(send,nativeGpu).passed){
          measured.nativeUpgradeSucceeded=false;measured.nativeGpu.failureCode=nativeGpu?.failureCode??'upgraded_track_lost';save();
          throw Error('Native GPU upgrade stopped during performance measurement');
        }
        if(samples.length>=2){measured.summary=summary(samples);measured.nativeBaseline=qualifyOwnedNativeBaseline(config,samples);
          if(generatedNv12Enabled)measured.generatedNv12Baseline=qualifyGeneratedNv12(config,samples);
          if(result.trace?.actualNativeBaseline)result.trace.actualNativeBaseline.ownedPixelsDuringSampling=measured.nativeBaseline;}
        if(!lowObserverMode)save(mainStages.save);
        if(samples.length>=2&&!measured.nativeBaseline.passed)throw Error('Owned native baseline failed: '+JSON.stringify(measured.nativeBaseline));
        if(samples.length>=2&&!measured.generatedNv12Baseline.passed)throw Error('Generated NV12 pixel/dimension qualification failed: '+JSON.stringify(measured.generatedNv12Baseline));
        if(n<sampleSeconds)await delay(1000);
      }
      if(captureTraceEnabled){
        if(result.trace.actualNativeBaseline){result.trace.actualNativeBaseline.ownedPixelsDuringSampling=measured.nativeBaseline;
          result.trace.actualNativeBaseline.upgradeAtLastSample=nativeEvidence(samples.at(-1).sender,samples.at(-1).nativeGpu);}
        await stopOwnedTrace('sample-complete');if(!result.trace.completed||!result.trace.sanitized||result.trace.rawFileRetained)throw Error('Capture profiling did not complete with a sanitized trace');}
      const nativeSourceFrames=await js(sourceWindow,'window.sourceFrames');
      measured.nativeSourceFrames=nativeSourceFrames;measured.nativeRequests=nativeRequests;save();
      // Optional dimensional/codec contract for comparisons: a preset label or
      // codec preference alone does not establish the actual measured path.
      try{for(const sample of samples){
        const captureSource=sample.sender.sources.find(source=>source.isLiveSenderSource===true);
        const capture=captureSource?.settings;
        const sourceReport=linkedVideoReport(sample.sender,'source');
        // Preserve getSettings verbatim. A correctly bound media-source report
        // may supply dimensions when Chromium omits generator track settings.
        const captureWidth=capture?.width??sourceReport?.width,captureHeight=capture?.height??sourceReport?.height;
        const outgoing=linkedVideoReport(sample.sender,'outbound');
        const incoming=linkedVideoReport(sample.viewer,'inbound');
        if(!linkedVideoReport(sample.sender,'source')||!outgoing||!incoming)throw Error('Live video pipeline statistics could not be bound unambiguously');
        const rendered=sample.viewer.presentation.find(p=>p.isCurrentVideo);
        sample.sender.captureDimensionEvidence={width:captureWidth??null,height:captureHeight??null,
          source:capture?.width!==undefined&&capture?.height!==undefined?'track-settings':'linked-media-source'};
        for(const [stage,width,height] of [['capture',captureWidth,captureHeight],['encoded',outgoing?.frameWidth,outgoing?.frameHeight],['decoded',incoming?.frameWidth,incoming?.frameHeight],['rendered',rendered?.width,rendered?.height]]){
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
        await startOwnedScreenShare(sender,config,'republication-returned');
        await wait(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');await boundedJs(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId);void 0');
        if(requiresNativeUpgrade)await waitNativeUpgrade(sender,viewer,measured,'republication');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken!==${before.trackToken}&&s.currentVideo?.trackState==='live')`);
        const fresh=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        await wait(viewer,`window.coveScreenPerformance.sample().then(s=>s.currentVideo?.trackToken===${fresh.trackToken}&&s.currentVideo.reportId===${JSON.stringify(fresh.reportId)}&&s.currentVideo.framesDecoded>${fresh.framesDecoded+20})`);
        const progressed=await js(viewer,'window.coveScreenPerformance.sample().then(s=>s.currentVideo)');
        measured.recovery.productStopEndedSourceTracks=stopped;measured.recovery.newConsumerTrack=fresh.trackToken!==before.trackToken;measured.recovery.freshDecodedFrames=progressed.framesDecoded-fresh.framesDecoded;measured.recovery.republicationDecodedFrames=true;save();
        if(!stopped||(measured.recovery.gpuProcessRestartRequested&&!measured.recovery.ownedGpuProcessRestarted))throw Error('Owned GPU/source recovery invariant failed');
      }
      if(nativeLifecycleEnabled)await runNativeLifecycle(sender,viewer,config,measured);
      measured.cleanup=await cleanupPeers();save();
      if(!measured.cleanup.passed)throw Error('Owned media cleanup invariants failed');
      await delay(350);
    }
    await finish();
  }catch(error){await finish(error);}
});
