'use strict';
const patternLayouts=require('../apps/desktop/tests/ui/screen-performance-pattern-layouts.json');
const {validatePerformanceCases}=require('./screen-performance-config.cjs');

function visiblePresentationOptions(env=process.env){
  const value=env.COVE_FPS_VISIBLE_PRESENTATION;
  if(value!==undefined&&!['0','1'].includes(value))throw Error('Invalid visible presentation control');
  const enabled=value==='1';
  if(enabled){
    if(env.COVE_FPS_PEER_RENDER_MODE!=='hidden'||env.COVE_FPS_PRODUCT_SENDER_THROTTLING!=='1'||
      env.COVE_FPS_NATIVE_GPU!=='1'||env.COVE_DISABLE_NATIVE_GPU_CAPTURE==='1'||
      (env.COVE_FPS_NATIVE_STORAGE??'gpu')!=='gpu'||(env.COVE_FPS_NATIVE_PIXEL_FORMAT??'bgra')!=='bgra'||
      !['generator','worker','gpu-snapshot'].includes(env.COVE_FPS_NATIVE_FRAME_SINK??'generator'))
      throw Error('Visible presentation requires an ordinary product-throttled native GPU BGRA publisher');
    for(const flag of ['COVE_FPS_MINIMIZE_SENDER','COVE_FPS_NATIVE_LIFECYCLE_CHECKS','COVE_FPS_RECOVERY_CHECKS',
      'COVE_FPS_REPUBLISH_CHECKS','COVE_FPS_CONTENT_TRACE','COVE_FPS_GENERATED_NV12','COVE_FPS_DISABLE_RENDERER_BACKGROUNDING'])
      if(env[flag]==='1')throw Error('Visible presentation conflicts with '+flag);
    let cases;try{cases=JSON.parse(env.COVE_FPS_CASES??'null');}catch{throw Error('Visible presentation requires one explicit native monitor case');}
    validatePerformanceCases(cases);
    if(!Array.isArray(cases)||cases.length!==1||cases[0]?.source!=='native'||cases[0]?.captureTarget!=='screen'||
      cases[0]?.fps!==120||cases[0]?.game!==true||cases[0]?.nativeResolution===true||cases[0]?.nativeWindowPath===true)
      throw Error('Visible presentation requires one native monitor preset 120 fps game-mode case');
  }
  return {enabled,patternLayout:enabled?'top-strip-v1':'central-v1'};
}

function visiblePresentationGeometry(displays){
  if(!Array.isArray(displays)||displays.length!==1)throw Error('Visible presentation requires exactly one display');
  const display=displays[0],bounds=display?.bounds,workArea=display?.workArea;
  const rectangle=value=>value&&['x','y','width','height'].every(key=>Number.isFinite(value[key]))&&value.width>0&&value.height>0;
  if(!rectangle(bounds)||!rectangle(workArea)||bounds.width<bounds.height||bounds.width<1000||bounds.height<700||
    !Number.isFinite(display.scaleFactor)||display.scaleFactor<=0||!Number.isFinite(display.displayFrequency)||display.displayFrequency<120)
    throw Error('Visible presentation requires a landscape high-refresh display with valid geometry');
  const width=Math.floor(bounds.width*.75),height=Math.floor(bounds.height*.75);
  const sender={x:bounds.x+Math.floor((bounds.width-width)/2),y:bounds.y+Math.floor((bounds.height-height)/2),width,height};
  const definition=patternLayouts['top-strip-v1'],bits=definition.bits;
  // Probe two physical pixels plus a conservative 16-DIP window-shadow margin.
  const pad=2/display.scaleFactor,shadow=16;
  const probes=definition.corners.concat(Array.from({length:bits.count},(_,bit)=>
    [bits.left+(bit+.5)*bits.width/bits.count,bits.sampleY])).map(([x,y])=>({
      x:bounds.x+bounds.width*x-pad,y:bounds.y+bounds.height*y-pad,width:pad*2,height:pad*2}));
  const contains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
  const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
  const shadowBounds={x:sender.x-shadow,y:sender.y-shadow,width:sender.width+shadow*2,height:sender.height+shadow*2};
  if(probes.some(probe=>!contains(bounds,probe)||!contains(workArea,probe)||overlaps(shadowBounds,probe)))
    throw Error('Visible presentation would cover an owned marker/sequence probe or taskbar-safe area');
  return {displayBounds:{...bounds},workArea:{...workArea},senderBounds:sender,shadowDip:shadow,probeRects:probes,
    scaleFactor:display.scaleFactor,displayFrequency:display.displayFrequency,patternLayout:'top-strip-v1'};
}

