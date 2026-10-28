'use strict';
// Explicit GPU entry point. Importing, --check and the unit suite are CPU only.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const readline=require('node:readline');
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'../../..');
const runtime=path.join(root,'runtime/nv12-shader-probe');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const need=(condition,code)=>{if(!condition)throw new Error(code);};
const safeCode=error=>/^[a-z0-9_]{1,100}$/.test(error?.message)?error.message:'readback_internal_failure';
const inside=(parent,target)=>{const relative=path.relative(parent,target);return !!relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
async function bounded(promise,ms,code) {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);})]);}finally{clearTimeout(timer);}
}
function configuration(args,validateFiles=true) {
  const result={helper:path.join(runtime,'readback-helper-hires.exe'),addon:path.join(root,'runtime/native-screen-capture/native-screen-handles.node'),
    preload:path.join(root,'apps/desktop/dist-electron/preload.js'),sizes:[[64,64],[1728,1080]],formats:['nv12','bgra'],buffers:['ab','sab'],inflight:[1,3],frames:24};
  const seen=new Set();
  for(let index=0;index<args.length;++index) {
    const key=args[index];need(!seen.has(key)&&index+1<args.length,'invalid_readback_arguments');seen.add(key);const value=args[++index];
    if(key==='--helper'||key==='--addon')result[key.slice(2)]=path.resolve(value);
    else if(key==='--sizes') {const allowed={'64':[64,64],'1728':[1728,1080],'1920':[1920,1080]};result.sizes=value.split(',').map(size=>{need(allowed[size],'invalid_readback_sizes');return allowed[size];});}
    else if(key==='--formats') {result.formats=value.split(',');need(result.formats.every(v=>['nv12','bgra'].includes(v)),'invalid_readback_formats');}
    else if(key==='--buffers') {result.buffers=value.split(',');need(result.buffers.every(v=>['ab','sab'].includes(v)),'invalid_readback_buffers');}
    else if(key==='--inflight') {result.inflight=value.split(',').map(Number);need(result.inflight.every(v=>v===1||v===3),'invalid_readback_inflight');}
    else if(key==='--frames') {need(/^\d+$/.test(value),'invalid_readback_frames');result.frames=Number(value);need(result.frames>=3&&result.frames<=250,'invalid_readback_frames');}
    else throw new Error('invalid_readback_arguments');
  }
  for(const key of ['sizes','formats','buffers','inflight'])need(new Set(result[key].map(JSON.stringify)).size===result[key].length,'duplicate_readback_matrix_value');
  if(validateFiles) {
    need(inside(runtime,result.helper)&&path.extname(result.helper)==='.exe'&&fs.statSync(result.helper).isFile(),'isolated_readback_helper_required');
    need([path.join(root,'runtime/native-screen-capture'),path.join(root,'apps/desktop/build')].some(dir=>inside(dir,result.addon))&&path.extname(result.addon)==='.node'&&fs.statSync(result.addon).isFile(),'existing_handle_bridge_required');
    need(fs.statSync(result.preload).isFile(),'compiled_product_preload_required');
  }
  result.cases=[];
  for(const [width,height]of result.sizes)for(const pixelFormat of result.formats)for(const bufferKind of result.buffers)for(const inflight of result.inflight)
    result.cases.push({width,height,pixelFormat,bufferKind,inflight,frames:result.frames});
  return result;
}
async function startServer() {
  const token='/'+crypto.randomBytes(24).toString('hex');let requests=0;
  const server=http.createServer((request,response)=>{
    const valid=request.method==='GET'&&request.url===token&&request.socket.remoteAddress==='127.0.0.1';
    response.writeHead(valid?200:404,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"});
    if(valid)requests++;response.end(valid?'<!doctype html><title>Cove owned synthetic readback control</title>':'');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}${token}`;
  return {server,url,requests:()=>requests,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
function summarize(renderer) {
  const samples=renderer.samples;
  const stats=key=>{const values=samples.map(sample=>sample[key]).sort((a,b)=>a-b);return{count:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,
    p50Ms:values[Math.floor((values.length-1)*.50)],p95Ms:values[Math.floor((values.length-1)*.95)],maxMs:values.at(-1)};};
  const firstCall=Math.min(...samples.map(sample=>sample.callAtMs)),lastSettle=Math.max(...samples.map(sample=>sample.settledAtMs));
  const firstSettle=Math.min(...samples.map(sample=>sample.settledAtMs));
  return {copyCall:stats('copyCallWallMs'),copyPromise:stats('copyPromiseWallMs'),postCall:stats('copyPostCallWallMs'),
    allocation:stats('allocationWallMs'),validation:stats('validationWallMs'),
    completedReadbacks:samples.length,completedReadbacksPerSecond:samples.length*1000/(lastSettle-firstCall),
    steadyCompletionPerSecond:samples.length>1?(samples.length-1)*1000/(lastSettle-firstSettle):null,
    completionWindowMs:lastSettle-firstCall,throughputScope:'unique synthetic shader frames: producer GPU query, IPC/import/release, allocation, validation and one CPU golden construction affect inter-frame cadence; not desktop capture or Cove FPS',
    maxUnsettledCopyPromises:renderer.maxCopyPromises,maxRendererCallbacks:renderer.maxCallbacks};
}
async function launch() {
  const config=configuration(process.argv.slice(2));fs.mkdirSync(runtime,{recursive:true});const directory=fs.mkdtempSync(path.join(runtime,'readback-'));
  const env={...process.env,COVE_READBACK_DIRECTORY:directory,COVE_READBACK_CONFIG:JSON.stringify(config)};delete env.ELECTRON_RUN_AS_NODE;
  const electron=require(path.join(root,'apps/desktop/node_modules/electron'));
  const child=spawn(electron,[__filename],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});child.stdout.resume();child.stderr.resume();
  let stopping,interrupted=false,timedOut=false;
  const stop=()=>stopping||=(async()=>{
    if(child.connected)child.send({type:'stop'},()=>{});
    for(let n=0;n<50&&child.exitCode===null&&child.signalCode===null;++n)await sleep(100);
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>{child.kill();resolve();});killer.once('close',resolve);});
  })();
  const interrupt=()=>{interrupted=true;void stop();};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const watchdog=setTimeout(()=>{timedOut=true;void stop();},180000);let exitCode;
  try {exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
  finally{clearTimeout(watchdog);await stopping;process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
  const resultPath=path.join(directory,'result.json'),result=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):null;
  console.log(JSON.stringify({directory:path.relative(root,directory),resultPath:path.relative(root,resultPath),exitCode,interrupted,timedOut,result},null,2));
  process.exitCode=exitCode||interrupted||timedOut||!result?.passed?1:0;
}
async function runElectron() {
  const {app,BrowserWindow,ipcMain,sharedTexture}=require('electron');
  const directory=path.resolve(process.env.COVE_READBACK_DIRECTORY||'');need(inside(runtime,directory),'invalid_readback_output_directory');
  const supplied=JSON.parse(process.env.COVE_READBACK_CONFIG||'{}');
  const config=configuration(['--helper',supplied.helper,'--addon',supplied.addon,'--sizes',supplied.sizes.map(size=>String(size[0])).join(','),
    '--formats',supplied.formats.join(','),'--buffers',supplied.buffers.join(','),'--inflight',supplied.inflight.join(','),'--frames',String(supplied.frames)]);
  const profile=path.join(directory,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const result={probe:'synthetic-ab-sab-readback-v1',passed:false,startedAt:new Date().toISOString(),desktopCapture:false,
    externalNetworkUsed:false,personalPixelsOrNativeHandlesPersisted:false,pixelBuffersPersisted:false,
    fixedSyntheticPaletteScalarsPersisted:true,productChanged:false,cases:[],
    api:{electronRequired:'44.0.0',chromeSource:'152.0.7977.54',copyOptions:'omitted format; original VideoFrame native planes',
      source:'https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/modules/webcodecs/video_frame.cc',
      backgroundReadbackSource:'https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/modules/webcodecs/background_readback.cc',
      limitation:'SAB can permit JS asynchronous readback; no claim of GPU DMA parallelism, zero copy, encoder behavior or desktop/Cove 1080p120'},
    hashes:Object.fromEntries([['runner',__filename],['renderer',path.join(__dirname,'readback-renderer.cjs')],['colorOracle',path.join(__dirname,'readback-color-oracle.cjs')],['helperSource',path.join(__dirname,'readback-helper.cpp')],
      ['includedShaderHelperSource',path.join(__dirname,'helper.cpp')],['helper',config.helper],['preload',config.preload],['addon',config.addon]].map(([key,file])=>[key,digest(file)]))};
  const save=()=>fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');
  let ownedHttp,stopped=false,currentStop;
  const stop=()=>{stopped=true;currentStop?.();};process.on('message',message=>{if(message?.type==='stop')stop();});process.once('disconnect',stop);
  const bridge=require(config.addon);need(typeof bridge.openChild==='function','verified_child_bridge_required');
  try {
    save();await app.whenReady();need(process.platform==='win32'&&process.arch==='x64'&&process.versions.electron==='44.0.0','electron44_windows_x64_required');
    need(typeof sharedTexture?.importSharedTexture==='function'&&typeof sharedTexture?.sendSharedTexture==='function','shared_texture_api_required');
    result.versions={electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node};
    result.security={sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,actualProductPreload:true,
      ownedLoopbackHttp:true,coop:'same-origin',coep:'require-corp',sharedArrayBufferExceptionFlags:false,windowShown:false};
    ownedHttp=await startServer();
    for(const cell of config.cases) {
      need(!stopped,'readback_cancelled');const entry={...cell,passed:false};result.cases.push(entry);save();
      let window,helper,owner,lines,helperClosed=false,helperCode=null,fault=null,retiring=false,temporaryHandles=0,issued=0,released=0,done=false;
      let firstFrameAt,lastReleaseAt;const leases=new Map(),slots=new Set(),tasks=new Set();
      const requestId='readback_'+crypto.randomBytes(8).toString('hex'),sessionId=crypto.randomUUID();
      const failCell=code=>{fault ||= code;};
      const send=text=>{need(helper&&!helperClosed&&!helper.stdin.destroyed,'native_stdin_closed');helper.stdin.write(text,error=>{if(error)failCell('native_stdin_failed');});};
      const releaseMain=lease=>{if(lease.imported&&lease.transferSettled&&!lease.mainReleased){lease.mainReleased=true;lease.imported.release();}};
      const maybeRelease=lease=>{
        if(fault||stopped||retiring||lease.released||!lease.referencesReleased||!lease.transferComplete||!lease.mainReleased||!lease.importedAckSent||!lease.permitSent)return;
        try {lease.released=true;send(`released ${lease.slot} ${lease.serial}\n`);released++;slots.delete(lease.slot);lastReleaseAt=performance.now();}
        catch(error){failCell(safeCode(error));}
      };
      const accept=async(value,lease)=>{
        let duplicate;const source=Buffer.alloc(8);source.writeBigUInt64LE(BigInt(value.handle));value.handle=undefined;
        try {
          duplicate=owner.duplicate(source);temporaryHandles++;
          need(Buffer.isBuffer(duplicate.handle)&&duplicate.handle.length===8&&duplicate.handle.readBigUInt64LE()!==0n,'invalid_owned_duplicate');
          lease.imported=sharedTexture.importSharedTexture({textureInfo:{handle:{ntHandle:duplicate.handle},pixelFormat:cell.pixelFormat,
            codedSize:{width:cell.width,height:cell.height},timestamp:value.timestamp,
            colorSpace:cell.pixelFormat==='nv12'?{primaries:'bt709',transfer:'bt709',matrix:'bt709',range:'limited'}:{primaries:'bt709',transfer:'srgb',matrix:'rgb',range:'full'}},
            allReferencesReleased:()=>{lease.referencesReleased=true;maybeRelease(lease);}});
        } finally {source.fill(0);if(duplicate){duplicate.close();temporaryHandles--;}}
        const metadata={requestId,sessionId,slot:value.slot,serial:value.serial,width:cell.width,height:cell.height,timestamp:value.timestamp,refresh:false,pixelFormat:cell.pixelFormat};
        lease.transfer=Promise.resolve().then(()=>sharedTexture.sendSharedTexture({frame:window.webContents.mainFrame,importedSharedTexture:lease.imported},metadata));
        try {await lease.transfer;lease.transferComplete=true;}
        finally {lease.transferSettled=true;releaseMain(lease);}
        if(fault||stopped||retiring)return;
        send(`imported ${lease.slot} ${lease.serial}\n`);lease.importedAckSent=true;
        window.webContents.mainFrame.send('cove:native-screen:release-permit',metadata);lease.permitSent=true;maybeRelease(lease);
      };
      const nativeLine=line=>{
        try {
          need(line.length<=8192,'native_protocol_line_too_large');const value=JSON.parse(line);need(value.probe==='synthetic-readback-stream','unexpected_native_probe');
          if(value.type==='error'){entry.nativeError={code:/^[a-z0-9_]{1,80}$/.test(value.code)?value.code:'invalid_native_error',hresult:Number.isInteger(value.hresult)?value.hresult:null,deviceRemovedReason:Number.isInteger(value.deviceRemovedReason)?value.deviceRemovedReason:null};throw new Error('native_probe_failed');}
          if(value.type==='ready') {
            need(!entry.nativeReady&&value.protocol===3&&value.width===cell.width&&value.height===cell.height&&value.poolSize===cell.inflight&&value.frames===cell.frames&&value.pixelFormat===cell.pixelFormat&&value.pattern==='scaled-golden-sequence-bits-v1'&&value.syncMode==='held-query','invalid_native_ready');
            if(value.gpuCompletionWait!==undefined)need(value.gpuCompletionWait==='private-high-resolution-timer'&&value.gpuPollUs===250&&value.queryReused===true,'invalid_native_wait_mode');
            if(value.ownerCommandWait!==undefined)need(value.ownerCommandWait==='private-high-resolution-timer'&&value.ownerCommandPollUs===250&&value.ownerCommandDeadlineMs===20000,'invalid_native_command_wait_mode');
            entry.nativeReady={protocol:3,poolSize:value.poolSize,pattern:value.pattern,syncMode:value.syncMode,
              gpuCompletionWait:value.gpuCompletionWait??'not-reported',gpuPollUs:value.gpuPollUs??null,queryReused:value.queryReused===true,
              ownerCommandWait:value.ownerCommandWait??'not-reported',ownerCommandPollUs:value.ownerCommandPollUs??null,ownerCommandDeadlineMs:value.ownerCommandDeadlineMs??null};return;
          }
          if(value.type==='frame') {
            need(entry.nativeReady&&value.serial===issued+1&&value.serial<=cell.frames&&Number.isInteger(value.slot)&&value.slot>=0&&value.slot<cell.inflight&&!slots.has(value.slot)&&
              value.width===cell.width&&value.height===cell.height&&value.pixelFormat===cell.pixelFormat&&value.producerGpuComplete===true&&value.timestamp===value.serial*1000&&
              typeof value.handle==='string'&&/^0x[0-9a-f]{1,16}$/i.test(value.handle)&&BigInt(value.handle)!==0n,'invalid_native_frame');
            issued++;slots.add(value.slot);firstFrameAt??=performance.now();entry.maxNativeLeases=Math.max(entry.maxNativeLeases||0,slots.size);
            if(value.producerGpuWaitUs!==undefined) {
              const names=['producerGpuWaitUs','producerQueryPolls','producerTimerWaits','sourceIssueWallUs'];
              need(names.every(name=>Number.isSafeInteger(value[name])&&value[name]>=0)&&value.producerQueryPolls>=1&&value.producerTimerWaits<value.producerQueryPolls,'invalid_native_frame_timing');
              entry.producerFrameTimings??=[];entry.producerFrameTimings.push({serial:value.serial,...Object.fromEntries(names.map(name=>[name,value[name]]))});
            }
            const lease={slot:value.slot,serial:value.serial,transferSettled:false,transferComplete:false,mainReleased:false,importedAckSent:false,permitSent:false,referencesReleased:false,released:false};leases.set(value.serial,lease);
            const task=accept(value,lease).catch(error=>failCell(safeCode(error)));tasks.add(task);task.finally(()=>tasks.delete(task));return;
          }
          if(value.type==='done'){need(!done&&value.frames===cell.frames&&value.released===cell.frames&&value.allReferencesReleased===true&&released===cell.frames,'invalid_native_done');done=true;return;}
          throw new Error('unknown_native_message');
        }catch(error){failCell(safeCode(error));}
      };
      const stopCell=()=>{if(helper&&!helperClosed&&!helper.stdin.destroyed)helper.stdin.end('stop\n');};currentStop=stopCell;
      try {
        window=new BrowserWindow({show:false,width:160,height:120,webPreferences:{preload:config.preload,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,additionalArguments:['--cove-native-gpu-capture=1']}});
        window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));window.webContents.session.setPermissionCheckHandler(()=>false);
        window.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{const allow=details.url===ownedHttp.url;if(!allow)entry.blockedRequests=(entry.blockedRequests||0)+1;callback({cancel:!allow});});
        window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.on('render-process-gone',()=>failCell('renderer_process_gone'));
        ipcMain.handle('cove:native-screen:stop',event=>{if(event.sender===window?.webContents)failCell('preload_receiver_failed');return true;});
        await window.loadURL(ownedHttp.url);
        entry.rendererSetup=await window.webContents.executeJavaScript('('+require('./readback-renderer.cjs').toString()+')('+JSON.stringify(requestId)+','+JSON.stringify(cell)+',('+require('./readback-color-oracle.cjs').toString()+'))');
        need(entry.rendererSetup.supported&&entry.rendererSetup.isolated&&entry.rendererSetup.nodeType==='undefined','renderer_isolated_api_required');
        helper=spawn(config.helper,['--owner-pid',String(process.pid),'--width',String(cell.width),'--height',String(cell.height),'--pool-size',String(cell.inflight),'--frames',String(cell.frames),'--pixel-format',cell.pixelFormat],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
        helper.stdin.on('error',()=>failCell('native_stdin_failed'));helper.stderr.resume();
        helper.once('close',code=>{helperClosed=true;helperCode=code;});helper.once('error',()=>failCell('native_spawn_failed'));
        await bounded(new Promise((resolve,reject)=>{helper.once('spawn',resolve);helper.once('error',()=>reject(new Error('native_spawn_failed')));}),1000,'native_spawn_timeout');
        owner=bridge.openChild(helper.pid);lines=readline.createInterface({input:helper.stdout});lines.on('line',nativeLine);
        const deadline=Date.now()+20000;
        while(true) {
          need(!stopped,'readback_cancelled');need(!fault,fault);need(Date.now()<deadline,'readback_case_timeout');
          const state=await window.webContents.executeJavaScript('({status:window.__coveReadbackProbe?.status,errorCode:window.__coveReadbackProbe?.errorCode,result:window.__coveReadbackProbe?.result})');
          if(state.status==='failed'){entry.renderer=state.result;throw new Error(state.errorCode||'renderer_readback_failed');}
          if(state.status==='complete'&&done&&helperClosed){entry.renderer=state.result;break;}
          if(helperClosed&&!done)throw new Error('native_exited_before_release');await sleep(10);
        }
        need(helperCode===0&&issued===cell.frames&&released===cell.frames&&slots.size===0&&leases.size===cell.frames,'native_release_barrier_incomplete');
        entry.summary=summarize(entry.renderer);entry.pipeline={issued,released,allReferencesReleased:[...leases.values()].every(lease=>lease.referencesReleased&&lease.released&&lease.mainReleased&&lease.transferComplete),
          sourceLeaseWindowMs:lastReleaseAt-firstFrameAt,sourceLeaseCompletionsPerSecond:cell.frames*1000/(lastReleaseAt-firstFrameAt)};
        entry.passed=entry.renderer.passed===true&&entry.pipeline.allReferencesReleased;
      } catch(error) {entry.errorCode=safeCode(error);entry.passed=false;
        if(entry.renderer?.samples?.length){entry.partialReadbackSummary=summarize(entry.renderer);entry.partialReadbackSummary.qualifiedCase=false;}}
      finally {
        retiring=true;currentStop=null;
        // Stop native without claiming pending references have completed.
        stopCell();
        if(window&&!window.isDestroyed()) {
          entry.rendererCleanup=await bounded(window.webContents.executeJavaScript('window.__coveReadbackCleanup?.()'),3000,'renderer_cleanup_timeout').catch(()=>({callbacksDrained:false}));
          window.destroy();
        }
        await bounded(Promise.allSettled([...tasks]),2000,'transfer_cleanup_timeout').catch(()=>{});
        for(const lease of leases.values())try{releaseMain(lease);}catch{entry.errorCode||='main_release_failed';entry.passed=false;}
        for(let n=0;n<20&&helper&&!helperClosed;++n)await sleep(50);
        if(helper&&!helperClosed){helper.kill();for(let n=0;n<20&&!helperClosed;++n)await sleep(50);}
        lines?.close();owner?.close();ipcMain.removeHandler('cove:native-screen:stop');
        entry.cleanup={helperAlive:!!helper&&!helperClosed,temporaryMainHandles:temporaryHandles,childHandleOwnerOpen:false,
          mainImportsRetained:[...leases.values()].filter(lease=>lease.imported&&!lease.mainReleased).length,
          rendererWindowAlive:!!window&&!window.isDestroyed(),pendingTransfers:tasks.size,helperExitCode:helperCode};
        if(entry.cleanup.helperAlive||temporaryHandles||entry.cleanup.mainImportsRetained||entry.cleanup.rendererWindowAlive||tasks.size||entry.rendererCleanup?.callbacksDrained===false){entry.passed=false;entry.errorCode||='readback_cleanup_incomplete';}
        save();
      }
      // Do not schedule additional GPU work after a failed comparison cell.
      if(!entry.passed)break;
    }
    result.passed=!stopped&&result.cases.length===config.cases.length&&result.cases.every(cell=>cell.passed);
  } catch(error){result.errorCode=safeCode(error);result.passed=false;}
  finally {if(ownedHttp){result.ownedLoopbackRequests=ownedHttp.requests();await ownedHttp.close();}result.finishedAt=new Date().toISOString();save();app.exit(result.passed?0:2);}
}
if(process.versions.electron||require.main===module)(process.versions.electron?runElectron():launch()).catch(()=>{console.error('synthetic_readback_launcher_failed');process.exitCode=2;});
module.exports={configuration,startServer,summarize,inside};
