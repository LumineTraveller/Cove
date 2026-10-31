'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {performanceLocalPreviewEnabled,performanceProductSenderThrottling,publisherBackgroundThrottling,localPreviewSummary}=require('../tooling/screen-performance-local-preview.cjs');

class FakeStream{constructor(track){this.track=track;}getVideoTracks(){return [this.track];}}
const fixtureExports={};
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance-fixture.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS},
}).outputText;
vm.runInNewContext(source,{exports:fixtureExports,require:name=>{
  if(name==='./screen-performance-pattern-layouts.json')return require('../apps/desktop/tests/ui/screen-performance-pattern-layouts.json');
  assert.match(name,/nativeScreenCapture$/);return {};
},
  MediaStream:FakeStream,performance:{now:()=>1234},URLSearchParams});
const {screenPerformanceLocalPreviewEnabled,createScreenPerformanceLocalPreviewBinding,screenPerformanceLocalPreviewSnapshot}=fixtureExports;

test('local preview defaults off and validates its exact opt-in before runtime creation',()=>{
  assert.equal(performanceLocalPreviewEnabled({}),false);
  assert.equal(performanceLocalPreviewEnabled({COVE_FPS_LOCAL_PREVIEW:'0'}),false);
  assert.equal(performanceLocalPreviewEnabled({COVE_FPS_LOCAL_PREVIEW:'1'}),true);
  for(const value of ['',true,1,'true','01','1,0','private'])
    assert.throws(()=>performanceLocalPreviewEnabled({COVE_FPS_LOCAL_PREVIEW:value}));
});

test('renderer opt-in belongs only to the isolated performance publisher',()=>{
  const parse=query=>screenPerformanceLocalPreviewEnabled(new URLSearchParams(query));
  assert.equal(parse('performance=1&index=0'),false);
  assert.equal(parse('performance=1&index=0&localPreview=0'),false);
  assert.equal(parse('performance=1&index=0&localPreview=1'),true);
  for(const query of ['performance=1&index=1&localPreview=1','index=0&localPreview=1',
    'performance=1&localPreview=1','performance=1&index=0&localPreview=true'])
    assert.throws(()=>parse(query));
});

test('product sender throttling is an explicit publisher-only opt-in and retains minimize controls',()=>{
  assert.equal(performanceProductSenderThrottling({}),false);
  assert.equal(performanceProductSenderThrottling({COVE_FPS_PRODUCT_SENDER_THROTTLING:'0'}),false);
  assert.equal(performanceProductSenderThrottling({COVE_FPS_PRODUCT_SENDER_THROTTLING:'1'}),true);
  for(const value of ['',true,'true','01'])
    assert.throws(()=>performanceProductSenderThrottling({COVE_FPS_PRODUCT_SENDER_THROTTLING:value}));
  assert.equal(publisherBackgroundThrottling(),false);
  assert.equal(publisherBackgroundThrottling({productSenderThrottling:true}),true);
  assert.equal(publisherBackgroundThrottling({minimizeSender:true}),true);
  assert.equal(publisherBackgroundThrottling({minimizeSender:true,minimizedThrottling:false}),false);
  assert.throws(()=>publisherBackgroundThrottling({minimizeSender:true,minimizedThrottling:false,productSenderThrottling:true}));
  const runner=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8');
  assert.match(runner,/backgroundThrottling:index===0&&senderBackgroundThrottling/);
});

test('ZeroCopy control is appended beside the existing AllowWgc feature without changing product code',()=>{
  const runner=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8');
  assert.match(runner,/if\(captureFeatures&&!\['ZeroCopyDesktopCapture'\]\.includes\(captureFeatures\)\)/);
  assert.match(runner,/appendSwitch\('enable-features',\['AllowWgcScreenCapturer',captureFeatures\]\.filter\(Boolean\)\.join\(','\)\)/);
});

function setup(){
  const track={readyState:'live',id:'private-track-id'},stream=new FakeStream(track);
  const video={srcObject:stream,isConnected:true,readyState:4,paused:false,muted:true,
    videoWidth:1728,videoHeight:1080,clientWidth:300,clientHeight:150,
    getVideoPlaybackQuality:()=>({totalVideoFrames:120,droppedVideoFrames:2})};
  return {track,stream,video};
}

test('binding generation distinguishes replacement video, stream or track without browser IDs',()=>{
  const binding=createScreenPerformanceLocalPreviewBinding(),video={},stream={},track={};
  const first=binding(video,stream,track);
  assert.equal(binding(video,stream,track),first);
  assert.notEqual(binding({},stream,track),first);
  assert.notEqual(binding(video,{},track),first);
  assert.notEqual(binding(video,stream,{}),first);
});

