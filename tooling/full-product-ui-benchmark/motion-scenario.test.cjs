'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {configure}=require('./run.cjs');
const {motionOptions,fixtureBounds,summarizeMotionPhases,createMotionScenario,motionSourceHtml}=require('./motion-scenario.cjs');
const {nativeHelperTimingSnapshot,nativeHelperTimingSummary,nativeBrokerSnapshot,nativeResourcesReleased}=require('../screen-performance-native.cjs');
const adapters=require('./source-adapters.cjs');
const geometry={senderBounds:{x:213,y:133,width:1280,height:800},workArea:{x:0,y:0,width:1707,height:1027},shadowDip:16,
  probeRects:[{x:80,y:60,width:3,height:3},{x:1600,y:988,width:3,height:3}]};

test('motion scenario fixes real stats/muted policy and bounded duration while ordinary runs retain limits',()=>{
  const env={COVE_FULL_UI_MOTION_SWITCH:'1'};configure(env);
  assert.equal(env.COVE_FULL_UI_STATS,'1');assert.equal(env.COVE_FPS_SAMPLE_SECONDS,'192');
  assert.equal(env.COVE_FPS_PRODUCT_SENDER_THROTTLING,'1');assert.equal(JSON.parse(env.COVE_FPS_CASES)[0].expectCodec,'video/AV1');
  for(const change of [{COVE_FULL_UI_STATS:'0'},{COVE_FULL_UI_VOICE:'synthetic-varying'},
    {COVE_FPS_SAMPLE_SECONDS:'191'},{COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC:'1'}])
    assert.throws(()=>configure({COVE_FULL_UI_MOTION_SWITCH:'1',...change}));
  assert.throws(()=>configure({COVE_FPS_SAMPLE_SECONDS:'192'}));assert.throws(()=>motionOptions({COVE_FULL_UI_MOTION_SWITCH:'yes'}));
});

test('motion sampling never serializes the growing full result and ordinary save behavior stays unchanged',()=>{
  const adapted=adapters.electron(fs.readFileSync('apps/desktop/tests/ui/screen-performance.electron.cjs','utf8'));
  const code=adapted.match(/if\(!fullUiMotionOptions.enabled&&!lowObserverMode\)save\(mainStages.save\);/)?.[0];
  assert.ok(code);
  for(const enabled of [false,true])for(const lowObserverMode of [false,true]){
    const stage={performed:false,serializeMs:null,writeMs:null,totalMs:null};let saves=0;
    vm.runInNewContext(code,{fullUiMotionOptions:{enabled},lowObserverMode,mainStages:{save:stage},save:value=>{saves++;value.performed=true;}});
    assert.equal(saves,!enabled&&!lowObserverMode?1:0);
    assert.equal(stage.performed,!enabled&&!lowObserverMode);
  }
  const sampleLoop=adapted.slice(adapted.indexOf('      for(let n=0;n<=sampleSeconds;n++){'),adapted.indexOf('      if(fullUiMotion){fullUiMotion.finish'));
  assert.equal((sampleLoop.match(/save\(mainStages.save\)/g)??[]).length,1);
  assert.ok(adapted.includes('fullUiMotion.finish(samples,summary);save();'));
  assert.ok(adapted.includes('result.error=error.stack||String(error)'));
});

