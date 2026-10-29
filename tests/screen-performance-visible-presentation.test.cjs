'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {visiblePresentationOptions,visiblePresentationGeometry,qualifyVisiblePresentationState,waitVisiblePresentationStartup}=require('../tooling/screen-performance-local-preview.cjs');
const layouts=require('../apps/desktop/tests/ui/screen-performance-pattern-layouts.json');
const vm=require('node:vm');
const base={COVE_FPS_VISIBLE_PRESENTATION:'1',COVE_FPS_PEER_RENDER_MODE:'hidden',
  COVE_FPS_PRODUCT_SENDER_THROTTLING:'1',COVE_FPS_NATIVE_GPU:'1',
  COVE_FPS_CASES:JSON.stringify([{source:'native',preset:'1080p',fps:120,game:true,captureTarget:'screen'}])};
const display=()=>({id:7,bounds:{x:0,y:0,width:1707,height:1067},
  workArea:{x:0,y:0,width:1707,height:1019},scaleFactor:1.5,displayFrequency:240});

test('only explicit visible Electron launch removes the Windows process hide flag',()=>{
  const launcher=fs.readFileSync(path.join(__dirname,'../tooling/verify-screen-performance.cjs'),'utf8');
  const source=launcher.slice(launcher.indexOf('function logged('),launcher.indexOf('async function port('));
  const calls=[],closed=[];
  const logged=vm.runInNewContext('('+source.trim()+')',{root:'isolated-root',
    fs:{openSync:()=>17,closeSync:fd=>closed.push(fd)},
    spawn:(executable,args,options)=>{const child={once:(event,callback)=>{assert.equal(event,'close');child.close=callback;}};calls.push({executable,args,options,child});return child;}});
  for(const options of [undefined,{windowsHide:true},{windowsHide:false}]){
    const child=logged('owned-executable',['owned-fixture'],{ISOLATED:'1'},'owned.log',options);child.close();
  }
  assert.deepEqual(calls.map(call=>call.options.windowsHide),[true,true,false]);
  assert.deepEqual(closed,[17,17,17]);
  assert.match(launcher,/electron=logged\([^\n]+\{windowsHide:!visiblePresentation\.enabled\}\)/);
  assert.match(launcher,/vite=logged\(process\.execPath,\[bootstrap\],env,path\.join\(directory,'vite\.log'\)\)/);
  assert.match(launcher,/electronProcessWindowsHide:!visiblePresentation\.enabled/);
});

test('visible presentation is opt-in, keeps the old central layout, and permits preview off/on controls',()=>{
  assert.deepEqual(visiblePresentationOptions({}),{enabled:false,patternLayout:'central-v1'});
  assert.deepEqual(visiblePresentationOptions({COVE_FPS_VISIBLE_PRESENTATION:'0'}),{enabled:false,patternLayout:'central-v1'});
  for(const preview of ['0','1'])assert.deepEqual(visiblePresentationOptions({...base,COVE_FPS_LOCAL_PREVIEW:preview}),
    {enabled:true,patternLayout:'top-strip-v1'});
  for(const value of ['true','',1,true])assert.throws(()=>visiblePresentationOptions({...base,COVE_FPS_VISIBLE_PRESENTATION:value}));
});

test('visible presentation explicitly admits the qualified Worker while rejecting Canvas and unknown sinks',()=>{
  for(const sink of ['generator','worker'])
    assert.deepEqual(visiblePresentationOptions({...base,COVE_FPS_NATIVE_FRAME_SINK:sink}),
      {enabled:true,patternLayout:'top-strip-v1'});
  for(const sink of ['canvas','worker-extra','Worker','','unknown',true])
    assert.throws(()=>visiblePresentationOptions({...base,COVE_FPS_NATIVE_FRAME_SINK:sink}));
});

