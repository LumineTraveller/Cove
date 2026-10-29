'use strict';
const {validatePerformanceCases}=require('./screen-performance-config.cjs');

const PLAN=Object.freeze({warmupMs:2000,intervalMs:1000,activeSeconds:8,idleSeconds:10,maximumMs:65000,cleanupMs:4000});
const ERROR_CODES=new Set(['cancelled','deadline','operation_failed','not_owned','invalid_snapshot',
  'publication_changed','native_replaced','source_changed','preview_changed','demand_not_settled','counter_reset']);
const error=code=>Object.assign(Error('Native demand comparison: '+code),{code});
const safeError=value=>ERROR_CODES.has(value?.code)?value.code:'operation_failed';
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const token=value=>typeof value==='string'&&value.length>0&&value.length<=128;

function performanceDemandOptions(env=process.env){
  const flag=env.COVE_FPS_DEMAND_CHECKS;
  if(flag!==undefined&&!['0','1'].includes(flag))throw Error('Invalid demand comparison flag');
  const enabled=flag==='1';
  if(enabled){
    if(env.COVE_FPS_NATIVE_GPU!=='1'||env.COVE_DISABLE_NATIVE_GPU_CAPTURE==='1'||
      env.COVE_FPS_LOCAL_PREVIEW!=='1'||env.COVE_FPS_PEER_RENDER_MODE!=='hidden'||
      env.COVE_FPS_PRODUCT_SENDER_THROTTLING!=='1'||
      env.COVE_NATIVE_GPU_CAPTURE_TIMING!=='1'||
      (env.COVE_FPS_NATIVE_STORAGE??'gpu')!=='gpu'||(env.COVE_FPS_NATIVE_PIXEL_FORMAT??'bgra')!=='bgra'||
      (env.COVE_FPS_NATIVE_FRAME_SINK??'generator')!=='generator')
      throw Error('Demand comparison requires one ordinary product-throttled native GPU BGRA publisher with local preview');
    for(const name of ['COVE_FPS_MINIMIZE_SENDER','COVE_FPS_NATIVE_LIFECYCLE_CHECKS','COVE_FPS_RECOVERY_CHECKS',
      'COVE_FPS_REPUBLISH_CHECKS','COVE_FPS_CONTENT_TRACE','COVE_FPS_GENERATED_NV12','COVE_FPS_DISABLE_RENDERER_BACKGROUNDING',
      'COVE_FPS_VISIBLE_PRESENTATION']){
      if(env[name]!==undefined&&!['0','1'].includes(env[name]))throw Error('Invalid demand comparison control '+name);
      if(env[name]==='1')throw Error('Demand comparison conflicts with '+name);
    }
    let cases;try{cases=JSON.parse(env.COVE_FPS_CASES??'null');}catch{throw Error('Demand comparison requires one explicit case');}
    validatePerformanceCases(cases);
    if(!Array.isArray(cases)||cases.length!==1||cases[0].source!=='native'||cases[0].captureTarget!=='screen'||
      cases[0].fps!==120||cases[0].game!==true||cases[0].nativeResolution===true||cases[0].nativeWindowPath===true)
      throw Error('Demand comparison requires one native monitor preset 120 fps game-mode case');
  }
  return {...PLAN,enabled};
}

function configurationKey(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw error('invalid_snapshot');
  const keys=Object.keys(value).sort();
  if(!keys.length||keys.length>20||keys.some(key=>!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)))throw error('invalid_snapshot');
  const pairs=keys.map(key=>[key,value[key]]);
  if(pairs.some(([,item])=>item!==null&&typeof item!=='boolean'&&
    !(typeof item==='number'&&Number.isFinite(item))&&!(typeof item==='string'&&item.length<=128)))throw error('invalid_snapshot');
  return JSON.stringify(pairs);
}