test('presentation rejection saves one bounded safe pane context before throwing the unchanged error',()=>{
  const adapted=adapters.electron(fs.readFileSync('apps/desktop/tests/ui/screen-performance.electron.cjs','utf8'));
  const code=adapted.match(/\{measured.visiblePresentation.failure\?\?=visiblePresentationFailureContext\(pane,[^\n]+?;\}/)?.[0];
  assert.ok(code);const measured={visiblePresentation:{}};let saves=0;
  const pane={requested:true,stylesState:'ready',mounted:true,overlayMounted:true,statsEnabled:true,
    hostSize:{width:0,height:800},previewSize:{width:0,height:600},overlaySize:{width:128,height:180},viewport:{width:1280,height:800},
    videoObjectFit:'contain',backdropFilter:'blur(10px)',overlayPosition:'absolute',documentVisibilityState:'visible',layout:'top-strip-v1',
    content:'private text',trackId:'private track',url:'https://private.invalid'};
  const scope={measured,pane,visiblePresentationFailureContext:adapters.visiblePresentationFailureContext,Date:{now:()=>50000},performance:{now:()=>20000},n:0,
    fullUiStats:true,nativeTimingEnabled:true,liveGpuInfo:true,nativeCompletion:'query',sampleSeconds:192,warmupMs:5000,
    fullUiMotionOptions:{enabled:true},fullUiKeepCaptureActive:false,fullUiMotion:{sample:()=>({index:0,name:'motion-visible',requestedOccluded:false,privateId:'private'})},save:()=>{saves++;}};
  for(let attempt=0;attempt<2;attempt++)assert.throws(()=>vm.runInNewContext(code,scope),/Visible product video\/CSS\/real diagnostic presentation contract was not established/);
  assert.equal(saves,2);const failure=measured.visiblePresentation.failure;
  assert.equal(failure.pane.hostSize.width,0);assert.equal(failure.pane.backdropFilter,'blur(10px)');assert.equal(failure.fullUiStats,true);
  assert.equal(failure.timing.liveGpuInfo,true);assert.equal(failure.motion.phase,'motion-visible');assert.equal(failure.sampleIndex,0);
  assert.equal(JSON.stringify(failure).includes('private'),false);
  const invalid=adapters.visiblePresentationFailureContext({...pane,backdropFilter:'url(https://private.invalid)',hostSize:{width:Infinity,height:800}},{});
  assert.equal(invalid.pane.backdropFilter,'other');assert.equal(invalid.pane.hostSize,null);
});

test('capture activity candidate is explicit, motion-only and keeps fixed media and fixture policies',()=>{
  for(const value of ['',true,1,'true','yes'])assert.throws(()=>configure({COVE_FULL_UI_MOTION_SWITCH:'1',COVE_FULL_UI_KEEP_CAPTURE_ACTIVE:value}));
  assert.throws(()=>configure({COVE_FULL_UI_KEEP_CAPTURE_ACTIVE:'1'}),/requires the motion/);
  const baseline={COVE_FULL_UI_MOTION_SWITCH:'1'},candidate={...baseline,COVE_FULL_UI_KEEP_CAPTURE_ACTIVE:'1'};
  configure(baseline);configure(candidate);assert.equal(baseline.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE,'0');
  assert.equal(candidate.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE,'1');
  for(const key of ['COVE_FPS_CASES','COVE_FPS_PRODUCT_SENDER_THROTTLING','COVE_FULL_UI_STATS','COVE_FULL_UI_VOICE','COVE_FPS_SAMPLE_SECONDS'])
    assert.equal(candidate[key],baseline[key],key);
  const adapted=adapters.electron(fs.readFileSync('apps/desktop/tests/ui/screen-performance.electron.cjs','utf8'));
  assert.match(adapted,/keepRendererActive:fullUiKeepCaptureActive/);
  assert.match(adapted,/expectedPublisherBackgroundThrottling:fullUiExpectedPublisherThrottling\(\)/);
  assert.match(adapted,/nativeGpu.rendererActivityLeases!==1/);
  assert.match(adapted,/rendererActivityAfterProductStop=\{leases:afterProductCleanup.rendererActivityLeases\?\?null,backgroundThrottling:peers\[0\]/);
  assert.match(adapted,/!fullUiKeepCaptureActive\|\|nativeGpu.rendererActivity.restored/);
  const launcher=adapters.launcher(fs.readFileSync('tooling/verify-screen-performance.cjs','utf8'));
  assert.match(launcher,/captureActivityPolicy:\{requested:process.env.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE==='1'/);
});

test('safe broker activity evidence accepts only typed fields and unreleased leases fail cleanup',()=>{
  const zero={sessions:0,activeSessions:0,helpers:0,imports:0,pendingReferences:0,childHandles:0,busySlots:0};
  const safe=nativeBrokerSnapshot({snapshot:()=>({...zero,keepRendererActive:true,rendererActivityLeases:1,untrusted:'private'})});
  assert.equal(safe.keepRendererActive,true);assert.equal(safe.rendererActivityLeases,1);assert.equal(safe.untrusted,undefined);
  assert.equal(nativeResourcesReleased(safe),false);
  assert.equal(nativeResourcesReleased({...safe,rendererActivityLeases:0}),true);
  for(const value of [-1,NaN,Infinity,1.5,'1',true]){
    const invalid=nativeBrokerSnapshot({snapshot:()=>({keepRendererActive:value,rendererActivityLeases:value})});
    assert.equal(invalid.rendererActivityLeases,undefined);
    assert.equal(invalid.keepRendererActive,typeof value==='boolean'?value:undefined);
  }
});

test('owned source is moved above older windows once before publisher focus and startup qualification',()=>{
  const adapted=adapters.electron(fs.readFileSync('apps/desktop/tests/ui/screen-performance.electron.cjs','utf8'));
  const move=adapted.indexOf('if(fullUiMotionOptions.enabled)sourceWindow.moveTop();');
  const focus=adapted.indexOf('sender.setBounds(presentationGeometry.senderBounds);sender.show();sender.focus();',move);
  const qualify=adapted.indexOf('waitVisiblePresentationStartup(',focus);
  assert.ok(move>0&&focus>move&&qualify>focus);
  assert.ok(adapted.includes('sourceWindow.setAlwaysOnTop(!visiblePresentation.enabled'));
});

test('phase summaries retain transition lows and only select exact-time pure final snapshots',()=>{
  const samples=Array.from({length:48},(_,n)=>({at:n*1000,motionPhase:{index:0},sender:{fullProductUi:{motionStability:{sampledAt:n*1000,
    nativeDelivery:{status:'ready',lowFps:n<32?5:100,observedMs:30000,lastFrameAgeMs:0},presentation:n<32?{status:'incomplete',lowFps:null}:null}}}}));
  const [phase]=summarizeMotionPhases([{at:0,completedAt:0,index:0}],samples,values=>({count:values.length}),48000);
  assert.equal(phase.includingTransition.nativeDeliveryLow.minimum,5);
  assert.equal(phase.phasePure.nativeDeliveryLow.minimum,100);assert.equal(phase.phasePure.sampleCount,15);
  assert.equal(phase.phasePure.sampleTimes[0],33000);assert.equal(phase.phasePure.previewLow.minimum,null);
  assert.deepEqual(phase.phasePure.previewLow.statuses,{unavailable:15});
  assert.equal(phase.phasePure.nativeDeliveryLow.phaseHistory.allVerified,true);
  assert.equal(phase.phasePure.previewLow.phaseHistory.unknown,15);
  for(const sample of samples)sample.sender.fullProductUi.motionStability.nativeDelivery.observedMs=60000;
  const [crossing]=summarizeMotionPhases([{at:0,completedAt:0,index:0}],samples,()=>({}),48000);
  assert.equal(crossing.phasePure.nativeDeliveryLow.minimum,null);
  assert.equal(crossing.phasePure.nativeDeliveryLow.phaseHistory.crossesPhaseBoundary,15);
});

test('owned motion canvas advances genuine draw sequence and paints guards after broad moving content',()=>{
  const calls=[],context={fillRect(...rect){calls.push({color:this.fillStyle,rect});},fillText(){}};
  const canvas={getContext:()=>context},queued=[];
  const html=motionSourceHtml({patternBits:{top:.03,height:.06}}),script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const scope={window:{},document:{querySelector:()=>canvas},requestAnimationFrame:callback=>queued.push(callback)};
  vm.runInNewContext(script,scope);queued.shift()(0);const first=calls[0].rect;calls.length=0;queued.shift()(100);
  assert.equal(scope.window.sourceFrames,2);assert.notDeepEqual(calls[0].rect,first);
  assert.ok(calls.length>250);assert.equal(calls.at(-20).color,'#e84a5f');
  assert.deepEqual(calls.at(-1).rect,[1464,32.4,72,64.8]);
});

test('scenario only focuses its two fixtures, preserves policy, detects foreign focus and tears down timers',async()=>{
  let focused=null,time=0;const timers=new Map(),created=[];
  class FakeWindow{
    constructor(options={}){this.bounds={...options};this.visible=!!options.show;this.dead=false;this.handlers={};
      this.webContents={setWindowOpenHandler(){},on:(name,fn)=>{this.handlers[name]=fn;},isOffscreen:()=>false,getBackgroundThrottling:()=>true};created.push(this);}
    getBounds(){return {...this.bounds};}setBounds(bounds){this.bounds={...bounds};}isDestroyed(){return this.dead;}
    isVisible(){return this.visible;}isMinimized(){return false;}isFocused(){return focused===this;}
    show(){this.visible=true;}showInactive(){this.visible=true;}hide(){this.visible=false;}moveTop(){}focus(){focused=this;}
    async loadURL(){}destroy(){this.dead=true;this.visible=false;}
  }
  const sender=new FakeWindow({show:true}),sourceWindow=new FakeWindow({show:true});sender.focus();const result={};
  const scenario=await createMotionScenario({BrowserWindow:FakeWindow,geometry,sender,sourceWindow,result,now:()=>time,
    setTimer:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
  await scenario.beforeSample(0);time=48000;await scenario.beforeSample(48);
  const visible=()=>({sender:{focused:sender.isFocused()}});
  assert.equal(scenario.qualify(visible(),(_g,state)=>state.sender.focused),true);
  assert.notEqual(focused,sender);assert.equal(timers.size,1);
  [...timers.values()][0]();await scenario.beforeSample(49);assert.equal(scenario.state.focusEvents.length,2);
  time=96000;await scenario.beforeSample(96);assert.deepEqual(created[2].getBounds(),geometry.senderBounds);
  focused={external:true};assert.throws(()=>scenario.qualify(visible(),()=>true),/focus was lost/);
  const before=scenario.state.focusEvents.length;[...timers.values()][0]();await assert.rejects(scenario.beforeSample(97),/focus was lost/);
  assert.equal(scenario.state.focusEvents.length,before);scenario.dispose();scenario.dispose();
  assert.equal(timers.size,0);assert.equal(scenario.state.windowsDestroyed,true);assert.equal(sender.dead,false);
});

test('extended helper histories require an explicit bounded cap and still reject rollback',()=>{
  const record={sessionIndex:1,schemaVersion:1,elapsedUs:1000000,newFrames:120,refreshFrames:0,ticks:120,missedTicks:0,noSlot:0,noPresent:0,periodUs:8333};
  assert.equal(nativeHelperTimingSnapshot(Array(121).fill(record),1,'gpu'),null);
  assert.equal(nativeHelperTimingSnapshot(Array(121).fill(record),1,'gpu',360).newFrames,120);
  assert.equal(nativeHelperTimingSnapshot([record],1,'gpu',361),null);
  const a=nativeHelperTimingSnapshot([record],1,'gpu'),b={...a,elapsedUs:2000000,newFrames:240,ticks:240};
  const samples=[...Array(192).fill(a),b];assert.equal(nativeHelperTimingSummary(samples),null);
  assert.equal(nativeHelperTimingSummary(samples,193).uniqueCaptureFps,120);
  assert.equal(nativeHelperTimingSummary(samples,361),null);
  assert.equal(nativeHelperTimingSummary([a,{...a,newFrames:1},b],193),null);
});