test('conflicting modes and unowned/unsupported cases fail before Electron startup',()=>{
  for(const sink of ['generator','worker']){
  const qualified={...base,COVE_FPS_NATIVE_FRAME_SINK:sink};
  for(const flag of ['COVE_FPS_MINIMIZE_SENDER','COVE_FPS_NATIVE_LIFECYCLE_CHECKS','COVE_FPS_RECOVERY_CHECKS',
    'COVE_FPS_REPUBLISH_CHECKS','COVE_FPS_CONTENT_TRACE','COVE_FPS_GENERATED_NV12','COVE_FPS_DISABLE_RENDERER_BACKGROUNDING'])
    assert.throws(()=>visiblePresentationOptions({...qualified,[flag]:'1'}));
  for(const change of [{COVE_FPS_PEER_RENDER_MODE:'offscreen'},{COVE_FPS_PRODUCT_SENDER_THROTTLING:'0'},
    {COVE_FPS_NATIVE_GPU:'0'},{COVE_DISABLE_NATIVE_GPU_CAPTURE:'1'},
    {COVE_FPS_NATIVE_STORAGE:'cpu'},{COVE_FPS_NATIVE_PIXEL_FORMAT:'nv12'},{COVE_FPS_NATIVE_FRAME_SINK:'canvas'},
    {COVE_FPS_CASES:'['},{COVE_FPS_CASES:'[]'}])assert.throws(()=>visiblePresentationOptions({...qualified,...change}));
  const config=JSON.parse(base.COVE_FPS_CASES)[0];
  for(const change of [{source:'generated'},{captureTarget:'window'},{fps:60},{game:false},
    {nativeResolution:true},{nativeWindowPath:true}])
    assert.throws(()=>visiblePresentationOptions({...qualified,COVE_FPS_CASES:JSON.stringify([{...config,...change}])}));
  assert.throws(()=>visiblePresentationOptions({...qualified,COVE_FPS_CASES:JSON.stringify([config,config])}));
  }
});

test('75 percent center geometry exposes all twenty taskbar-safe pattern probes',()=>{
  const original=display(),geometry=visiblePresentationGeometry([original]);
  assert.deepEqual(geometry.senderBounds,{x:213,y:133,width:1280,height:800});
  assert.equal(geometry.patternLayout,'top-strip-v1');assert.equal(geometry.probeRects.length,20);
  for(const probe of geometry.probeRects){
    assert.ok(probe.x>=0&&probe.y>=0&&probe.x+probe.width<=1707&&probe.y+probe.height<=1019);
    const sender=geometry.senderBounds,pad=geometry.shadowDip;
    assert.ok(probe.x+probe.width<=sender.x-pad||probe.x>=sender.x+sender.width+pad||
      probe.y+probe.height<=sender.y-pad||probe.y>=sender.y+sender.height+pad);
  }
  const shifted=display();shifted.bounds.x=-1707;shifted.workArea.x=-1707;
  assert.equal(visiblePresentationGeometry([shifted]).senderBounds.x,213-1707);
  assert.deepEqual(original,display());
});

test('display, taskbar and refresh exceptions fail without changing system settings',()=>{
  assert.throws(()=>visiblePresentationGeometry([]));assert.throws(()=>visiblePresentationGeometry([display(),display()]));
  for(const change of [{displayFrequency:60},{scaleFactor:0},{bounds:{x:0,y:0,width:700,height:1200}},
    {bounds:{x:0,y:0,width:900,height:600}},{workArea:{x:0,y:0,width:1707,height:900}},
    {bounds:{x:NaN,y:0,width:1707,height:1067}}])assert.throws(()=>visiblePresentationGeometry([{...display(),...change}]));
});

function state(geometry){return {displayCount:1,primaryDisplayUnchanged:true,
  displayBounds:geometry.displayBounds,workArea:geometry.workArea,scaleFactor:1.5,displayFrequency:240,
  sender:{bounds:geometry.senderBounds,visible:true,minimized:false,focused:true,offscreen:false,backgroundThrottling:true},
  source:{bounds:geometry.displayBounds,contentBounds:geometry.displayBounds,visible:true,minimized:false,
    fullscreen:true,alwaysOnTop:false,backgroundThrottling:false}};}

test('foreground qualification requires the owned visible publisher and unchanged display geometry',()=>{
  const geometry=visiblePresentationGeometry([display()]);assert.equal(qualifyVisiblePresentationState(geometry,state(geometry)),true);
  for(const [group,key,value] of [['sender','focused',false],['sender','visible',false],['sender','minimized',true],
    ['sender','offscreen',true],['sender','backgroundThrottling',false],['source','visible',false],
    ['source','minimized',true],['source','fullscreen',false],['source','alwaysOnTop',true],['source','backgroundThrottling',true]]){
    const current=state(geometry);current[group][key]=value;assert.equal(qualifyVisiblePresentationState(geometry,current),false);
  }
  for(const change of [{displayCount:2},{primaryDisplayUnchanged:false},{scaleFactor:1.25},{displayFrequency:144}])
    assert.equal(qualifyVisiblePresentationState(geometry,{...state(geometry),...change}),false);
  const moved=state(geometry);moved.sender={...moved.sender,bounds:{...moved.sender.bounds,x:0}};
  assert.equal(qualifyVisiblePresentationState(geometry,moved),false);
});

test('startup observes delayed focus after one request without changing state or reacquiring focus',async()=>{
  const geometry=visiblePresentationGeometry([display()]);let time=0,reads=0,waits=0;
  const result=await waitVisiblePresentationStartup(geometry,()=>{reads++;const current=state(geometry);
    current.sender.focused=time>=200;return current;},
    {now:()=>time,wait:async ms=>{assert.equal(ms,50);waits++;time+=ms;}});
  assert.equal(result.established,true);assert.equal(result.elapsedMs,200);
  assert.equal(result.observations,5);assert.equal(reads,5);assert.equal(waits,4);
  assert.equal(result.state.sender.focused,true);
});