/** Host-only identity fields are compared in memory, never included in returned evidence. */
function validateDemandSnapshot(value,baseline){
  if(value?.ownedTestRoom!==true)throw error('not_owned');
  const sample=value.sample,broker=sample?.nativeGpu,preview=sample?.sender?.localPreview;
  const capture=sample?.sender?.nativeCaptureCounters,helper=sample?.nativeHelperTiming;
  if(!token(value.roomToken)||!token(value.producerId)||!integer(value.trackToken,1)||!integer(value.nativeRequests,1)||
    typeof value.producerPaused!=='boolean'||typeof value.viewerWatching!=='boolean'||!integer(value.viewerCount)||
    !Number.isFinite(sample?.at)||!integer(broker?.started,1)||broker.activeSessions!==1||broker.helpers!==1||
    broker.sessions!==1||preview?.requested!==true||preview.mounted!==true||preview.streamMatchesLocalScreen!==true||
    preview.matchesLiveSenderTrack!==true||preview.trackState!=='live'||!integer(preview.readyState,2)||preview.readyState>4||preview.paused!==false||
    !integer(preview.bindingToken,1)||!Number.isFinite(preview.timestamp)||!integer(preview.totalVideoFrames)||
    !integer(preview.droppedVideoFrames)||preview.totalVideoFrames<preview.droppedVideoFrames||
    capture?.backend!=='native-gpu'||capture.frameSink!=='generator'||capture.frameStorage!=='gpu'||capture.pixelFormat!=='bgra'||
    !integer(capture.framesReceived)||!integer(capture.framesWritten)||!integer(capture.refreshFrames)||
    !integer(helper?.helperIndex,1)||helper.mode!=='gpu'||!integer(helper.elapsedUs)||!integer(helper.periodUs,1)||
    !integer(helper.newFrames))throw error('invalid_snapshot');
  const source=configurationKey(value.sourceConfig);
  if(baseline){
    if(value.roomToken!==baseline.roomToken||value.producerId!==baseline.producerId||value.trackToken!==baseline.trackToken)
      throw error('publication_changed');
    if(broker.started!==baseline.helperStarted||helper.helperIndex!==baseline.helperIndex||value.nativeRequests!==baseline.nativeRequests)throw error('native_replaced');
    if(source!==baseline.source)throw error('source_changed');
    if(preview.bindingToken!==baseline.previewBinding)throw error('preview_changed');
  }
  return {roomToken:value.roomToken,producerId:value.producerId,trackToken:value.trackToken,
    nativeRequests:value.nativeRequests,helperStarted:broker.started,helperIndex:helper.helperIndex,source,previewBinding:preview.bindingToken};
}

function demandMatches(snapshot,active){
  return snapshot.producerPaused===!active&&snapshot.viewerWatching===active&&
    (active?snapshot.viewerCount===1:snapshot.viewerCount===0);
}

/**
 * Adapter contract:
 * getSnapshot() -> {ownedTestRoom,roomToken,producerId,trackToken,nativeRequests,sourceConfig,
 *   producerPaused,viewerWatching,viewerCount,sample:{at,sender,viewer,nativeGpu,nativeHelperTiming,...}}.
 * sample is the existing sanitized performance sample; summarizeSamples reuses its current utility.
 * wait(predicate,label,limitMs) polls a predicate; delay(ms) uses the host's usual bounded delay.
 * watch(producerId,{signal}) MUST recheck the owned test room/current publication in the renderer
 * immediately before invoking the existing watchScreen entry. No acquisition/replacement callback exists.
 * Cancellation does not dispatch another watch; finally restores only an unchanged owned publication.
 */
