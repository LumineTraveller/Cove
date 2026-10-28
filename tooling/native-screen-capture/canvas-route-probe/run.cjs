'use strict';
// Import, --check and tests are CPU-only. A normal CLI run explicitly starts GPU.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const readline=require('node:readline'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const {startPacer,binary:pacerBinary}=require('../cpu-frame-socket-probe/pacer.cjs');
const root=path.resolve(__dirname,'../../..'),runtime=path.join(root,'runtime/canvas-route-probe');
const need=(yes,code)=>{if(!yes)throw new Error(code);};
const safe=error=>/^[a-z0-9_]{1,100}$/.test(error?.message)?error.message:'canvas_probe_internal_failure';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const inside=(parent,target)=>{const rel=path.relative(parent,target);return !!rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);};
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);})]);}finally{clearTimeout(timer);}}
function configuration(args,validateFiles=true) {
  const result={stage:'mechanism',visibility:'hidden',canvasPlacement:'attached',helper:path.join(root,'runtime/nv12-shader-probe/readback-helper.exe'),
    addon:path.join(root,'runtime/native-screen-capture/native-screen-handles.node'),preload:path.join(root,'apps/desktop/dist-electron/preload.js')};
  const seen=new Set();
  for(let n=0;n<args.length;n++) {
    const key=args[n];need(!seen.has(key)&&n+1<args.length,'invalid_canvas_arguments');seen.add(key);const value=args[++n];
    if(key==='--stage'){need(['mechanism','paced','bounded','product'].includes(value),'invalid_canvas_stage');result.stage=value;}
    else if(key==='--visibility'){need(['hidden','visible','visible-then-hidden','visible-then-minimized'].includes(value),'invalid_canvas_visibility');result.visibility=value;}
    else if(key==='--canvas-placement'){need(['attached','detached'].includes(value),'invalid_canvas_placement');result.canvasPlacement=value;}
    else if(key==='--bounded-sink'){need(['none','direct','cpu','timestamp'].includes(value),'invalid_canvas_bounded_sink');result.boundedSink=value;}
    else if(key==='--product-source-start'){need(['after-prime','eager'].includes(value),'invalid_canvas_product_source_start');result.productSourceStart=value;}
    else if(key==='--helper'||key==='--addon')result[key.slice(2)]=path.resolve(value);
    else throw new Error('invalid_canvas_arguments');
  }
  Object.assign(result,result.stage==='mechanism'?{width:64,height:64,frames:24}:{width:1728,height:1080,frames:120});
  if(result.stage==='bounded')result.boundedSink??='direct';else need(result.boundedSink===undefined,'canvas_bounded_sink_requires_bounded_stage');
  if(result.stage==='product'){
    if(!seen.has('--canvas-placement'))result.canvasPlacement='detached';
    need(result.canvasPlacement==='detached','canvas_product_uses_actual_detached_platform');
    result.productSourceStart??='after-prime';
    need(result.productSourceStart!=='eager'||!result.visibility.startsWith('visible-then-'),'canvas_product_eager_requires_stable_visibility');
  }else need(result.productSourceStart===undefined,'canvas_product_source_start_requires_product_stage');
  need(['bounded','product'].includes(result.stage)||!result.visibility.startsWith('visible-then-'),'canvas_visibility_transition_requires_bounded_stage');
  need(['bounded','product'].includes(result.stage)||result.canvasPlacement==='attached','canvas_detached_requires_bounded_stage');
  Object.assign(result,{poolSize:3,targetFps:120,timeoutMs:23000});
  if(validateFiles){
    need(inside(path.join(root,'runtime/nv12-shader-probe'),result.helper)&&path.extname(result.helper)==='.exe'&&fs.statSync(result.helper).isFile(),'existing_readback_helper_required');
    need([path.join(root,'runtime/native-screen-capture'),path.join(root,'apps/desktop/build')].some(dir=>inside(dir,result.addon))&&path.extname(result.addon)==='.node'&&fs.statSync(result.addon).isFile(),'verified_handle_bridge_required');
    for(const file of [result.preload,pacerBinary])need(fs.statSync(file).isFile(),'existing_probe_dependency_required');
  }
  return result;
}
async function startServer(){
  const token='/'+crypto.randomBytes(24).toString('hex');let requests=0;
  const server=http.createServer((request,response)=>{
    const valid=request.method==='GET'&&request.url===token&&request.socket.remoteAddress==='127.0.0.1';
    response.writeHead(valid?200:404,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"});
    if(valid)requests++;response.end(valid?'<!doctype html><title>Cove owned synthetic Canvas qualification</title><body></body>':'');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return{url:`http://127.0.0.1:${server.address().port}${token}`,requests:()=>requests,
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
function stats(values){values=values.filter(Number.isFinite);if(!values.length)return{count:0,meanMs:null,p50Ms:null,p95Ms:null,maxMs:null};const sorted=[...values].sort((a,b)=>a-b);
  return{count:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:sorted[Math.floor((sorted.length-1)*.5)],p95Ms:sorted[Math.floor((sorted.length-1)*.95)],maxMs:sorted.at(-1)};}
function summarize(renderer){
  const inputs=renderer.inputs,outputs=renderer.outputs,serials=new Set(outputs.map(s=>s.serial));
  const rate=(samples,key)=>samples.length>1?(samples.length-1)*1000/(samples.at(-1)[key]-samples[0][key]):null;
  return{actualInputFrames:inputs.length,uniqueOutputFrames:outputs.length,duplicateOutputs:renderer.duplicateOutputs,
    inputFramesPerSecond:rate(inputs,'drawAtMs'),uniqueOutputFramesPerSecond:rate(outputs,'receivedAtMs'),
    missingInputSerials:inputs.map(s=>s.serial).filter(s=>!serials.has(s)),allFramesObserved:inputs.length>0&&inputs.length===outputs.length,
    copyCall:stats(outputs.map(s=>s.copyCallWallMs)),copyPromise:stats(outputs.map(s=>s.copyPromiseWallMs)),
    frameAge:stats(outputs.map(s=>s.frameAgeMs)),sourceToCopyCompleteAge:stats(outputs.map(s=>s.sourceToCopyCompleteAgeMs)),
    draw:stats(inputs.map(s=>s.drawWallMs)),
    interpretation:'copyTo AB call latency is observational; format/latency alone do not prove mappability or GPU route. Unique finite synthetic frames are not Cove capture FPS.',
    productionEligible:false,productionBlocker:'Canvas has no public pending-capture bound; finite output/age/memory evidence does not establish safe continuous 1080p120 backpressure'};
}
function rendererFile(config){return path.join(__dirname,config.stage==='product'?'product-renderer.cjs':config.stage==='bounded'?'bounded-renderer.cjs':'renderer.cjs');}
const productModuleFile=path.join(root,'apps/desktop/src/features/media/screen/nativeCanvasFrameSink.ts');
function compileProductModule(){
  const ts=require(path.join(root,'node_modules/typescript')),source=fs.readFileSync(productModuleFile,'utf8');
  const parsed=ts.createSourceFile(productModuleFile,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
  need(!parsed.statements.some(s=>ts.isImportDeclaration(s)||ts.isImportEqualsDeclaration(s)||
    (ts.isExportDeclaration(s)&&s.moduleSpecifier)),'canvas_product_module_must_be_self_contained');
  const compiled=ts.transpileModule(source,{fileName:productModuleFile,reportDiagnostics:true,
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,isolatedModules:true,sourceMap:false}});
  need(!compiled.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error),'canvas_product_transpile_failed');
  need(!/\brequire\s*\(/.test(compiled.outputText),'canvas_product_runtime_import_disallowed');
  return{sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),
    compiledSha256:crypto.createHash('sha256').update(compiled.outputText).digest('hex'),typescriptVersion:ts.version,
    expression:'(()=>{const exports={};\n'+compiled.outputText+'\nreturn exports;})()'};
}
function dependencyHashes(config){return Object.fromEntries([['runner',__filename],['renderer',rendererFile(config)],
  ['helperSource',path.join(__dirname,'../nv12-shader-probe/readback-helper.cpp')],['includedShaderHelperSource',path.join(__dirname,'../nv12-shader-probe/helper.cpp')],
  ['helper',config.helper],['preload',config.preload],['addon',config.addon],['pacer',pacerBinary],['pacerAdapter',path.join(__dirname,'../cpu-frame-socket-probe/pacer.cjs')],
  ...(config.stage==='product'?[['productModule',productModuleFile]]:[])].map(([key,file])=>[key,digest(file)]));}
function readyForNativeRelease(lease){return !lease.released&&lease.referencesReleased&&lease.transferComplete&&lease.mainReleased&&lease.importedAckSent&&lease.permitSent;}
function boundedRendererDrained(renderer){const b=renderer?.bounded;return !!b?.primed&&!b.pendingAdmissionTask&&
  b.creditsGranted===renderer.inputs.length&&b.receipts.length===renderer.inputs.length+b.supersededSerials.length;}
function productRendererDrained(renderer){const p=renderer?.product;return !!p?.primed&&p.pendingSubmissions===0&&
  p.receipts.length===p.submissions.length&&p.onWritten.length===renderer.inputs.length&&renderer.outputs.length===renderer.inputs.length;}
function waitForRendererPrime(config){return config.stage==='bounded'||(config.stage==='product'&&config.productSourceStart==='after-prime');}
function productStartupTimeline(renderer,source){
  const p=renderer?.product,s=p?.startup;
  const epoch=(origin,value)=>Number.isFinite(origin)&&Number.isFinite(value)?origin+value:null;
  return{sourceStart:p?.sourceStart??null,clock:'performance.timeOrigin + performance.now; approximate cross-process epoch milliseconds',
    moduleCreateStartedEpochMs:epoch(s?.timeOriginMs,s?.moduleCreateStartedAtMs),moduleCreatedEpochMs:epoch(s?.timeOriginMs,s?.moduleCreatedAtMs),
    sourceSpawnRequestedEpochMs:epoch(source?.timeOriginMs,source?.spawnRequestedAtMs),sourceSpawnedEpochMs:epoch(source?.timeOriginMs,source?.spawnedAtMs),
    sourceReadyObservedEpochMs:epoch(source?.timeOriginMs,source?.readyObservedAtMs),pacerStartedEpochMs:epoch(source?.timeOriginMs,source?.pacerStartedAtMs),
    firstSourceOfferEpochMs:epoch(source?.timeOriginMs,source?.firstOfferAtMs),primeReadyEpochMs:epoch(s?.timeOriginMs,s?.primeReadyAtMs),
    firstNativeInputEpochMs:epoch(s?.timeOriginMs,s?.firstInputAtMs),firstInputBeforePrime:s?.firstInputBeforePrime??null,
    inputsBeforePrime:s?.inputsBeforePrime??null,
    interpretation:'eager removes the ready gate only; module creation still precedes helper spawn. No early-input overlap is claimed unless observed.'};
}
function cleanRuntimeEnvironment(input){const env={...input};for(const key of Object.keys(env))if(['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))delete env[key];return env;}
function entryMode({electron,isMain,args}){return electron?'electron':!isMain?'import':args[0]==='--check'?'check':'launch';}
function boundedLogSink(write,limitBytes=65536){let bytesSeen=0,bytesKept=0;return{
  append(chunk){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytesSeen+=bytes.length;const room=limitBytes-bytesKept;
    if(room>0){const kept=bytes.subarray(0,room);write(kept);bytesKept+=kept.length;}},
  state:()=>({limitBytes,bytesSeen,bytesKept,truncated:bytesSeen>bytesKept})};}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function baseResult(){return{probe:'synthetic-gpu-canvas-route-v1',passed:false,errorCode:null,phase:'launcher_initialized',startedAt:new Date().toISOString(),
  desktopCapture:false,productChanged:false,externalNetworkUsed:false,pixelsOrHandlesPersisted:false,traceCaptured:false,
  routeClaim:'finite CanvasCapture qualification only; no zero-copy or production backpressure claim'};}
async function launch(){
  // A reviewable scaffold exists before validating dependencies or spawning.
  const parsed=configuration(process.argv.slice(2),false);fs.mkdirSync(runtime,{recursive:true});const directory=fs.mkdtempSync(path.join(runtime,parsed.stage+'-'));
  const resultPath=path.join(directory,'result.json'),launchPath=path.join(directory,'launch.json');
  const launchState={phase:'validating_dependencies',launcherPid:process.pid,ownedChildPid:null,electronEntryObserved:false,
    cleanRuntimeEnvironment:{NODE_OPTIONS:true,NODE_PATH:true,ELECTRON_RUN_AS_NODE:true},startedAt:new Date().toISOString(),exitCode:null,interrupted:false,timedOut:false,errorCode:null};
  writeJson(resultPath,{...baseResult(),launcher:{pid:process.pid,childPid:null}});writeJson(launchPath,launchState);
  const stdoutPath=path.join(directory,'electron-stdout.log'),stderrPath=path.join(directory,'electron-stderr.log');
  fs.writeFileSync(stdoutPath,'');fs.writeFileSync(stderrPath,'');
  const stdout=boundedLogSink(bytes=>fs.appendFileSync(stdoutPath,bytes)),stderr=boundedLogSink(bytes=>fs.appendFileSync(stderrPath,bytes));
  let child,stopping,watchdog,interrupt,exitCode=null;
  const stop=()=>stopping||=(async()=>{
    if(!child)return;if(child.connected)try{child.send({type:'stop'},()=>{});}catch{}
    for(let n=0;n<15&&child.exitCode===null&&child.signalCode===null;n++)await sleep(100);
    if(child.exitCode!==null||child.signalCode!==null)return;
    // Only this launcher's known child tree. Never enumerate/kill user apps.
    if(Number.isInteger(child.pid)&&child.pid>0)await new Promise(resolve=>{
      let kill;try{kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{try{child.kill();}catch{}resolve();return;}
      kill.once('error',()=>{try{child.kill();}catch{}resolve();});kill.once('close',resolve);});
  })();
  try{
    const config=configuration(process.argv.slice(2)),env={...cleanRuntimeEnvironment(process.env),COVE_CANVAS_DIRECTORY:directory,COVE_CANVAS_CONFIG:JSON.stringify(config)};
    const electron=require(path.join(root,'apps/desktop/node_modules/electron'));
    launchState.phase='spawning_owned_electron';writeJson(launchPath,launchState);
    child=spawn(electron,[__filename],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    launchState.ownedChildPid=Number.isInteger(child.pid)?child.pid:null;launchState.phase='waiting_for_electron_entry';writeJson(launchPath,launchState);
    child.stdout.on('data',chunk=>stdout.append(chunk));child.stderr.on('data',chunk=>stderr.append(chunk));
    child.on('message',message=>{if(message?.type==='canvas-electron-entry'&&message.pid===child.pid){launchState.electronEntryObserved=true;launchState.phase='electron_entry_observed';writeJson(launchPath,launchState);}});
    interrupt=()=>{launchState.interrupted=true;void stop();};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    watchdog=setTimeout(()=>{launchState.timedOut=true;launchState.errorCode='canvas_launcher_watchdog';void stop();},28500);
    exitCode=await new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('canvas_electron_spawn_failed')));child.once('close',resolve);});
  }catch(error){launchState.errorCode||=safe(error);await stop();}
  finally{
    clearTimeout(watchdog);await stopping;if(exitCode===null&&Number.isInteger(child?.exitCode))exitCode=child.exitCode;
    if(interrupt){process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
    launchState.exitCode=exitCode;launchState.finishedAt=new Date().toISOString();launchState.logs={stdout:{file:'electron-stdout.log',...stdout.state()},stderr:{file:'electron-stderr.log',...stderr.state()}};
    launchState.phase=launchState.errorCode?'launcher_failed':'child_closed';writeJson(launchPath,launchState);
    const result=readJson(resultPath)||baseResult();
    if(!result.finishedAt){result.passed=false;result.errorCode||=launchState.errorCode||'canvas_electron_incomplete_exit';result.phase='incomplete_electron_run';result.finishedAt=new Date().toISOString();}
    if(launchState.timedOut||launchState.interrupted){result.passed=false;result.errorCode||=launchState.errorCode||'canvas_launcher_interrupted';}
    result.launcher={pid:process.pid,childPid:launchState.ownedChildPid,electronEntryObserved:launchState.electronEntryObserved,logs:launchState.logs,
      timedOut:launchState.timedOut,interrupted:launchState.interrupted,exitCode};writeJson(resultPath,result);
    console.log(JSON.stringify({directory:path.relative(root,directory),resultPath:path.relative(root,resultPath),launchPath:path.relative(root,launchPath),exitCode,
      interrupted:launchState.interrupted,timedOut:launchState.timedOut,result},null,2));
    process.exitCode=exitCode||launchState.errorCode||launchState.interrupted||launchState.timedOut||!result.passed?1:0;
  }
}
async function electronEntry(){
  // Electron's CommonJS main can have require.main !== module. Dispatch by its
  // explicit runtime version, and report bootstrap failure before any GPU work.
  let directory;
  try{
    directory=path.resolve(process.env.COVE_CANVAS_DIRECTORY||'');need(inside(runtime,directory),'invalid_canvas_output_directory');
    const resultPath=path.join(directory,'result.json'),prior=readJson(resultPath)||baseResult();
    writeJson(resultPath,{...prior,phase:'electron_entry',electronMainPid:process.pid,electronEntryAt:new Date().toISOString()});
    if(process.connected)process.send({type:'canvas-electron-entry',pid:process.pid});
    await runElectron();
  }catch(error){
    const errorCode=safe(error);console.error(JSON.stringify({type:'canvas-electron-bootstrap-error',errorCode}));
    if(directory&&inside(runtime,directory)){const file=path.join(directory,'result.json'),prior=readJson(file)||baseResult();
      writeJson(file,{...prior,passed:false,errorCode,phase:'electron_bootstrap_failed',electronMainPid:process.pid,finishedAt:new Date().toISOString()});}
    require('electron').app.exit(2);
  }
}
async function runElectron(){
  const {app,BrowserWindow,ipcMain,sharedTexture}=require('electron');
  const directory=path.resolve(process.env.COVE_CANVAS_DIRECTORY||'');need(inside(runtime,directory),'invalid_canvas_output_directory');
  const supplied=JSON.parse(process.env.COVE_CANVAS_CONFIG||'{}'),config=configuration(['--stage',supplied.stage,'--helper',supplied.helper,'--addon',supplied.addon,'--visibility',supplied.visibility||'hidden','--canvas-placement',supplied.canvasPlacement||'attached',
    ...(supplied.stage==='bounded'?['--bounded-sink',supplied.boundedSink||'direct']:[]),
    ...(supplied.stage==='product'?['--product-source-start',supplied.productSourceStart||'after-prime']:[])]);
  const profile=path.join(directory,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
  const result={...(readJson(path.join(directory,'result.json'))||{}),...baseResult(),phase:'electron_configuration',electronMainPid:process.pid,config:{stage:config.stage,width:config.width,height:config.height,
    frames:config.frames,poolSize:3,targetFps:120,timeoutMs:config.timeoutMs,visibility:config.visibility,canvasPlacement:config.canvasPlacement,
    ...(config.stage==='bounded'?{boundedSink:config.boundedSink}:{}),...(config.stage==='product'?{productSourceStart:config.productSourceStart}:{})},hashes:dependencyHashes(config),
    desktopCapture:false,productChanged:false,externalNetworkUsed:false,pixelsOrHandlesPersisted:false,traceCaptured:false,
    routeClaim:'finite CanvasCapture qualification only; no zero-copy or production backpressure claim',memorySamples:[]};
  const save=()=>fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');
  let window,owned,helper,owner,lines,pacer,helperClosed=false,helperCode=null,stopped=false,retiring=false,fault=null;
  let temporaryHandles=0,issued=0,offered=0,released=0,nativeDone=false,lastOutputCount=0,lastOutputChanged=performance.now();
  const leases=new Map(),slots=new Set(),queue=[],tasks=new Set();
  const fail=code=>{fault||=code;};
  const stop=()=>{stopped=true;if(helper&&!helperClosed&&!helper.stdin.destroyed)helper.stdin.end('stop\n');void pacer?.stop();};
  process.on('message',message=>{if(message?.type==='stop')stop();});process.once('disconnect',stop);
  const send=text=>{need(helper&&!helperClosed&&!helper.stdin.destroyed,'canvas_helper_stdin_closed');helper.stdin.write(text,error=>{if(error)fail('canvas_helper_stdin_failed');});};
  const releaseMain=lease=>{if(lease.imported&&lease.transferSettled&&!lease.mainReleased){lease.mainReleased=true;lease.imported.release();}};
  const maybeRelease=lease=>{
    if(fault||stopped||retiring||!readyForNativeRelease(lease))return;
    try{lease.released=true;lease.releaseAtMs=performance.now();send(`released ${lease.slot} ${lease.serial}\n`);released++;slots.delete(lease.slot);}catch(error){fail(safe(error));}
  };
  const accept=async(value,lease,tick)=>{
    let duplicate;const source=Buffer.alloc(8);source.writeBigUInt64LE(BigInt(value.handle));value.handle=undefined;
    try{
      duplicate=owner.duplicate(source);temporaryHandles++;
      need(Buffer.isBuffer(duplicate.handle)&&duplicate.handle.length===8&&duplicate.handle.readBigUInt64LE()!==0n,'canvas_invalid_owned_duplicate');
      lease.importAtMs=performance.now();lease.pacerSequence=tick.seq;lease.pacerElapsedUs=tick.elapsedUs;
      lease.imported=sharedTexture.importSharedTexture({textureInfo:{handle:{ntHandle:duplicate.handle},pixelFormat:'bgra',
        codedSize:{width:config.width,height:config.height},timestamp:value.timestamp,
        colorSpace:{primaries:'bt709',transfer:'srgb',matrix:'rgb',range:'full'}},
        allReferencesReleased:()=>{lease.referencesReleased=true;lease.allReferencesReleasedAtMs=performance.now();maybeRelease(lease);}});
    }finally{source.fill(0);if(duplicate){duplicate.close();temporaryHandles--;}}
    const metadata={requestId,sessionId,slot:value.slot,serial:value.serial,width:config.width,height:config.height,timestamp:value.timestamp,refresh:false,pixelFormat:'bgra'};
    lease.transfer=Promise.resolve().then(()=>sharedTexture.sendSharedTexture({frame:window.webContents.mainFrame,importedSharedTexture:lease.imported},metadata));
    try{await lease.transfer;lease.transferComplete=true;}finally{lease.transferSettled=true;releaseMain(lease);}
    if(fault||stopped||retiring)return;
    send(`imported ${lease.slot} ${lease.serial}\n`);lease.importedAckSent=true;
    window.webContents.mainFrame.send('cove:native-screen:release-permit',metadata);lease.permitSent=true;maybeRelease(lease);
  };
  const requestId='canvas_'+crypto.randomBytes(8).toString('hex'),sessionId=crypto.randomUUID();
  const nativeLine=line=>{try{
    need(line.length<=8192,'canvas_native_line_overflow');const value=JSON.parse(line);need(value.probe==='synthetic-readback-stream','canvas_unexpected_native_probe');
    if(value.type==='error'){result.nativeError={code:/^[a-z0-9_]{1,80}$/.test(value.code)?value.code:'invalid_native_error',hresult:Number.isInteger(value.hresult)?value.hresult:null};throw new Error('canvas_native_failed');}
    if(value.type==='ready'){
      need(!result.nativeReady&&value.protocol===3&&value.width===config.width&&value.height===config.height&&value.poolSize===3&&value.frames===config.frames&&
        value.pixelFormat==='bgra'&&value.pattern==='scaled-golden-sequence-bits-v1'&&value.syncMode==='held-query','canvas_invalid_native_ready');
      result.nativeReady={protocol:3,poolSize:3,pattern:value.pattern,syncMode:value.syncMode};return;
    }
    if(value.type==='frame'){
      need(result.nativeReady&&value.serial===issued+1&&value.serial<=config.frames&&Number.isInteger(value.slot)&&value.slot>=0&&value.slot<3&&!slots.has(value.slot)&&
        value.width===config.width&&value.height===config.height&&value.pixelFormat==='bgra'&&value.producerGpuComplete===true&&value.timestamp===value.serial*1000&&
        typeof value.handle==='string'&&/^0x[0-9a-f]{1,16}$/i.test(value.handle)&&BigInt(value.handle)!==0n,'canvas_invalid_native_frame');
      issued++;slots.add(value.slot);result.maxNativeLeases=Math.max(result.maxNativeLeases||0,slots.size);
      const lease={slot:value.slot,serial:value.serial,readyAtMs:performance.now(),transferSettled:false,transferComplete:false,mainReleased:false,
        importedAckSent:false,permitSent:false,referencesReleased:false,released:false};leases.set(value.serial,lease);queue.push({value,lease});need(queue.length<=3,'canvas_source_queue_overflow');return;
    }
    if(value.type==='done'){need(!nativeDone&&value.frames===config.frames&&value.released===config.frames&&value.allReferencesReleased===true&&released===config.frames,'canvas_invalid_native_done');nativeDone=true;return;}
    throw new Error('canvas_unknown_native_message');
  }catch(error){fail(safe(error));}};
  const windowState=()=>({visible:!!window&&!window.isDestroyed()&&window.isVisible(),focused:!!window&&!window.isDestroyed()&&window.isFocused(),
    minimized:!!window&&!window.isDestroyed()&&window.isMinimized()});
  const memorySample=label=>{const entries=app.getAppMetrics().map(m=>({type:m.type,memory:m.memory}));result.memorySamples.push({label,atMs:performance.now(),window:windowState(),processes:entries});};
  try{
    result.phase='waiting_for_electron_ready';save();await app.whenReady();need(process.platform==='win32'&&process.arch==='x64'&&process.versions.electron==='44.0.0','electron44_windows_x64_required');
    need(typeof sharedTexture?.importSharedTexture==='function'&&typeof sharedTexture?.sendSharedTexture==='function','canvas_shared_texture_api_required');
    const bridge=require(config.addon);need(typeof bridge.openChild==='function','canvas_verified_child_bridge_required');
    result.versions={electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node};
    result.security={sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,actualProductPreload:true,
      ownedLoopbackHttp:true,coop:null,coep:null,sharedArrayBufferExceptionFlags:false,windowShown:config.visibility!=='hidden',backgroundThrottling:false};owned=await startServer();
    result.phase='creating_secure_window';save();window=new BrowserWindow({show:config.visibility!=='hidden',width:config.visibility!=='hidden'?720:160,height:config.visibility!=='hidden'?480:120,webPreferences:{preload:config.preload,sandbox:true,contextIsolation:true,nodeIntegration:false,
      webSecurity:true,backgroundThrottling:false,additionalArguments:['--cove-native-gpu-capture=1']}});
    result.visibility={requested:config.visibility,backgroundThrottling:false,mainAtCreation:windowState()};
    window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));window.webContents.session.setPermissionCheckHandler(()=>false);
    window.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const allow=details.url===owned.url;if(!allow)result.blockedRequests=(result.blockedRequests||0)+1;callback({cancel:!allow});});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.on('render-process-gone',()=>fail('canvas_renderer_process_gone'));
    ipcMain.handle('cove:native-screen:stop',event=>{if(event.sender===window?.webContents)fail('canvas_preload_receiver_failed');return true;});
    await window.loadURL(owned.url);
    result.visibility.rendererAtLoad=await window.webContents.executeJavaScript('({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})');
    const product=config.stage==='product'?compileProductModule():null;
    if(product)result.productModule={path:path.relative(root,productModuleFile),sourceSha256:product.sourceSha256,
      compiledSha256:product.compiledSha256,typescriptVersion:product.typescriptVersion,actualDefaultPlatform:true,
      constructorOptions:{width:config.width,height:config.height,fps:120},sourceStart:config.productSourceStart,
      modulePrivateDrainObservable:false,validationAddsFullFrameCopy:true};
    if(product)result.productSourceLifecycle={timeOriginMs:performance.timeOrigin,spawnRequestedAtMs:null,spawnedAtMs:null,
      readyObservedAtMs:null,pacerStartedAtMs:null,firstOfferAtMs:null,waitedForPrime:waitForRendererPrime(config)};
    result.phase='configuring_renderer';save();result.rendererSetup=await window.webContents.executeJavaScript('('+require(rendererFile(config)).toString()+')('+JSON.stringify(requestId)+','+JSON.stringify(config)+(product?','+product.expression:'')+')');
    need(result.rendererSetup.supported&&result.rendererSetup.crossOriginIsolated===false&&result.rendererSetup.nodeType==='undefined'&&result.rendererSetup.status!=='failed','canvas_secure_renderer_setup_failed');
    // Eager changes only this ready gate. Record actual overlap instead of
    // assuming native process startup beats the renderer's black prime.
    if(waitForRendererPrime(config)){
      result.phase='priming_bounded_renderer';save();const primeDeadline=Date.now()+3000;
      while(true){need(!stopped,'canvas_cancelled');const state=await window.webContents.executeJavaScript('window.__coveCanvasRoute');
        need(state?.status!=='failed',state?.errorCode||'canvas_bounded_prime_failed');
        const primeState=config.stage==='product'?state?.result?.product:state?.result?.bounded;
        if(primeState?.primed){result.rendererPrime={completedBeforeNativeSpawn:true,outputTimestampUs:primeState.primeOutputTimestampUs??null,
          ...(config.stage==='product'?{readyAtMs:primeState.primeReadyAtMs}:{} )};break;}
        need(Date.now()<primeDeadline,'canvas_bounded_prime_timeout');await sleep(5);}
      if(config.visibility.startsWith('visible-then-')){
        result.phase='transitioning_primed_owned_window';save();
        const beforeRenderer=await window.webContents.executeJavaScript('({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})');
        result.visibility.transition={afterActualPrime:true,atMs:performance.now(),before:{main:windowState(),renderer:beforeRenderer}};
        const minimize=config.visibility==='visible-then-minimized';if(minimize)window.minimize();else window.hide();
        const transitionDeadline=Date.now()+1000;
        while(minimize?!window.isMinimized():window.isVisible()){
          need(!stopped,'canvas_cancelled');need(!fault,fault);need(Date.now()<transitionDeadline,'canvas_owned_window_transition_timeout');await sleep(5);
        }
        result.visibility.transition.completedAtMs=performance.now();
        result.visibility.transition.after={main:windowState(),renderer:await window.webContents.executeJavaScript('({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})')};
      }
    }
    result.visibility.beforeNativeSource={main:windowState(),renderer:await window.webContents.executeJavaScript('({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})')};
    result.phase='spawning_native_source';save();memorySample('before_source');
    if(result.productSourceLifecycle)result.productSourceLifecycle.spawnRequestedAtMs=performance.now();
    helper=spawn(config.helper,['--owner-pid',String(process.pid),'--width',String(config.width),'--height',String(config.height),
      '--pool-size','3','--frames',String(config.frames),'--pixel-format','bgra'],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
    helper.stdin.on('error',()=>fail('canvas_native_stdin_failed'));helper.stderr.resume();helper.once('close',code=>{helperClosed=true;helperCode=code;});helper.once('error',()=>fail('canvas_native_spawn_failed'));
    await bounded(new Promise((resolve,reject)=>{helper.once('spawn',resolve);helper.once('error',()=>reject(new Error('canvas_native_spawn_failed')));}),1000,'canvas_native_spawn_timeout');
    if(result.productSourceLifecycle)result.productSourceLifecycle.spawnedAtMs=performance.now();
    owner=bridge.openChild(helper.pid);lines=readline.createInterface({input:helper.stdout});lines.on('line',nativeLine);
    const deadline=Date.now()+config.timeoutMs;let nextMemory=performance.now()+250;
    while(!result.nativeReady||queue.length<3){need(!fault,fault);need(!stopped,'canvas_cancelled');need(Date.now()<deadline,'canvas_source_ready_timeout');await sleep(5);}
    if(result.productSourceLifecycle)result.productSourceLifecycle.readyObservedAtMs=performance.now();
    result.phase='running_finite_capture';result.pacing={sourcePrefillFrames:3,gate:'one ready GPU source offered per real native120Hz timer I/O task; no burst catch-up',timer:'existing native high-resolution waitable timer',
      sourceNativeProductionRateClaimed:false,missedSourceTicks:0};
    if(result.productSourceLifecycle)result.productSourceLifecycle.pacerStartedAtMs=performance.now();
    pacer=startPacer({seconds:5,check:()=>{need(!fault,fault);need(!stopped,'canvas_cancelled');},onTick:tick=>{
      if(offered>=config.frames)return;
      const next=queue.shift();if(!next){result.pacing.missedSourceTicks++;return;}
      if(result.productSourceLifecycle?.firstOfferAtMs===null)result.productSourceLifecycle.firstOfferAtMs=performance.now();
      offered++;const task=accept(next.value,next.lease,tick).catch(error=>fail(safe(error)));tasks.add(task);task.finally(()=>tasks.delete(task));
      if(offered===config.frames)void pacer.stop();
    }});pacer.done.catch(error=>fail(safe(error)));
    while(true){
      need(!stopped,'canvas_cancelled');need(!fault,fault);need(Date.now()<deadline,'canvas_case_timeout');
      const state=await window.webContents.executeJavaScript('({status:window.__coveCanvasRoute?.status,errorCode:window.__coveCanvasRoute?.errorCode,result:window.__coveCanvasRoute?.result,visibility:{visibilityState:document.visibilityState,hasFocus:document.hasFocus()}})');
      result.visibility.rendererLast=state.visibility;
      result.renderer=state.result;if(state.status==='failed')throw new Error(state.errorCode||'canvas_renderer_failed');
      if(state.result.outputs.length!==lastOutputCount){lastOutputCount=state.result.outputs.length;lastOutputChanged=performance.now();}
      if(performance.now()>=nextMemory){memorySample('during');save();nextMemory=performance.now()+250;}
      const rendererDrained=config.stage==='product'?productRendererDrained(state.result):config.stage!=='bounded'||boundedRendererDrained(state.result);
      if(offered===config.frames&&nativeDone&&helperClosed&&rendererDrained&&performance.now()-lastOutputChanged>=500)break;
      if(helperClosed&&!nativeDone)throw new Error('canvas_native_exited_before_release');await sleep(10);
    }
    await pacer.done;result.pacer=pacer.state();
    need(helperCode===0&&issued===config.frames&&offered===config.frames&&released===config.frames&&slots.size===0&&queue.length===0,'canvas_source_release_barrier_incomplete');
    result.summary=summarize(result.renderer);result.leases=[...leases.values()].map(l=>({serial:l.serial,slot:l.slot,pacerSequence:l.pacerSequence,pacerElapsedUs:l.pacerElapsedUs,
      sourceReadyToImportMs:l.importAtMs-l.readyAtMs,importToAllRefsReleasedMs:l.allReferencesReleasedAtMs-l.importAtMs,
      sourceLeaseLifetimeMs:l.releaseAtMs-l.readyAtMs,allReferencesReleased:l.referencesReleased&&l.released&&l.mainReleased&&l.transferComplete}));
    result.pipeline={issued,offered,released,allReferencesReleased:result.leases.every(l=>l.allReferencesReleased),maxNativeLeases:result.maxNativeLeases};
    result.passed=result.pipeline.allReferencesReleased;
    if(!result.passed)result.errorCode='canvas_source_release_barrier_incomplete';
  }catch(error){result.errorCode=safe(error);result.passed=false;}
  finally{
    result.phase='cleanup';save();retiring=true;if(helper&&!helperClosed&&!helper.stdin.destroyed)helper.stdin.end('stop\n');
    if(pacer){await pacer.stop().catch(()=>{});result.pacer=pacer.state();}
    if(window&&!window.isDestroyed()){
      result.rendererCleanup=await bounded(window.webContents.executeJavaScript('window.__coveCanvasRouteCleanup?.()'),2000,'canvas_renderer_cleanup_timeout').catch(()=>({callbacks:-1,pendingCopies:-1,readerStopped:false}));
      result.renderer=await window.webContents.executeJavaScript('window.__coveCanvasRoute?.result').catch(()=>result.renderer);memorySample('after_renderer_cleanup');result.visibility.mainBeforeDestroy=windowState();window.destroy();
    }
    // Cleanup drains the real copy promise; it may add an output or expose an
    // error after the main poll's last snapshot. Keep the final evidence exact.
    if(result.renderer)result.summary=summarize(result.renderer);
    if(result.rendererCleanup?.status==='failed'){result.passed=false;result.errorCode||=result.rendererCleanup.errorCode||'canvas_renderer_failed_during_cleanup';}
    if(!result.summary?.uniqueOutputFrames){result.passed=false;result.errorCode||='canvas_no_valid_outputs';}
    if(config.stage==='bounded'){
      const b=result.renderer?.bounded,c=result.rendererCleanup;
      result.boundedSummary=b?{sinkMode:b.sinkMode,receivedNativeFrames:b.receipts.length,admittedCanvasFrames:result.renderer.inputs.length,
        completedCanvasFrames:b.completedSerials.length,
        generatorWrittenFrames:b.writtenSerials.length,supersededNativeFrames:b.supersededSerials.length,
        maxCanvasAdmissions:b.maxCanvasAdmissions,maxPendingInputs:b.maxPendingInputs,maxWrites:b.maxWrites,
        creditsGranted:b.creditsGranted,generatorSettings:b.generatorSettings,writer:stats(b.writes.map(w=>w.writeWallMs)),
        writerReadyAndWrite:stats(b.writes.map(w=>w.totalWallMs)),productionEligible:false,
        qualification:'finite pinned-Chromium single-admission fixture; no production capture, encoder or RTP qualification'}:null;
      if(!b||!b.primed||b.receipts.length!==config.frames||b.maxCanvasAdmissions!==1||b.maxPendingInputs>1||b.maxWrites>1||
        b.cancelledSerials.length||b.completedSerials.length!==result.renderer.inputs.length||b.creditsGranted!==b.completedSerials.length||
        b.writtenSerials.length!==(config.boundedSink==='none'?0:b.completedSerials.length)||
        b.receipts.length!==result.renderer.inputs.length+b.supersededSerials.length||
        (config.boundedSink!=='none'&&(b.generatorSettings?.width!==config.width||b.generatorSettings?.height!==config.height))||
        c?.pendingWrites!==0||c?.pendingInputFrames!==0||c?.pendingCanvasAdmissions!==0||c?.pendingAdmissionTasks!==0||
        c?.admissionPortsClosed!==true||c?.writerClosed!==(config.boundedSink==='none'?null:true)){
        result.passed=false;result.errorCode||='canvas_bounded_contract_incomplete';}
    }
    if(config.stage==='product'){
      const p=result.renderer?.product,c=result.rendererCleanup;
      result.productStartup=productStartupTimeline(result.renderer,result.productSourceLifecycle);
      result.productSummary=p?{receivedNativeFrames:p.receipts.length,admittedCanvasFrames:result.renderer.inputs.length,
        generatorWrittenFrames:p.writtenSerials.length,submitResults:p.submissions.reduce((a,s)=>(a[s.result]=(a[s.result]||0)+1,a),{}),
        writer:stats(p.writes.map(w=>w.writeWallMs)),validation:stats(p.writes.map(w=>w.validationWallMs)),
        validationAndWrite:stats(p.writes.map(w=>w.totalWallMs)),generatorSettings:p.generatorSettings,
        maxWrites:p.maxWrites,maxPendingSubmissions:p.maxPendingSubmissions,moduleFailures:p.moduleFailures,
        modulePrivateDrainObservable:false,productionEligible:false,
        qualification:'actual product sink default browser platform with synthetic GPU inputs, extra CPU pixel inspection and real Generator; no DDA, encoder or RTP qualification'}:null;
      const drawn=new Set(p?.submissions.filter(s=>s.result==='drawn').map(s=>s.serial));
      if(!p||!p.primed||p.receipts.length!==config.frames||p.submissions.length!==config.frames||
        p.submissions.some(s=>s.result==='stopped')||p.moduleFailures.length||p.maxWrites!==1||
        p.writtenSerials.length!==drawn.size||p.writtenSerials.some(s=>!drawn.has(s))||p.onWritten.length!==drawn.size||
        p.generatorSettings?.width!==config.width||p.generatorSettings?.height!==config.height||
        c?.pendingInputFrames!==0||c?.pendingWrites!==0||c?.moduleStopCalled!==true||c?.writerClosed!==true){
        result.passed=false;result.errorCode||='canvas_product_contract_incomplete';}
    }
    await bounded(Promise.allSettled([...tasks]),500,'canvas_transfer_cleanup_timeout').catch(()=>{});
    for(const lease of leases.values())try{releaseMain(lease);}catch{result.passed=false;result.errorCode||='canvas_main_release_failed';}
    for(let n=0;n<10&&helper&&!helperClosed;n++)await sleep(50);
    if(helper&&!helperClosed){helper.kill();for(let n=0;n<10&&!helperClosed;n++)await sleep(50);}
    lines?.close();owner?.close();ipcMain.removeHandler('cove:native-screen:stop');
    result.cleanup={helperAlive:!!helper&&!helperClosed,pacerAlive:!!pacer&&pacer.state().childAlive,temporaryMainHandles:temporaryHandles,
      childHandleOwnerOpen:false,mainImportsRetained:[...leases.values()].filter(l=>l.imported&&!l.mainReleased).length,
      rendererWindowAlive:!!window&&!window.isDestroyed(),pendingTransfers:tasks.size,helperExitCode:helperCode};
    if(result.cleanup.helperAlive||result.cleanup.pacerAlive||temporaryHandles||result.cleanup.mainImportsRetained||result.cleanup.rendererWindowAlive||tasks.size||
      result.rendererCleanup?.callbacks!==0||result.rendererCleanup?.pendingCopies!==0||
      (config.stage==='product'?result.rendererCleanup?.moduleStopCalled!==true:result.rendererCleanup?.readerStopped!==true)){result.passed=false;result.errorCode||='canvas_cleanup_incomplete';}
    // Clear transient handle strings in queued frames without persisting them.
    for(const item of queue)item.value.handle=undefined;queue.length=0;
    if(owned){result.ownedLoopbackRequests=owned.requests();await owned.close();}result.phase=result.passed?'completed':'failed';result.finishedAt=new Date().toISOString();save();app.exit(result.passed?0:2);
  }
}
const mode=entryMode({electron:process.versions.electron,isMain:require.main===module,args:process.argv.slice(2)});
if(mode==='check'){try{const config=configuration(process.argv.slice(3)),product=config.stage==='product'?compileProductModule():null;
  console.log(JSON.stringify({checked:true,gpuExecuted:false,config,hashes:dependencyHashes(config),...(product?{productModule:{sourceSha256:product.sourceSha256,compiledSha256:product.compiledSha256,typescriptVersion:product.typescriptVersion}}:{})},null,2));}catch(error){console.error(safe(error));process.exitCode=2;}}
else if(mode!=='import'){
  (mode==='electron'?electronEntry():launch()).catch(error=>{
    console.error(JSON.stringify({type:'canvas-entry-failure',mode,errorCode:safe(error)}));process.exitCode=2;
    if(mode==='electron')require('electron').app.exit(2);
  });
}
module.exports={configuration,startServer,summarize,stats,inside,readyForNativeRelease,boundedRendererDrained,productRendererDrained,waitForRendererPrime,productStartupTimeline,compileProductModule,entryMode,cleanRuntimeEnvironment,boundedLogSink};