test('snapshot binds existing local stream and published track without acquiring or copying media',()=>{
  const {track,stream,video}=setup();let tokenCalls=0;
  const result=screenPerformanceLocalPreviewSnapshot(true,video,stream,track,(actualVideo,actualStream,actual)=>{
    assert.equal(actualVideo,video);assert.equal(actualStream,stream);assert.equal(actual,track);tokenCalls++;return 7;
  });
  assert.equal(result.mounted,true);assert.equal(result.streamMatchesLocalScreen,true);
  assert.equal(result.matchesLiveSenderTrack,true);assert.equal(result.bindingToken,7);
  assert.equal(result.readyState,4);assert.equal(result.muted,true);assert.equal(result.paused,false);
  assert.equal(result.totalVideoFrames,120);assert.equal(result.droppedVideoFrames,2);
  assert.equal(result.timestamp,1234);assert.equal(result.cssWidth,300);assert.equal(result.cssHeight,150);
  assert.equal(JSON.stringify(result).includes('private-track-id'),false);assert.equal(tokenCalls,1);
  assert.equal(video.srcObject,stream);
});

test('snapshot distinguishes wrong track, wrong stream, disposed video and unavailable counters',()=>{
  const {track,stream,video}=setup();
  const wrong=screenPerformanceLocalPreviewSnapshot(true,video,new FakeStream(track),{},()=>2);
  assert.equal(wrong.streamMatchesLocalScreen,false);assert.equal(wrong.matchesLiveSenderTrack,false);
  const absent=screenPerformanceLocalPreviewSnapshot(false,null,undefined,undefined,()=>{throw Error('must not inspect an absent track');});
  assert.equal(absent.mounted,false);assert.equal(absent.bindingToken,null);assert.equal(absent.totalVideoFrames,null);
  video.srcObject=null;video.isConnected=false;video.getVideoPlaybackQuality=()=>{throw Error('private text');};
  const disposed=screenPerformanceLocalPreviewSnapshot(true,video,stream,track,()=>2);
  assert.equal(disposed.mounted,false);assert.equal(disposed.streamMatchesLocalScreen,false);
  assert.equal(disposed.totalVideoFrames,null);assert.equal(JSON.stringify(disposed).includes('private'),false);
});

function sample(timestamp,totalVideoFrames=100,bindingToken=1){return {sender:{localPreview:{requested:true,timestamp,
  mounted:true,streamMatchesLocalScreen:true,matchesLiveSenderTrack:true,trackState:'live',bindingToken,
  readyState:4,paused:false,muted:true,totalVideoFrames,droppedVideoFrames:2}}};}

test('summary measures cumulative playback over publisher timestamps and does not claim scan-out',()=>{
  const result=localPreviewSummary([sample(1000),sample(1500,160),sample(2000,220)]);
  assert.equal(result.sameBinding,true);assert.equal(result.seconds,1);assert.equal(result.playbackFramesFps,120);
  assert.equal(result.playbackDroppedFps,0);assert.equal(result.playingAtAllSamples,true);
  assert.equal(result.playbackNonDroppedFramesFps,120);
  assert.equal(result.mutedAtAllSamples,true);assert.match(result.meaning,/not physical scan-out/i);
  const hidden=localPreviewSummary([sample(1000),sample(2000)]);
  assert.equal(hidden.playbackFramesFps,0);
});

test('summary refuses rates spanning track changes, mismatches or counter resets',()=>{
  for(const points of [[sample(1000),sample(2000,220,2)],
    [sample(1000,100),sample(1500,90),sample(2000,220)],
    [sample(1000),sample(1000,220)]])assert.equal(localPreviewSummary(points).playbackFramesFps,null);
  for(const field of ['mounted','streamMatchesLocalScreen','matchesLiveSenderTrack']){
    const a=sample(1000),b=sample(2000,220);b.sender.localPreview[field]=false;
    assert.equal(localPreviewSummary([a,b]).sameBinding,false);
  }
  const a=sample(1000),b=sample(2000,220);b.sender.localPreview.totalVideoFrames=NaN;
  assert.equal(localPreviewSummary([a,b]).playbackFramesFps,null);
});

test('disabled summary distinguishes an unexpected mounted preview',()=>{
  assert.equal(localPreviewSummary([{sender:{localPreview:{requested:false,mounted:false}}}]).unexpectedPreview,false);
  assert.equal(localPreviewSummary([{sender:{localPreview:{requested:false,mounted:true}}}]).unexpectedPreview,true);
  assert.equal(localPreviewSummary([]).sameBinding,false);
});

test('fixture reuses the product component on the same local stream after the receiver video',()=>{
  const integration=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/media-integration.tsx'),'utf8');
  assert.match(integration,/import \{LocalScreenVideo\} from '\.\.\/\.\.\/src\/features\/media\/screen\/ScreenVideo'/);
  assert.match(integration,/localPreviewEnabled&&rtc\.localScreen&&<section data-cove-performance-local-preview="1"><LocalScreenVideo stream=\{rtc\.localScreen\}/);
  assert.ok(integration.indexOf('<video ref={video}')<integration.indexOf('<LocalScreenVideo stream={rtc.localScreen}'));
  const fixture=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance-fixture.ts'),'utf8');
  assert.match(fixture,/if \(video\.closest\('\[data-cove-performance-local-preview\]'\)\) continue;/);
});