async function runDemandComparison(adapter){
  for(const key of ['getSnapshot','stopWatching','watch','wait','delay','summarizeSamples'])
    if(typeof adapter?.[key]!=='function')throw Error('Demand comparison requires callback '+key);
  if(adapter.now!==undefined&&typeof adapter.now!=='function')throw Error('Invalid demand comparison clock');
  if(adapter.signal!==undefined&&!(adapter.signal instanceof AbortSignal))throw Error('Invalid demand comparison signal');
  const now=adapter.now??Date.now,signal=adapter.signal;
  const start=now();
  if(!Number.isFinite(start))throw Error('Invalid demand comparison clock');
  const deadline=start+PLAN.maximumMs;
  const result={passed:false,plan:{...PLAN},phases:[],error:null,restoration:'not_needed',
    meaning:'Controlled watching demand on one unchanged native publication and local preview; renderer/helper clocks remain independent. Paused RTP zero is expected. Not physical presentation or a long-call result.'};
  let baseline,restoreNeeded=false,watchRequested=false;
  const check=()=>{if(signal?.aborted)throw error('cancelled');if(!Number.isFinite(now())||now()>=deadline)throw error('deadline');};
  const bounded=(action,cleanupDeadline)=>new Promise((resolve,reject)=>{
    let budget;
    try{if(cleanupDeadline===undefined)check();budget=(cleanupDeadline??deadline)-now();if(!(budget>0))throw error('deadline');}
    catch(cause){reject(cause);return;}
    let settled=false;
    const settle=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);fn(value);};
    const cancel=()=>settle(reject,error('cancelled'));
    const timer=setTimeout(()=>settle(reject,error('deadline')),budget);
    if(cleanupDeadline===undefined)signal?.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>{
      if(signal?.aborted)throw error('cancelled');
      if(now()>=(cleanupDeadline??deadline))throw error('deadline');
      return action();
    }).then(value=>settle(resolve,value),cause=>settle(reject,cause));
  });
  const snapshot=async(cleanupDeadline)=>{
    const value=await bounded(()=>adapter.getSnapshot(),cleanupDeadline);
    validateDemandSnapshot(value,baseline);
    return value;
  };
  const settleState=async active=>{
    await bounded(()=>adapter.wait(async()=>demandMatches(await snapshot(),active),
      active?'demand-active':'demand-idle',Math.min(8000,deadline-now())));
    if(!demandMatches(await snapshot(),active))throw error('demand_not_settled');
  };
  const phase=async(name,active,seconds)=>{
    await settleState(active);
    await bounded(()=>adapter.delay(PLAN.warmupMs));
    const item={name,active,warmupMs:PLAN.warmupMs,seconds,samples:[],summary:null};
    result.phases.push(item);
    for(let index=0;index<=seconds;index++){
      if(index)await bounded(()=>adapter.delay(PLAN.intervalMs));
      const value=await snapshot();
      if(!demandMatches(value,active))throw error('demand_not_settled');
      const previous=item.samples.at(-1),current=value.sample;
      if(previous&&(
        current.at<=previous.at||
        ['framesReceived','framesWritten','refreshFrames'].some(key=>current.sender.nativeCaptureCounters[key]<previous.sender.nativeCaptureCounters[key])||
        ['elapsedUs','newFrames'].some(key=>current.nativeHelperTiming[key]<previous.nativeHelperTiming[key])||
        current.sender.localPreview.timestamp<=previous.sender.localPreview.timestamp||
        ['totalVideoFrames','droppedVideoFrames'].some(key=>current.sender.localPreview[key]<previous.sender.localPreview[key])
      ))throw error('counter_reset');
      item.samples.push(value.sample);
    }
    item.summary=await bounded(()=>adapter.summarizeSamples(item.samples));
    item.samePublication=true;item.sameNativeTrack=true;item.sameNativeHelper=true;item.sameSourceConfiguration=true;
    item.localPreviewContinuous=true;item.producerPaused=!active;
  };
  try{
    const initial=await snapshot();baseline=validateDemandSnapshot(initial);
    if(!demandMatches(initial,true))throw error('demand_not_settled');
    await phase('active-before',true,PLAN.activeSeconds);
    check();await snapshot();restoreNeeded=true;
    await bounded(()=>adapter.stopWatching({signal}));
    await phase('idle',false,PLAN.idleSeconds);
    check();await snapshot();check();
    watchRequested=true;
    await bounded(()=>adapter.watch(baseline.producerId,{signal}));
    await phase('active-after',true,PLAN.activeSeconds);
    result.passed=true;
  }catch(cause){result.error=safeError(cause);}
  finally{
    if(restoreNeeded&&baseline){
      if(signal?.aborted)result.restoration='skipped_cancelled';
      else{
        const cleanupDeadline=now()+PLAN.cleanupMs;
        try{
          const current=await snapshot(cleanupDeadline);
          if(signal?.aborted)result.restoration='skipped_cancelled';
          else if(current.viewerWatching)result.restoration='already_watching';
          // A timed-out host watch may already have been dispatched to its renderer.
          // Do not send a competing second command while that outcome is uncertain.
          else if(watchRequested)result.restoration='watch_request_already_issued';
          else{
            await bounded(()=>{
              if(signal?.aborted)throw error('cancelled');
              return adapter.watch(baseline.producerId,{signal});
            },cleanupDeadline);
            result.restoration='watch_requested';
          }
        }catch(cause){
          const code=safeError(cause);
          if(['not_owned','publication_changed','native_replaced','source_changed','preview_changed','invalid_snapshot'].includes(code))
            result.restoration='skipped_not_current';
          else if(code==='cancelled')result.restoration='skipped_cancelled';
          else{result.restoration='failed';result.error??=code;result.passed=false;}
        }
      }
    }
    result.elapsedMs=Math.max(0,now()-start);
  }
  return result;
}

module.exports={performanceDemandOptions,validateDemandSnapshot,runDemandComparison};