function qualifyVisiblePresentationState(geometry,state,{expectedPublisherBackgroundThrottling=true}={}){
  const near=(a,b)=>a&&b&&['x','y','width','height'].every(key=>Number.isFinite(a[key])&&Math.abs(a[key]-b[key])<=2);
  return Boolean(typeof expectedPublisherBackgroundThrottling==='boolean'&&
    state?.displayCount===1&&state.primaryDisplayUnchanged===true&&near(state.displayBounds,geometry.displayBounds)&&
    near(state.workArea,geometry.workArea)&&Math.abs(state.scaleFactor-geometry.scaleFactor)<.01&&
    Math.abs(state.displayFrequency-geometry.displayFrequency)<1&&state.displayFrequency>=120&&
    state.sender?.visible===true&&state.sender.minimized===false&&state.sender.focused===true&&state.sender.offscreen===false&&state.sender.backgroundThrottling===expectedPublisherBackgroundThrottling&&
    near(state.sender.bounds,geometry.senderBounds)&&state.source?.visible===true&&state.source.minimized===false&&state.source.fullscreen===true&&
    state.source.alwaysOnTop===false&&state.source.backgroundThrottling===false&&near(state.source.bounds,geometry.displayBounds)&&
    near(state.source.contentBounds,geometry.displayBounds));
}

async function waitVisiblePresentationStartup(geometry,readState,{
  now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  expectedPublisherBackgroundThrottling=true,
}={}){
  const started=now(),maximumMs=2000,intervalMs=50;
  let state=null,observations=0;
  for(;;){
    state=readState();observations++;
    const elapsedMs=now()-started;
    // show()/focus() is requested once by the caller. Only observe here: never
    // steal focus, extend the deadline or accept a late observation.
    if(elapsedMs<=maximumMs&&qualifyVisiblePresentationState(geometry,state,{expectedPublisherBackgroundThrottling}))
      return {established:true,elapsedMs,observations,state};
    if(elapsedMs>=maximumMs)return {established:false,elapsedMs,observations,state};
    await wait(Math.min(intervalMs,maximumMs-elapsedMs));
  }
}

function performanceLocalPreviewEnabled(env=process.env){
  const value=env.COVE_FPS_LOCAL_PREVIEW;
  if(value!==undefined&&!['0','1'].includes(value))throw Error('Invalid local preview control');
  return value==='1';
}

function performanceProductSenderThrottling(env=process.env){
  const value=env.COVE_FPS_PRODUCT_SENDER_THROTTLING;
  if(value!==undefined&&!['0','1'].includes(value))throw Error('Invalid product sender throttling control');
  return value==='1';
}

function publisherBackgroundThrottling({minimizeSender=false,minimizedThrottling=true,productSenderThrottling=false}={}){
  if(minimizeSender&&productSenderThrottling&&!minimizedThrottling)
    throw Error('Product sender throttling conflicts with the minimized unthrottled control');
  return minimizeSender?minimizedThrottling:productSenderThrottling;
}

function localPreviewSummary(samples){
  const previews=samples.map(sample=>sample.sender?.localPreview);
  const first=previews[0],last=previews.at(-1),requested=first?.requested===true;
  const sameBinding=requested&&previews.length>=2&&Number.isSafeInteger(first.bindingToken)&&first.bindingToken>0&&
    previews.every(value=>value?.requested===true&&value.bindingToken===first.bindingToken&&
      value.mounted&&value.streamMatchesLocalScreen&&value.matchesLiveSenderTrack&&value.trackState==='live');
  const elapsed=last?.timestamp-first?.timestamp;
  const seconds=Number.isFinite(elapsed)&&elapsed>0?elapsed/1000:null;
  const rate=key=>sameBinding&&seconds&&previews.every(value=>Number.isSafeInteger(value[key])&&value[key]>=0)&&
    previews.every((value,index)=>index===0||value[key]>=previews[index-1][key])
      ?Math.round((last[key]-first[key])/seconds*100)/100:null;
  const totalRate=rate('totalVideoFrames'),droppedRate=rate('droppedVideoFrames');
  const validNonDropped=previews.every(value=>Number.isSafeInteger(value?.totalVideoFrames)&&
    Number.isSafeInteger(value?.droppedVideoFrames)&&value.totalVideoFrames>=value.droppedVideoFrames);
  return {requested,sampleCount:previews.length,sameBinding,
    mountedAtAllSamples:previews.length>0&&previews.every(value=>value?.mounted===true),
    boundToPublishedTrackAtAllSamples:previews.length>0&&previews.every(value=>value?.streamMatchesLocalScreen&&value.matchesLiveSenderTrack),
    playingAtAllSamples:previews.length>0&&previews.every(value=>value?.readyState>=2&&value.paused===false),
    mutedAtAllSamples:previews.length>0&&previews.every(value=>value?.muted===true),
    unexpectedPreview:!requested&&previews.some(value=>value?.mounted===true),
    seconds,playbackFramesFps:totalRate,playbackDroppedFps:droppedRate,
    playbackNonDroppedFramesFps:validNonDropped&&totalRate!==null&&droppedRate!==null&&totalRate>=droppedRate
      ?Math.round((totalRate-droppedRate)*100)/100:null,
    meaning:'On-demand cumulative HTML video counters sampled in the publisher clock; totalVideoFrames includes dropped frames. The anonymous binding token guards changes of video element, stream and published track; it is not a browser track ID. A hidden/occluded publisher may present zero frames. These counters are not physical scan-out or a full visible product UI comparison.'};
}

module.exports={performanceLocalPreviewEnabled,performanceProductSenderThrottling,publisherBackgroundThrottling,localPreviewSummary,
  visiblePresentationOptions,visiblePresentationGeometry,qualifyVisiblePresentationState,waitVisiblePresentationStartup};
