'use strict';
// Existing double-Chromium/product-hook/SFU fixture, with an independent profile,
// Vite cache and loopback backend for each bounded performance measurement.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),dgram=require('node:dgram'),net=require('node:net');
const crypto=require('node:crypto');
const {cleanupOwnedTraceExports}=require('./analyze-screen-performance-trace.cjs');
const {nativePerformanceEnabled,nativePerformancePaths,performanceDisplaySleepPrevention}=require('./screen-performance-native.cjs');
const {performanceLocalPreviewEnabled,performanceProductSenderThrottling,publisherBackgroundThrottling,visiblePresentationOptions}=require('./screen-performance-local-preview.cjs');
const {performanceDemandOptions}=require('./screen-performance-demand.cjs');
const root=path.resolve(__dirname,'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  if(child.connected)child.send({type:'stop'},()=>{});
  for(let n=0;n<30&&child.exitCode===null&&child.signalCode===null;n++)await delay(100);
  if(child.exitCode!==null||child.signalCode!==null)return;
  // This exact ChildProcess/PID was created by this launcher, never selected
  // by process name. Include its owned SFU on a watchdog/signal fallback.
  if(process.platform==='win32')await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>{child.kill();resolve();});killer.once('close',resolve);});
  else child.kill('SIGKILL');
}
function logged(executable,args,env,file,{windowsHide=true}={}){const fd=fs.openSync(file,'w');const child=spawn(executable,args,{cwd:root,env,windowsHide,stdio:['ignore',fd,fd,'ipc']});child.once('close',()=>fs.closeSync(fd));return child;}
async function port(){
  let lastCode='unavailable';
  for(let attempt=0;attempt<32;attempt++){
    const udp=dgram.createSocket('udp4'),tcp=net.createServer();
    try{
      // Start with a TCP-assigned port: Windows can repeatedly allocate a UDP
      // ephemeral port inside a TCP-excluded range. Probe the other protocol
      // while holding the first, without changing exclusions or socket policy.
      // TCP/UDP reservations differ. Windows can hand out a sequential TCP
      // block reserved for UDP for all 32 attempts; after eight OS choices,
      // spread candidates across the user-port range and still probe both.
      const candidate=attempt<8?0:crypto.randomInt(49152,65336);
      await new Promise((resolve,reject)=>{tcp.once('error',reject);tcp.listen({port:candidate,host:'127.0.0.1',exclusive:true},resolve);});
      const value=tcp.address().port;
      // The real SFU worker reserves the configured base + 1 through base +
      // 200 (apps/server/src/features/media/ms.ts). A valid ephemeral base
      // above 65335 would make createWorker reject its settings before capture.
      if(!Number.isInteger(value)||value<1||value>65535-200){lastCode='invalid_worker_port_range';continue;}
      await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind({port:value,address:'127.0.0.1',exclusive:true},resolve);});
      return value;
    }catch(error){lastCode=/^[A-Z0-9_]{1,40}$/.test(error?.code??'')?error.code:'bind_failed';}
    finally{
      await Promise.all([new Promise(resolve=>{try{udp.close(()=>resolve());}catch{resolve();}}),
        new Promise(resolve=>{try{tcp.close(()=>resolve());}catch{resolve();}})]);
    }
  }
  throw Error('No loopback port available for both TCP and UDP after 32 probes ('+lastCode+')');
}
async function main(){
  performanceDemandOptions();
  // Reject an incompatible minimize/sleep-control combination in Node, before
  // creating an Electron process (whose bootstrap exception can leave a modal).
  performanceDisplaySleepPrevention(process.env,null,process.env.COVE_FPS_MINIMIZE_SENDER==='1');
  const localPreviewEnabled=performanceLocalPreviewEnabled();
  const visiblePresentation=visiblePresentationOptions();
  const productSenderThrottling=performanceProductSenderThrottling();
  publisherBackgroundThrottling({minimizeSender:process.env.COVE_FPS_MINIMIZE_SENDER==='1',
    minimizedThrottling:process.env.COVE_FPS_MINIMIZED_THROTTLING!=='0',productSenderThrottling});
  const runtimeName=process.env.COVE_FPS_RUNTIME_NAME||'fps-candidate';
  if(!/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/.test(runtimeName))throw Error('Invalid performance runtime namespace');
  const baselineWriterFlag=process.env.COVE_FPS_BASELINE_FRAME_WRITER;
  if(baselineWriterFlag!==undefined&&!['0','1'].includes(baselineWriterFlag))throw Error('Invalid baseline frame writer option');
  const baselineFrameWriterOverride=baselineWriterFlag==='1',nativeGpuEnabled=nativePerformanceEnabled();
  if(baselineFrameWriterOverride&&!nativeGpuEnabled)throw Error('Baseline frame writer override requires native GPU performance measurement');
  const nativeFrameWriter='apps/desktop/src/features/media/screen/nativeScreenCapture.ts';
  const effectiveNativeFrameWriterPath=baselineFrameWriterOverride
    ?'runtime/native-throughput-20261028-baseline/nativeScreenCapture.ts':nativeFrameWriter;
  if(baselineFrameWriterOverride&&!fs.existsSync(path.join(root,effectiveNativeFrameWriterPath)))
    throw Error('The fixed 20261028 baseline frame writer snapshot is required; no source fallback is allowed');
  const effectiveNativeFrameWriterBytes=fs.readFileSync(path.join(root,effectiveNativeFrameWriterPath));
  const effectiveNativeFrameWriter={path:effectiveNativeFrameWriterPath,
    sha256:crypto.createHash('sha256').update(effectiveNativeFrameWriterBytes).digest('hex')};
  const runtime=path.join(root,'runtime',runtimeName);fs.mkdirSync(runtime,{recursive:true});
  const label=process.env.COVE_FPS_LABEL||'baseline';if(!/^[a-z0-9-]{1,60}$/.test(label))throw Error('Invalid performance label');
  const directory=fs.mkdtempSync(path.join(runtime,label+'-'));
  const nativePaths=nativeGpuEnabled?nativePerformancePaths(root):null;
  const nativeHelperSourcePath=nativePaths?path.posix.join(path.posix.dirname(nativePaths.helper),'source.cpp'):null;
  const effectiveNativeHelperSource=nativeHelperSourcePath&&fs.existsSync(path.join(root,nativeHelperSourcePath))
    ?{path:nativeHelperSourcePath,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,nativeHelperSourcePath))).digest('hex')}:null;
  const sources=['apps/desktop/src/features/media/screen/screenCapture.ts','apps/desktop/src/features/media/screen/useScreenPublishing.ts','apps/desktop/src/features/media/screen/useScreenAnalysis.ts','apps/desktop/tests/ui/media-integration.tsx','apps/desktop/tests/ui/screen-performance-fixture.ts','apps/desktop/tests/ui/screen-performance.electron.cjs','apps/desktop/tests/ui/screen-performance-backend.cjs','tooling/verify-screen-performance.cjs','tooling/screen-performance-config.cjs','tooling/screen-performance-local-preview.cjs','apps/desktop/tests/ui/screen-performance-pattern-layouts.json','apps/desktop/src/styles/index.css','apps/desktop/src/styles/ui-v2.css','apps/desktop/src/features/media/diagnostics/DiagnosticsOverlayV2.tsx','apps/desktop/src/features/media/screen/ScreenVideo.tsx','apps/desktop/src/features/media/screen/screenVideoPlayback.ts','tooling/screen-performance-native.cjs','tooling/screen-performance-source-age.cjs','tooling/analyze-screen-performance-trace.cjs',
    'apps/desktop/electron/native-screen-capture-protocol.ts','apps/desktop/electron/native-screen-capture-helper.cpp','apps/desktop/electron/native-screen-handles.cpp','apps/desktop/electron/build-native-screen-capture.cjs','apps/desktop/electron/native-screen-capture.ts','apps/desktop/electron/native-screen-cpu-delivery.ts','apps/desktop/electron/native-screen-cpu-buffer-pipeline.ts','apps/desktop/electron/preload.ts','apps/desktop/src/features/media/screen/nativeScreenCapture.ts','apps/desktop/src/features/media/screen/nativeFrameWriteQueue.ts','apps/desktop/src/features/media/screen/nativeScreenUpgrade.ts','apps/desktop/src/features/media/screen/nativeScreenColorPolicy.ts'];
  sources.push('tooling/screen-performance-demand.cjs','tests/screen-performance-demand.test.cjs');
  if(nativePaths)sources.push(...Object.values(nativePaths),'apps/desktop/dist-electron/native-screen-cpu-buffer-pipeline.js','apps/desktop/dist-electron/native-screen-cpu-delivery.js','apps/desktop/dist-electron/native-screen-capture-protocol.js');
  if(process.env.COVE_FPS_NATIVE_FRAME_SINK==='canvas')sources.push('apps/desktop/src/features/media/screen/nativeCanvasFrameSink.ts');
  if(process.env.COVE_FPS_NATIVE_FRAME_SINK==='gpu-snapshot')sources.push('apps/desktop/src/features/media/screen/nativeGpuSnapshotFrameSink.ts');
  if(process.env.COVE_FPS_NATIVE_FRAME_SINK==='worker')sources.push(...[
    'nativeFrameWorkerProtocol.ts','nativeFrameWorkerRuntime.ts','nativeFrameWorker.ts','nativeWorkerFrameSink.ts',
  ].map(file=>'apps/desktop/src/features/media/screen/'+file));
  if(effectiveNativeHelperSource)sources.push(effectiveNativeHelperSource.path);
  if(baselineFrameWriterOverride)sources.push(effectiveNativeFrameWriterPath);
  fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({startedAt:new Date().toISOString(),node:process.version,nativeGpuEnabled,
    nativeArtifacts:nativePaths,effectiveNativeHelperSource,baselineFrameWriterOverride,effectiveNativeFrameWriter,localPreviewEnabled,productSenderThrottling,visiblePresentation,electronProcessWindowsHide:!visiblePresentation.enabled,
    files:Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))},null,2)+'\n');
  const env={...process.env,COVE_FPS_RUN_DIR:directory,COVE_TEST_NODE:process.execPath,COVE_QA_MEDIA_PORT:String(await port())};delete env.ELECTRON_RUN_AS_NODE;
  const dependencies=path.dirname(fs.realpathSync(path.join(root,'node_modules/vite')));
  const entry=pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href;
  const bootstrap=path.join(directory,'vite-bootstrap.mjs');
  // Keep the original module ID, so the immutable baseline's relative imports
  // resolve beside the current adapter. The only alternate text is this fixed,
  // explicitly recorded snapshot; no environment-provided path is accepted.
  const baselineWriterPlugin=baselineFrameWriterOverride
    ?`,plugins:[{name:'cove-isolated-20261028-baseline-frame-writer',enforce:'pre',load(id){const original=normalizePath(${JSON.stringify(path.join(root,nativeFrameWriter))});if(normalizePath(id)===original)return {code:${JSON.stringify(effectiveNativeFrameWriterBytes.toString('utf8'))},map:null};if(normalizePath(id).split('?')[0]===original)throw Error('Baseline frame writer must use its unique original module ID');return null;}}]`:'';
  fs.writeFileSync(bootstrap,`import {createServer,normalizePath} from ${JSON.stringify(entry)};\nconst server=await createServer({root:${JSON.stringify(path.join(root,'apps/desktop'))},configFile:${JSON.stringify(path.join(root,'apps/desktop/vite.config.ts'))},cacheDir:${JSON.stringify(path.join(directory,'vite-cache'))}${baselineWriterPlugin},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:null,fs:{allow:${JSON.stringify([root,dependencies])}}}});\nawait server.listen();process.send?.({type:'ready',url:'http://127.0.0.1:'+server.httpServer.address().port});process.on('message',async m=>{if(m?.type==='stop'){await server.close();process.disconnect?.();}});`);
  let vite,electron;let error=null;let interrupted=false;
  const onSignal=()=>{interrupted=true;void stop(electron);void stop(vite);};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try{
    vite=logged(process.execPath,[bootstrap],env,path.join(directory,'vite.log'));
    const info=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Vite startup timeout')),30000);vite.once('error',cause=>{clearTimeout(timeout);reject(cause);});vite.once('exit',code=>{clearTimeout(timeout);reject(Error('Vite exited '+code));});vite.on('message',m=>{if(m?.type==='ready'){clearTimeout(timeout);resolve(m);}});});
    // A Windows hidden-process STARTUPINFO can suppress a BrowserWindow's
    // first show even while Electron reports focus. Only the explicit visible
    // presentation is interactive; Vite/backend and old hidden runs stay hidden.
    electron=logged(require(path.join(root,'apps/desktop/node_modules/electron')),[path.join(root,'apps/desktop/tests/ui/screen-performance.electron.cjs')],{...env,COVE_QA_RENDERER_URL:info.url},path.join(directory,'electron.log'),{windowsHide:!visiblePresentation.enabled});
    const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Performance measurement timeout')),360000);electron.once('error',reject);electron.once('exit',code=>{clearTimeout(timeout);resolve(code);});});
    if(code!==0)error='Electron exited '+code;
  }catch(cause){error=cause.stack||String(cause);}finally{await stop(electron);await stop(vite);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);}
  const resultPath=path.join(directory,'result.json');const result=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):null;
  if(result?.trace){
    try{result.trace.postExitExportCleanup=cleanupOwnedTraceExports(directory,result.trace.options?.included_process_ids??[]);
      result.trace.rawFileRetained=result.trace.postExitExportCleanup.rawFileRetained;
      result.trace.postExitExportAuditRequired=false;
      if(result.trace.rawFileRetained)error??='Owned trace exporter files remain after exit';
    }catch(cause){result.trace.postExitExportCleanupError=cause.message;result.trace.rawFileRetained=null;error??='Owned trace export audit failed';}
    fs.writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n');
  }
  console.log(JSON.stringify({directory:path.relative(root,directory),passed:!error&&!interrupted&&result?.passed===true,error:error||result?.error||null,interrupted,
    captureFeatures:result?.captureFeatures,disabledCaptureFeatures:result?.disabledCaptureFeatures,peerRenderMode:result?.peerRenderMode,
    nativeGpu:result?.nativeGpu,localPreviewControl:result?.localPreviewControl,productSenderThrottlingControl:result?.productSenderThrottlingControl,visiblePresentation:result?.visiblePresentation,
    profilingOnly:result?.profilingOnly,trace:result?.trace,
    cases:result?.cases?.map(c=>({config:c.config,summary:c.summary?Object.fromEntries(Object.entries(c.summary).filter(([key])=>!['senderLast','viewerLast'].includes(key))):null,nativeBaseline:c.nativeBaseline,comparisonContract:c.comparisonContract,
      nativeUpgradeRequired:c.nativeUpgradeRequired,nativeUpgradeSucceeded:c.nativeUpgradeSucceeded,nativeGpu:c.nativeGpu,nativeLifecycle:c.nativeLifecycle,demandComparison:c.demandComparison,localPreview:c.localPreview,visiblePresentation:c.visiblePresentation,senderWindowBeforeSampling:c.senderWindowBeforeSampling})),
    cleanup:{timeouts:result?.cleanupTimeouts,passed:result?.cleanup?.passed,rendererResourcesZero:result?.cleanup?.rendererResourcesZero,backendResourcesZero:result?.cleanup?.backendResourcesZero,nativeGpu:result?.cleanup?.nativeGpu,backendStopped:result?.backendStopped,finishedAt:result?.finishedAt}},null,2));
  process.exitCode=error||interrupted||!result?.passed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
