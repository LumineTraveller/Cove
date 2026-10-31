'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {performanceDemandOptions,validateDemandSnapshot,runDemandComparison}=require('../tooling/screen-performance-demand.cjs');

function environment(){return {COVE_FPS_DEMAND_CHECKS:'1',COVE_FPS_NATIVE_GPU:'1',COVE_FPS_LOCAL_PREVIEW:'1',
  COVE_FPS_PEER_RENDER_MODE:'hidden',COVE_FPS_PRODUCT_SENDER_THROTTLING:'1',
  COVE_NATIVE_GPU_CAPTURE_TIMING:'1',
  COVE_FPS_CASES:JSON.stringify([{source:'native',captureTarget:'screen',preset:'1080p',fps:120,game:true,compatibility:false}])};}

test('demand control is disabled by default and accepts only its exact flag',()=>{
  assert.equal(performanceDemandOptions({}).enabled,false);
  assert.equal(performanceDemandOptions({COVE_FPS_DEMAND_CHECKS:'0'}).enabled,false);
  assert.equal(performanceDemandOptions(environment()).enabled,true);
  for(const value of ['',true,1,'true','01','private'])assert.throws(()=>performanceDemandOptions({COVE_FPS_DEMAND_CHECKS:value}));
});

test('demand control requires an ordinary native preset publisher and continuous preview',()=>{
  for(const patch of [{COVE_FPS_NATIVE_GPU:'0'},{COVE_DISABLE_NATIVE_GPU_CAPTURE:'1'},{COVE_FPS_LOCAL_PREVIEW:'0'},
    {COVE_FPS_PEER_RENDER_MODE:'offscreen'},{COVE_FPS_PRODUCT_SENDER_THROTTLING:'0'},{COVE_NATIVE_GPU_CAPTURE_TIMING:'0'},
    {COVE_FPS_NATIVE_STORAGE:'cpu'},{COVE_FPS_NATIVE_PIXEL_FORMAT:'nv12'},{COVE_FPS_NATIVE_FRAME_SINK:'canvas'},
    {COVE_FPS_MINIMIZE_SENDER:'1'},{COVE_FPS_NATIVE_LIFECYCLE_CHECKS:'1'},{COVE_FPS_RECOVERY_CHECKS:'1'},
    {COVE_FPS_REPUBLISH_CHECKS:'1'},{COVE_FPS_CONTENT_TRACE:'1'},{COVE_FPS_GENERATED_NV12:'1'},
    {COVE_FPS_DISABLE_RENDERER_BACKGROUNDING:'1'},{COVE_FPS_VISIBLE_PRESENTATION:'1'},
    {COVE_FPS_MINIMIZE_SENDER:'true'},{COVE_FPS_CASES:'not JSON'},
    {COVE_FPS_CASES:JSON.stringify([{source:'native',captureTarget:'window',preset:'1080p',fps:120,game:true}])},
    {COVE_FPS_CASES:JSON.stringify([{source:'native',captureTarget:'screen',preset:'1080p',fps:60,game:true}])}])
    assert.throws(()=>performanceDemandOptions({...environment(),...patch}));
});

function setup(){
  let now=0,watching=true,paused=false;
  const control=new AbortController(),operations=[],samples=[];
  const state={ownedTestRoom:true,roomToken:'private-room',producerId:'private-producer',trackToken:7,nativeRequests:1,
    sourceConfig:{preset:'1080p',fps:120,gameMode:true,width:1728,height:1080}};
  const broker={started:1,activeSessions:1,helpers:1,sessions:1};
  const preview={requested:true,mounted:true,streamMatchesLocalScreen:true,matchesLiveSenderTrack:true,
    trackState:'live',readyState:4,paused:false,bindingToken:3};
  let hook=()=>{};
  const adapter={signal:control.signal,now:()=>now,
    getSnapshot:async()=>{
      hook('snapshot');
      const sample={at:now,sender:{localPreview:{...preview,timestamp:now,totalVideoFrames:Math.round(now*.115),droppedVideoFrames:0},
        nativeCaptureCounters:{backend:'native-gpu',frameSink:'generator',frameStorage:'gpu',pixelFormat:'bgra',
          framesReceived:Math.round(now*.12),framesWritten:Math.round(now*.115),refreshFrames:0}},
        viewer:{currentVideo:watching?{framesDecoded:now*.11}:null},nativeGpu:{...broker},
        nativeHelperTiming:{helperIndex:1,mode:'gpu',elapsedUs:now*1000,periodUs:8333,newFrames:Math.round(now*.12)},nativeSourceFrames:now*.24};
      samples.push(sample);
      return {...state,sourceConfig:{...state.sourceConfig},producerPaused:paused,viewerWatching:watching,viewerCount:watching?1:0,sample};
    },
    delay:async ms=>{operations.push(['delay',ms]);now+=ms;hook('delay');},
    wait:async predicate=>{operations.push(['wait']);assert.equal(await predicate(),true);},
    stopWatching:async()=>{operations.push(['stop']);watching=false;paused=true;hook('stop');},
    watch:async id=>{operations.push(['watch']);assert.equal(id,state.producerId);watching=true;paused=false;hook('watch');},
    summarizeSamples:async values=>({seconds:(values.at(-1).at-values[0].at)/1000,count:values.length,
      writeFps:(values.at(-1).sender.nativeCaptureCounters.framesWritten-values[0].sender.nativeCaptureCounters.framesWritten)/
        ((values.at(-1).at-values[0].at)/1000)}),
  };
  return {adapter,state,broker,preview,operations,samples,control,setHook:value=>{hook=value;},
    advance:ms=>{now+=ms;},get watching(){return watching;},setPaused:value=>{paused=value;},setWatching:value=>{watching=value;}};
}

