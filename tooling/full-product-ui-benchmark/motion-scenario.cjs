'use strict';

const PHASE_SECONDS=48;
const PHASES=Object.freeze([
  {name:'motion-visible',switching:false,occluded:false},
  {name:'motion-visible-switches',switching:true,occluded:false},
  {name:'motion-occluded-switches',switching:true,occluded:true},
  {name:'motion-visible-restored',switching:false,occluded:false},
]);
function motionOptions(env=process.env){
  const value=env.COVE_FULL_UI_MOTION_SWITCH??'0';
  if(!['0','1'].includes(value))throw Error('Invalid full App motion/switch control');
  const active=env.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE??'0';
  if(!['0','1'].includes(active))throw Error('Invalid full App capture activity control');
  if(active==='1'&&value!=='1')throw Error('Capture activity control requires the motion/switch scenario');
  return {enabled:value==='1',keepCaptureActive:active==='1',phaseSeconds:PHASE_SECONDS,sampleSeconds:PHASE_SECONDS*PHASES.length,
    switchIntervalMs:3000,phases:PHASES.map(phase=>({...phase}))};
}
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const near=(a,b)=>a&&b&&['x','y','width','height'].every(key=>Math.abs(a[key]-b[key])<=2);
function fixtureBounds(geometry,occluded,index){
  if(occluded)return {...geometry.senderBounds};
  const {senderBounds:sender,workArea:work,shadowDip:shadow}=geometry;
  const width=120,height=48,gap=24,y=sender.y+sender.height+shadow+4;
  const bounds={x:Math.round(sender.x+sender.width/2+(index===0?-width-gap/2:gap/2)),y,width,height};
  if(bounds.x<work.x||y<work.y||bounds.x+width>work.x+work.width||y+height>work.y+work.height||
      geometry.probeRects.some(probe=>overlaps(bounds,probe)))
    throw Error('Owned focus fixtures cannot fit outside publisher and marker probes');
  return bounds;
}
function lowSummary(samples,key,phaseStartedAt=null){
  const snapshots=samples.map(sample=>sample.sender.fullProductUi?.motionStability?.[key]??null);
  const statuses={};for(const snapshot of snapshots){const status=snapshot?.status??'unavailable';statuses[status]=(statuses[status]??0)+1;}
  const validity=phaseStartedAt===null?null:snapshots.map((snapshot,index)=>{
    const sampledAt=samples[index].sender.fullProductUi?.motionStability?.sampledAt;
    if(!snapshot||!Number.isFinite(snapshot.observedMs)||snapshot.observedMs<0||!Number.isFinite(snapshot.lastFrameAgeMs)||snapshot.lastFrameAgeMs<0||!Number.isFinite(sampledAt))return 'unknown';
    return snapshot.observedMs+snapshot.lastFrameAgeMs<=sampledAt-phaseStartedAt-2?'verified':'crosses-phase-boundary';
  });
  const ready=snapshots.filter((snapshot,index)=>snapshot?.status==='ready'&&Number.isFinite(snapshot.lowFps)&&
    (validity===null||validity[index]==='verified')).map(snapshot=>snapshot.lowFps).sort((a,b)=>a-b);
  return {sampleCount:snapshots.length,statuses,readySamples:ready.length,minimum:ready[0]??null,
    median:ready.length?ready[Math.floor(ready.length/2)]:null,maximum:ready.at(-1)??null,
    phaseHistory:validity===null?null:{clockMarginMs:2,verified:validity.filter(value=>value==='verified').length,
      unknown:validity.filter(value=>value==='unknown').length,crossesPhaseBoundary:validity.filter(value=>value==='crosses-phase-boundary').length,
      allVerified:validity.length>0&&validity.every(value=>value==='verified')},
    meaning:'Descriptive statistics of overlapping rolling 30-second LOW snapshots, not independent frame percentiles. Phase-pure numeric LOW additionally requires observedMs plus lastFrameAgeMs to fit the phase age with a 2ms clock margin; unknown/crossing histories are withheld. Unavailable/incomplete/stalled values are preserved, never scored as zero.'};
}
function summarizeMotionPhases(markers,samples,summarize,endedAt){
  return markers.map((marker,index)=>{
    const end=markers[index+1]?.at??endedAt;
    const selected=samples.filter(sample=>sample.motionPhase?.index===index);
    // The window retains intervals by their endpoint; 32 seconds also leaves
    // two seconds for boundary intervals. No history is reset at a transition.
    const pure=selected.filter(sample=>sample.sender.fullProductUi?.motionStability?.sampledAt>=marker.completedAt+32000).slice(-15);
    const summarizeSet=(values,pure=false)=>({sampleCount:values.length,sampleTimes:values.map(sample=>sample.at),
      throughput:values.length>=2?summarize(values):null,nativeDeliveryLow:lowSummary(values,'nativeDelivery',pure?marker.completedAt:null),
      previewLow:lowSummary(values,'presentation',pure?marker.completedAt:null)});
    return {...marker,endedAt:end,durationMs:end-marker.at,includingTransition:summarizeSet(selected),
      phasePure:summarizeSet(pure,true),phasePureComplete:pure.length===15};
  });
}
async function createMotionScenario({BrowserWindow,geometry,sender,sourceWindow,result,now=Date.now,
  setTimer=setInterval,clearTimer=clearInterval,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onAbort=()=>{},keepCaptureActive=false}){
  const options=motionOptions({COVE_FULL_UI_MOTION_SWITCH:'1',COVE_FULL_UI_KEEP_CAPTURE_ACTIVE:keepCaptureActive?'1':'0'}),windows=[];
  let phaseIndex=-1,focusedFixture=null,timer=null,disposed=false,cancelled=false,timerError=null,settling=null;
  const state={enabled:true,...options,markers:[],focusEvents:[],phaseReports:[],disposed:false,
    sourceMeaning:'Deterministic moving full-background canvas. rAF counts draws submitted by this renderer, not distinct DXGI source presents or physical scan-out. Publisher and fixture coverage obscure part of that background.',
    occlusionMeaning:'Requested opaque owned fixture bounds cover the publisher surface; actual OS occlusion is inferred from owned stacking/focus and geometry. Actual document visibility is recorded independently and need not become hidden.',
    lowMeaning:'Transitions remain in continuous original LOW history and includingTransition results. phasePure selects the last 15 exact-time snapshots at least 32 seconds after transition completion; numeric LOW also requires verified observedMs+lastFrameAgeMs within phase age. phasePureComplete counts selected snapshots, while each metric phaseHistory reports actual boundary validity.',
    sameCaptureProducer:true};
  result.motionScenario=state;
  const windowState=win=>({bounds:win.getBounds(),visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused(),
    offscreen:win.webContents.isOffscreen(),backgroundThrottling:win.webContents.getBackgroundThrottling()});
  const current=()=>phaseIndex>=0?PHASES[phaseIndex]:null;
  function checkFocus(){
    const expected=focusedFixture===null?sender:windows[focusedFixture];
    if(!expected||expected.isDestroyed()||!expected.isFocused())throw Error('Owned motion/switch focus was lost');
  }
  async function acknowledgeFocus(win){
    const deadline=now()+2000;
    while(!win.isFocused()&&now()<deadline&&!disposed)await wait(50);
    if(disposed||!win.isFocused())throw Error('Owned motion/switch focus did not settle within 2 seconds');
  }
  async function focusFixture(index,reason){
    checkFocus();
    const requestedAt=now(),win=windows[index];
    win.show();win.moveTop();win.focus();focusedFixture=index;
    await acknowledgeFocus(win);
    state.focusEvents.push({at:requestedAt,completedAt:now(),phase:phaseIndex,fixture:index,reason});
    if(state.focusEvents.length>128)throw Error('Owned motion/switch event budget exceeded');
    if(!settling)checkFocus();
  }
  function stopTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
  function assertWindowState(visible){
    if(cancelled||timerError)throw timerError??Error('Owned motion/switch cancelled by Escape');
    if(disposed)throw Error('Owned motion/switch was disposed during measurement');
    if(!settling)checkFocus();
    if(phaseIndex<0)return;
    const phase=current();
    if(!visible||(!settling&&visible.sender?.focused!==(focusedFixture===null)))throw Error('Owned publisher focus phase changed');
    for(const [index,win] of windows.entries()){
      const snapshot=windowState(win),expected=fixtureBounds(geometry,phase.occluded,index);
      if(snapshot.visible!==phase.switching||snapshot.minimized||snapshot.offscreen||!snapshot.backgroundThrottling||
          (phase.switching&&!near(snapshot.bounds,expected)))throw Error('Owned focus/occlusion fixture geometry or policy changed');
    }
  }
  try{
    for(let index=0;index<2;index++){
      const win=new BrowserWindow({...fixtureBounds(geometry,false,index),frame:false,show:false,skipTaskbar:true,
        title:'Cove owned focus fixture '+index,webPreferences:{backgroundThrottling:true,contextIsolation:true,sandbox:true,nodeIntegration:false}});
      windows.push(win);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.webContents.on('will-navigate',event=>event.preventDefault());
      win.webContents.on('before-input-event',(event,input)=>{event.preventDefault();if(input.type==='keyDown'&&input.key==='Escape'){cancelled=true;onAbort();}});
      win.webContents.on('before-mouse-event',event=>event.preventDefault());
      await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:'+(index?'#394d63':'#536a47')+';color:white;font:18px sans-serif;display:grid;place-items:center;overflow:hidden}</style><body>Owned focus fixture '+index+'</body>'));
    }
  }catch(error){for(const win of windows)if(!win.isDestroyed())win.destroy();throw error;}
  return {
    state,
    async beforeSample(sampleIndex){
      if(settling)await settling;
      const next=Math.min(PHASES.length-1,Math.floor(sampleIndex/PHASE_SECONDS));
      if(next!==phaseIndex){
        checkFocus();stopTimer();const at=now();phaseIndex=next;const phase=current();
        if(phase.switching){
          for(const [index,win] of windows.entries()){win.setBounds(fixtureBounds(geometry,phase.occluded,index));win.showInactive();}
          await focusFixture(0,'phase-start');
          timer=setTimer(()=>{
            if(settling||disposed)return;
            settling=focusFixture(focusedFixture===0?1:0,'scheduled-switch')
              .catch(error=>{timerError=error;stopTimer();}).finally(()=>{settling=null;});
          },options.switchIntervalMs);
        }else{
          for(const win of windows){win.hide();win.setBounds(fixtureBounds(geometry,false,windows.indexOf(win)));}
          sender.show();sender.moveTop();sender.focus();focusedFixture=null;await acknowledgeFocus(sender);checkFocus();
        }
        state.markers.push({index:next,name:phase.name,at,completedAt:now(),sampleIndex,
          requestedOccluded:phase.occluded,switching:phase.switching,sourceWindow:windowState(sourceWindow),publisher:windowState(sender),
          fixtures:windows.map(windowState)});
      }
      if(cancelled||timerError)throw timerError??Error('Owned motion/switch cancelled by Escape');
    },
    qualify(visible,qualifyOriginal,expectedPublisherBackgroundThrottling=true){
      assertWindowState(visible);
      // Only publisher focus is phase-dependent; all original display/source,
      // exposed-probe geometry and product throttling requirements still apply.
      return qualifyOriginal(geometry,{...visible,sender:{...visible.sender,focused:true}},{expectedPublisherBackgroundThrottling});
    },
    sample(){return {index:phaseIndex,name:current()?.name??null,at:now(),requestedOccluded:current()?.occluded??false,
      fixtures:windows.map(windowState)};},
    finish(samples,summarize){stopTimer();state.endedAt=now();state.phaseReports=summarizeMotionPhases(state.markers,samples,summarize,state.endedAt);
      if(state.phaseReports.length!==PHASES.length||!state.phaseReports.every(phase=>phase.durationMs>=45000&&phase.phasePureComplete))
        throw Error('Motion/switch phases did not retain 15 pure 30-second LOW snapshots');},
    dispose(){if(disposed)return;disposed=true;stopTimer();for(const win of windows)if(!win.isDestroyed())win.destroy();
      state.disposed=true;state.timerCleared=timer===null;state.windowsDestroyed=windows.every(win=>win.isDestroyed());},
  };
}
function motionSourceHtml({sourceAgeSetup='',sourceAgeDraw='',patternBits}){
  return `<!doctype html><style>body{margin:0;overflow:hidden;background:#17324d}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script>const c=document.querySelector('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d',{alpha:false});let frames=0;${sourceAgeSetup}function draw(t){frames++;${sourceAgeDraw}const shift=(t*.8)%96;for(let row=-1;row<12;row++)for(let col=-1;col<21;col++){const phase=(col*19+row*31+Math.floor(t/80))%360;x.fillStyle='hsl('+phase+' 85% '+((row+col)%2?40:65)+'%)';x.fillRect(col*96+shift,row*96+shift,97,97)}x.fillStyle='white';x.font='72px sans-serif';x.fillText(String(frames),240,160);for(const [color,a,b] of [['#e84a5f',0,0],['#41b3a3',1728,0],['#e8d0a9',0,972],['#4b2e83',1728,972]]){x.fillStyle=color;x.fillRect(a,b,192,108)}for(let bit=0;bit<16;bit++){x.fillStyle=frames&(1<<bit)?'#fff':'#000';x.fillRect(384+bit*72,${patternBits.top*1080},72,${patternBits.height*1080})}window.sourceFrames=frames;requestAnimationFrame(draw)}requestAnimationFrame(draw)</script>`;
}
module.exports={motionOptions,fixtureBounds,lowSummary,summarizeMotionPhases,createMotionScenario,motionSourceHtml};
