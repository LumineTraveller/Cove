'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validatePerformanceCases,screenShareStartArguments,linkedCounterRate,qualifyOwnedNativeBaseline,selectOwnedCaptureSource}=require('../tooling/screen-performance-config.cjs');
const base={source:'native',preset:'540p',fps:120};

test('native resolution reaches the product start and restart argument position',()=>{
  assert.deepEqual(screenShareStartArguments({...base,game:true,nativeResolution:true,compatibility:true}),
    ['540p',120,false,true,true,true]);
  assert.deepEqual(screenShareStartArguments(base),['540p',120,false,false,false,false]);
  assert.throws(()=>validatePerformanceCases([{...base,nativeResolution:'true'}]));
});

test('comparison dimensions are optional or complete finite positive integer pairs',()=>{
  assert.doesNotThrow(()=>validatePerformanceCases([base]));
  assert.doesNotThrow(()=>validatePerformanceCases([{...base,expectCaptureWidth:1000,expectCaptureHeight:624,
    expectEncodedWidth:865,expectEncodedHeight:540,expectCodec:'video/AV1'}]));
  for(const [width,height] of [['expectWidth','expectHeight'],['expectCaptureWidth','expectCaptureHeight'],
    ['expectEncodedWidth','expectEncodedHeight']]){
    assert.throws(()=>validatePerformanceCases([{...base,[width]:864}]));
    assert.throws(()=>validatePerformanceCases([{...base,[height]:540}]));
    for(const invalid of [0,-1,NaN,Infinity,1.5,'864',8193,null])
      assert.throws(()=>validatePerformanceCases([{...base,[width]:invalid,[height]:540}]));
  }
});

test('invalid sources, unbounded cases and unrecognized codecs are rejected',()=>{
  for(const cases of [null,[],Array(13).fill(base),[{...base,source:'personal'}],
    [{...base,expectCodec:'video/fake'}],[{...base,captureTarget:'other'}],
    [{...base,ownedWindowFullscreen:'true'}]])assert.throws(()=>validatePerformanceCases(cases));
  assert.doesNotThrow(()=>validatePerformanceCases([{...base,captureTarget:'window',ownedWindowFullscreen:true}]));
  assert.doesNotThrow(()=>validatePerformanceCases([{...base,captureTarget:'window',nativeWindowPath:true}]));
  for(const config of [{...base,nativeWindowPath:true},{...base,captureTarget:'screen',nativeWindowPath:true},
    {...base,source:'generated',captureTarget:'window',nativeWindowPath:true},{...base,captureTarget:'window',nativeWindowPath:'true'}])
    assert.throws(()=>validatePerformanceCases([config]));
});

function point(frames, timestamp, sequence=frames) {
  return { sender: { pipeline: { source: { reportId: 'live', connectionIndex: 7, trackToken: 2 } },
    reports: [{id:'stale',connectionIndex:1,timestamp,frames:100000},
      {id:'live',connectionIndex:7,timestamp,frames}] },
    nativeSourceFrames:sequence+12,
    viewer: {ownedPattern:{markersMatched:[true,true,true,true],capturedSequence:sequence}} };
}

test('counter rates bind a live report, stable connection and stable track',()=>{
  const a=point(20,1000),b=point(100,2000);
  assert.equal(linkedCounterRate(a.sender,b.sender,'source','frames'),80);
  for(const altered of [
    {...b.sender,pipeline:{source:{reportId:'missing',connectionIndex:7,trackToken:2}}},
    {...b.sender,pipeline:{source:{reportId:'live',connectionIndex:8,trackToken:2}}},
    {...b.sender,pipeline:{source:{reportId:'live',connectionIndex:7,trackToken:3}}},
  ])assert.equal(linkedCounterRate(a.sender,altered,'source','frames'),null);
});

test('native qualification requires own markers, changing captured sequence and native cadence',()=>{
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000),point(100,2000)]).passed,true);
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000,20),point(100,2000,20)]).passed,false);
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000),point(21,2000)]).passed,false);
  const unrelated=point(100,2000);unrelated.viewer.ownedPattern.markersMatched[2]=false;
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000),unrelated]).passed,false);
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000)]).passed,false);
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000,200),point(100,2000,100)]).passed,false);
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000,65530),point(100,2000,74)]).passed,true);
  const future=point(100,2000,4094);future.nativeSourceFrames=3355;
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000,3112),future]).capturedSequenceNotFuture,false);
  const stale=point(100,2000,100);stale.nativeSourceFrames=1101;
  assert.equal(qualifyOwnedNativeBaseline(base,[point(20,1000,20),stale]).capturedSequenceNotFuture,false);
  assert.equal(qualifyOwnedNativeBaseline({...base,source:'generated'},[]).required,false);
});

test('native selection permits only an identified display or unambiguous single-display fallback',()=>{
  const options={captureTarget:'screen',displays:[{id:8}],primaryDisplayId:8,ownedWindowId:'window:1'};
  const named={id:'screen:8',display_id:'8'},legacy={id:'screen:0',display_id:''};
  assert.equal(selectOwnedCaptureSource({...options,sources:[named]}).metadata.selectionMode,'primary-display-id');
  assert.equal(selectOwnedCaptureSource({...options,sources:[legacy]}).metadata.selectionMode,'single-display-single-source-without-display-id');
  for(const changed of [{displays:[{id:8},{id:9}],sources:[legacy]},
    {sources:[legacy,{id:'screen:2',display_id:''}]},{sources:[]},{sources:[{id:'screen:9',display_id:'9'}]}])
    assert.throws(()=>selectOwnedCaptureSource({...options,...changed}));
  assert.equal(selectOwnedCaptureSource({...options,captureTarget:'window',sources:[{id:'window:1'}]}).metadata.selectionMode,'owned-window-id');
  const routed=selectOwnedCaptureSource({...options,captureTarget:'window',ownedWindowId:'window:12345:7',sources:[{id:'window:12345:7'}],nativeWindowPath:true});
  assert.equal(routed.source.id,'window:12345:0');assert.equal(routed.metadata.originalThirdFieldNonzero,true);
  assert.equal(routed.metadata.requestedThirdFieldNonzero,false);assert.ok(!JSON.stringify(routed.metadata).includes('12345'));
});