test('active idle active uses the same safe snapshot utility and excludes each warmup',async()=>{
  const f=setup(),r=await runDemandComparison(f.adapter);
  assert.equal(r.passed,true);assert.equal(r.error,null);assert.equal(r.elapsedMs,32000);
  assert.deepEqual(r.phases.map(p=>[p.name,p.samples.length,p.summary.seconds]),
    [['active-before',9,8],['idle',11,10],['active-after',9,8]]);
  assert.equal(r.phases.every(p=>p.localPreviewContinuous&&p.samePublication&&p.sameNativeHelper),true);
  assert.equal(r.phases[1].producerPaused,true);assert.equal(r.phases[1].samples.every(s=>s.viewer.currentVideo===null),true);
  assert.deepEqual(f.operations.filter(v=>['stop','watch'].includes(v[0])),[['stop'],['watch']]);
  assert.equal(r.restoration,'already_watching');assert.equal(f.watching,true);
  const text=JSON.stringify(r);assert.equal(text.includes('private-room'),false);assert.equal(text.includes('private-producer'),false);
  assert.equal(r.phases.every(p=>p.summary.writeFps===115),true);
});

test('the callback contract is checked before a watching action',async()=>{
  for(const key of ['getSnapshot','stopWatching','watch','wait','delay','summarizeSamples']){
    const f=setup();delete f.adapter[key];
    await assert.rejects(runDemandComparison(f.adapter));assert.equal(f.operations.length,0);
  }
  const f=setup();f.adapter.signal={aborted:false};await assert.rejects(runDemandComparison(f.adapter));
});

test('snapshot identity checks distinguish publication, native source and preview changes',async()=>{
  const f=setup(),s=await f.adapter.getSnapshot(),baseline=validateDemandSnapshot(s);
  for(const [patch,code] of [
    [{ownedTestRoom:false},'not_owned'],[{producerId:'replacement'},'publication_changed'],
    [{trackToken:8},'publication_changed'],[{roomToken:'other-room'},'publication_changed'],
    [{nativeRequests:2},'native_replaced'],[{sourceConfig:{fps:60}},'source_changed'],
    [{sample:{...s.sample,nativeGpu:{...s.sample.nativeGpu,started:2}}},'native_replaced'],
    [{sample:{...s.sample,sender:{...s.sample.sender,localPreview:{...s.sample.sender.localPreview,bindingToken:4}}}},'preview_changed'],
  ])assert.throws(()=>validateDemandSnapshot({...s,...patch},baseline),e=>e.code===code);
  for(const field of ['mounted','streamMatchesLocalScreen','matchesLiveSenderTrack']){
    const changed=structuredClone(s);changed.sample.sender.localPreview[field]=false;
    assert.throws(()=>validateDemandSnapshot(changed,baseline));
  }
});

test('missing renderer, helper or actual preview counters cannot qualify a demand sample',async()=>{
  const f=setup(),s=await f.adapter.getSnapshot();
  for(const mutate of [v=>{v.sample.sender.nativeCaptureCounters=null;},v=>{v.sample.nativeHelperTiming=null;},
    v=>{delete v.sample.sender.localPreview.readyState;},v=>{v.sample.sender.localPreview.totalVideoFrames=null;}]){
    const value=structuredClone(s);mutate(value);
    assert.throws(()=>validateDemandSnapshot(value),e=>e.code==='invalid_snapshot');
  }
});

test('a failure while idle restores only the unchanged owned publication and hides error text',async()=>{
  const f=setup();let threw=false;
  f.setHook(where=>{if(where==='delay'&&!f.watching&&!threw){threw=true;throw Error('private native details');}});
  const r=await runDemandComparison(f.adapter);
  assert.equal(r.passed,false);assert.equal(r.error,'operation_failed');assert.equal(r.restoration,'watch_requested');
  assert.equal(f.watching,true);assert.equal(JSON.stringify(r).includes('private native details'),false);
  assert.deepEqual(f.operations.filter(v=>['stop','watch'].includes(v[0])),[['stop'],['watch']]);
});