test('startup expires after two seconds and returns its final failed owned state',async()=>{
  const geometry=visiblePresentationGeometry([display()]);let time=0,waits=0;
  const result=await waitVisiblePresentationStartup(geometry,()=>{const current=state(geometry);
    current.sender.focused=false;return current;},
    {now:()=>time,wait:async ms=>{assert.ok(ms<=50);time+=ms;waits++;}});
  assert.equal(result.established,false);assert.equal(result.elapsedMs,2000);
  assert.equal(result.observations,41);assert.equal(waits,40);
  assert.equal(result.state.sender.focused,false);
});

test('startup does not accept a focus observation arriving beyond its fixed deadline',async()=>{
  const geometry=visiblePresentationGeometry([display()]);let time=0;
  const result=await waitVisiblePresentationStartup(geometry,()=>{const current=state(geometry);
    current.sender.focused=time>0;return current;},
    {now:()=>time,wait:async()=>{time=2050;}});
  assert.equal(result.established,false);assert.equal(result.elapsedMs,2050);
  assert.equal(result.state.sender.focused,true);
});

test('fixed top strip is outside the centered sender while central defaults remain exact',()=>{
  assert.deepEqual(layouts['central-v1'].corners,[[.05,.05],[.95,.05],[.05,.95],[.95,.95]]);
  assert.deepEqual(layouts['central-v1'].bits,{left:.2,top:.4,width:.6,height:.1,sampleY:.45,count:16});
  const top=layouts['top-strip-v1'];assert.equal(top.bits.count,16);
  assert.ok(top.bits.top>0&&top.bits.top+top.bits.height<.125);
  assert.ok(top.bits.sampleY>top.bits.top&&top.bits.sampleY<top.bits.top+top.bits.height);
  for(const [x,y] of top.corners)assert.ok((x<.125||x>.875)&&(y<.125||y>.875));
});

test('source, reader and self-test use the same fixed layout; ownership guard surrounds every sample',()=>{
  const runner=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8');
  const fixture=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance-fixture.ts'),'utf8');
  assert.match(runner,/const patternBits=patternLayouts\[visiblePresentation\.patternLayout\]\.bits/);
  assert.match(runner,/x\.fillRect\(384\+bit\*72,\$\{patternBits\.top\*1080\},72,\$\{patternBits\.height\*1080\}\)/);
  assert.match(fixture,/const points = \[\.\.\.patternLayout\.corners/);
  assert.match(fixture,/bits\.top \* canvas\.height/);
  assert.match(runner,/receive\.ownedPattern\?\.patternLayout!==visiblePresentation\.patternLayout/);
  const loop=runner.indexOf('for(let n=0;n<=sampleSeconds;n++)'),before=runner.indexOf('const visibleBefore=assertOwnedVisiblePresentation();',loop);
  const sample=runner.indexOf('const [send,receive]=await Promise.all',loop),after=runner.indexOf('const visibleAfter=assertOwnedVisiblePresentation();',loop);
  assert.ok(loop>=0&&before>loop&&sample>before&&after>sample);
  assert.match(runner,/if\(config\.source==='native'&&!visiblePresentation\.enabled\)sourceWindow\.moveTop\(\)/);
  assert.match(runner,/sourceLimited=!\(measured\.summary\?\.nativeSourceRafFps>=config\.fps\)/);
  assert.match(runner,/result\.visiblePresentation\.failure=\{phase,at:Date\.now\(\),state\};save\(\)/);
  assert.match(runner,/result\.visiblePresentation\.startup=startup;save\(\)/);
  assert.match(runner,/if\(!startup\.established\)rejectOwnedVisiblePresentation\('startup',startup\.state\)/);
});

test('presentation uses product video/CSS/real stats panel without ShareView globals',()=>{
  const integration=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/media-integration.tsx'),'utf8');
  assert.match(integration,/import \{DiagnosticsOverlayV2\} from/);
  assert.match(integration,/import\('\.\.\/\.\.\/src\/styles\/index\.css'\)/);
  assert.match(integration,/import\('\.\.\/\.\.\/src\/styles\/ui-v2\.css'\)/);
  assert.match(integration,/visiblePresentationEnabled&&ready&&!rtc\.statsEnabled\)rtc\.toggleStats\(\)/);
  assert.match(integration,/<DiagnosticsOverlayV2 rtc=\{rtc\}/);
  assert.equal(integration.includes('ShareViewV2'),false);
  assert.equal(integration.includes('useSharerAnnotationOverlay'),false);
});