test('user cancellation while idle does not recreate watching',async()=>{
  const f=setup();f.setHook(where=>{if(where==='stop')f.control.abort();});
  const r=await runDemandComparison(f.adapter);
  assert.equal(r.passed,false);assert.equal(r.error,'cancelled');assert.equal(r.restoration,'skipped_cancelled');
  assert.equal(f.watching,false);assert.equal(f.operations.some(v=>v[0]==='watch'),false);
});

test('cancelled before entry never reads or changes the test room',async()=>{
  const f=setup();f.control.abort();const r=await runDemandComparison(f.adapter);
  assert.equal(r.error,'cancelled');assert.equal(f.samples.length,0);assert.equal(f.operations.length,0);
});

test('cancellation before a queued callback dispatch prevents the operation itself',async()=>{
  const f=setup();const pending=runDemandComparison(f.adapter);f.control.abort();
  const result=await pending;
  assert.equal(result.error,'cancelled');assert.equal(f.samples.length,0);assert.equal(f.operations.length,0);
});

test('replaced publication, source or ownership prevents finally from watching again',async()=>{
  for(const change of [f=>{f.state.producerId='replacement';},f=>{f.state.ownedTestRoom=false;},
    f=>{f.state.trackToken++;},f=>{f.broker.started++;},f=>{f.state.sourceConfig.fps=60;},f=>{f.preview.bindingToken++;}]){
    const f=setup();f.setHook(where=>{if(where==='stop')change(f);});const r=await runDemandComparison(f.adapter);
    assert.equal(r.passed,false);assert.equal(r.restoration,'skipped_not_current');
    assert.equal(f.operations.some(v=>v[0]==='watch'),false);
  }
});

test('the global deadline stops sampling but permits one bounded unchanged-publication restoration',async()=>{
  const f=setup();f.setHook(where=>{if(where==='stop')f.advance(65000);});
  const r=await runDemandComparison(f.adapter);
  assert.equal(r.error,'deadline');assert.equal(r.restoration,'watch_requested');assert.equal(r.passed,false);
  assert.equal(f.watching,true);
});

test('a missing transition cannot be accepted as the requested paused stage',async()=>{
  const f=setup();f.adapter.stopWatching=async()=>{};f.adapter.wait=async()=>{};
  const r=await runDemandComparison(f.adapter);
  assert.equal(r.error,'demand_not_settled');assert.equal(r.phases.length,1);assert.equal(r.restoration,'already_watching');
});

test('a cancelled unresolved host operation cannot advance to a late watch action',async()=>{
  const f=setup();let resolve;
  f.adapter.stopWatching=()=>new Promise(r=>{resolve=r;});
  const pending=runDemandComparison(f.adapter);
  for(let i=0;i<400&&!resolve;i++)await Promise.resolve();
  assert.equal(typeof resolve,'function');f.control.abort();
  const result=await pending;resolve();await Promise.resolve();
  assert.equal(result.error,'cancelled');assert.equal(f.operations.some(v=>v[0]==='watch'),false);
});

test('a stalled host snapshot has a real bounded rejection and cannot dispatch a late transition',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const f=setup();let resolve;
  f.adapter.getSnapshot=()=>new Promise(r=>{resolve=r;});
  const pending=runDemandComparison(f.adapter);
  for(let i=0;i<20&&!resolve;i++)await Promise.resolve();
  assert.equal(typeof resolve,'function');f.advance(65000);context.mock.timers.tick(65000);
  const result=await pending;resolve({});await Promise.resolve();
  assert.equal(result.error,'deadline');assert.equal(f.operations.length,0);
});

test('counter resets within one phase are rejected rather than reported as a throughput gain',async()=>{
  const f=setup(),read=f.adapter.getSnapshot;let reset=false;
  f.adapter.getSnapshot=async()=>{const v=await read();if(reset)v.sample.sender.nativeCaptureCounters.framesWritten=0;return v;};
  f.setHook(where=>{if(where==='delay'&&f.operations.filter(v=>v[0]==='delay').length===2)reset=true;});
  const result=await runDemandComparison(f.adapter);
  assert.equal(result.error,'counter_reset');assert.equal(result.passed,false);
  assert.equal(f.operations.some(v=>v[0]==='stop'),false);
});

test('an uncertain failed watch is not dispatched a second time by finally',async()=>{
  const f=setup();let calls=0;
  f.adapter.watch=async()=>{calls++;throw Error('renderer result unknown');};
  const result=await runDemandComparison(f.adapter);
  assert.equal(result.error,'operation_failed');assert.equal(result.restoration,'watch_request_already_issued');
  assert.equal(calls,1);assert.equal(f.watching,false);
});
