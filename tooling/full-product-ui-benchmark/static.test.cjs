'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const a=require('./source-adapters.cjs'),{configure,prepare,supportsWorkerFixture}=require('./run.cjs');
const read=file=>fs.readFileSync(path.join(a.root,file),'utf8');
test('configuration fixes isolated complete-App baseline and rejects experimental confounders',()=>{
  const env={};configure(env);assert.equal(env.COVE_FPS_RUNTIME_NAME,'fps-validation-full-ui-20261029');
  assert.equal(env.COVE_FULL_UI_STATS,'0');assert.equal(env.COVE_FPS_LOCAL_PREVIEW,'1');
  assert.equal(env.COVE_FULL_UI_VOICE,'muted');
  for(const change of [{COVE_FULL_UI_STATS:'yes'},{COVE_FPS_NATIVE_GPU:'0'},{COVE_FPS_RECOVERY_CHECKS:'1'},
    {COVE_FPS_PEER_RENDER_MODE:'offscreen'},{COVE_FPS_SAMPLE_SECONDS:'31'}])assert.throws(()=>configure(change));
  const stats={COVE_FULL_UI_STATS:'1'};configure(stats);assert.equal(stats.COVE_FULL_UI_STATS,'1');
});
test('sink and codec modes are explicit and worker requires this worktree whitelist',()=>{
  for(const env of [{COVE_FULL_UI_FRAME_SINK:'canvas'},{COVE_FULL_UI_CODEC:'h264'}])assert.throws(()=>configure(env));
  const env={COVE_FULL_UI_CODEC:'vp8'};configure(env);const config=JSON.parse(env.COVE_FPS_CASES)[0];
  assert.equal(config.compatibility,true);assert.equal(config.expectCodec,'video/VP8');assert.equal(config.expectWidth,1728);assert.equal(config.expectHeight,1080);
  assert.equal(supportsWorkerFixture("if(!['generator','canvas'].includes(nativeFrameSink))throw Error('worker');"),false);
  assert.equal(supportsWorkerFixture("if(!['generator','canvas','worker'].includes(nativeFrameSink))throw Error('invalid');"),true);
  if(!supportsWorkerFixture(read('apps/desktop/tests/ui/screen-performance.electron.cjs')))assert.throws(()=>configure({COVE_FULL_UI_FRAME_SINK:'worker'}),/does not explicitly support/);
});

test('initial share waits for the committed compatibility preference through bounded existing helpers',()=>{
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  const target=source.indexOf('const fullUiCompatibilityTarget=Boolean(config.compatibility);');
  const setter=source.indexOf("await boundedJs(sender,'window.coveMediaQA.rtc.setScreenCompatibilityMode('+fullUiCompatibilityTarget+');void 0',1000);",target);
  const committed=source.indexOf("await wait(sender,'window.coveMediaQA.rtc.screenCompatibilityMode==='+fullUiCompatibilityTarget,3000);",setter);
  const start=source.indexOf("await startOwnedScreenShare(sender,config,'initial-publication-returned');",committed);
  assert.ok(target>0&&setter>target&&committed>setter&&start>committed);
  // The original publication operation, stop/cancellation handling and codec
  // guards stay intact; this only matches the normal UI preference ordering.
  assert.ok(source.includes("Boolean(window.coveMediaQA.rtc.localScreen)"));
  assert.ok(source.includes('waitNativeUpgrade(sender,viewer'));
});
test('same-size qualification fixes actual 1728x1080 AV1 and rejects other display geometry',()=>{
  const env={};configure(env);const cases=JSON.parse(env.COVE_FPS_CASES);
  assert.deepEqual(cases,[{source:'native',preset:'1080p',fps:120,game:true,captureTarget:'screen',
    compatibility:false,expectWidth:1728,expectHeight:1080,expectCodec:'video/AV1'}]);
  const {validatePerformanceCases,screenShareStartArguments}=require('../../tooling/screen-performance-config.cjs');
  assert.doesNotThrow(()=>validatePerformanceCases(cases));assert.equal(screenShareStartArguments(cases[0])[5],false);
  const display={size:{width:1707,height:1067},scaleFactor:1.5};
  assert.equal(a.qualifyFullProductDisplay([display]),true);
  assert.equal(a.qualifyFullProductDisplay([{size:{width:1280,height:800},scaleFactor:2}]),true);
  for(const displays of [[],[display,display],[{size:{width:1920,height:1080},scaleFactor:1}],
    [{...display,scaleFactor:0}],[{...display,size:{width:NaN,height:1067}}]])assert.equal(a.qualifyFullProductDisplay(displays),false);
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  const guard=source.indexOf('.qualifyFullProductDisplay(screen.getAllDisplays())');
  assert.ok(guard>=0&&guard<source.indexOf('    backend=spawn('));
});
test('a copied harness derives repository paths from its new directory',()=>{
  const copiedRoot=path.join(path.parse(a.root).root,'isolated-cove-worktree');
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'source-adapters.cjs'),'utf8'),
    {require,module,__dirname:path.join(copiedRoot,'tooling/full-product-ui-benchmark')});
  assert.equal(module.exports.root,copiedRoot);
  const source=module.exports.launcher(read('tooling/verify-screen-performance.cjs'));
  assert.ok(source.includes('tooling/full-product-ui-benchmark/electron.cjs'));
  assert.equal(source.includes(a.root),false);
});
test('fixed launcher adapter parses, retains backend namespace validation and no-HMR bootstrap',()=>{
  const original=read('tooling/verify-screen-performance.cjs'),source=a.launcher(original);
  assert.doesNotThrow(()=>new vm.Script(source));
  assert.ok(source.includes("/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/"));
  assert.ok(source.includes('fullProductUi:{enabled:true,syntheticMessages:200'));
  assert.ok(source.includes('tooling/full-product-ui-benchmark/electron.cjs'));
  const bootstrap=require('./vite-bootstrap.cjs').source({root:a.root,directory:path.join(a.root,'runtime/fps-validation-full-ui-20261029/test-only'),entry:'file:///fixed-vite.mjs',dependencies:a.root});
  assert.match(bootstrap,/hmr:false,watch:null/);assert.match(bootstrap,/fullProductPlugin\(\)/);
  const html=fs.readFileSync(path.join(__dirname,'full-product.html'),'utf8');
  assert.ok(!html.includes('__COVE_FULL_PRODUCT_RENDERER__'));
  assert.ok(html.includes('<base href="/">'));
  assert.ok(html.includes("new URL('./renderer.tsx',location.href)"));
  const location='http://127.0.0.1:1234/@fs/C:/owned/tooling/full-product-ui-benchmark/full-product.html?module=https://example.invalid/injected.js#test';
  const moduleUrl=new URL('./renderer.tsx',location);
  assert.equal(moduleUrl.search,'');assert.equal(moduleUrl.hash,'');
  assert.equal(moduleUrl.href,'http://127.0.0.1:1234/@fs/C:/owned/tooling/full-product-ui-benchmark/renderer.tsx');
});
test('full App Electron adapter preserves all ownership, pixel, codec and cleanup guards',()=>{
  const original=read('apps/desktop/tests/ui/screen-performance.electron.cjs'),source=a.electron(original);
  assert.doesNotThrow(()=>new vm.Script(source));
  for(const marker of ['event.senderFrame===peers[0].webContents.mainFrame','qualifyOwnedNativeBaseline',
    'assertOwnedVisiblePresentation()','Owned source/reader pattern layout mismatch','rendererResourcesZero&&backendResourcesZero',
    'waitNativeUpgrade(sender,viewer','pane.videoObjectFit!==\'contain\''])assert.ok(source.includes(marker),marker);
  assert.ok(source.includes("partition:'cove-full-product-ui-'+index"));
  assert.ok(source.includes("forPeerSessions('setDisplayMediaRequestHandler'"));
  assert.ok(source.includes('pane.statsEnabled!==fullUiStats'));
  assert.ok(source.includes('fullProductUi.samples.push'));
});

test('source provenance seals the meter store, hook integration and subscribed UI bindings',()=>{
  const source=a.launcher(read('tooling/verify-screen-performance.cjs'));
  for(const file of ['apps/desktop/src/features/media/useWebRTC.ts',
    'apps/desktop/src/features/media/audio/audioMeterLevels.ts',
    'apps/desktop/src/features/media/components/AudioMeterBindings.tsx']){
    assert.ok(source.includes("'"+file+"'"),file);
    assert.ok(fs.statSync(path.join(a.root,file)).isFile(),file);
  }
});
test('controller bridge runs only in postcommit effect and keeps real product implementation',()=>{
  const source=a.productController(read('apps/desktop/src/features/rooms/useRoomController.ts'));
  assert.ok(source.includes('function useRoomControllerProduct('));
  assert.match(source,/const controller = useRoomControllerProduct\(props\);\s+useEffect\(\(\) => \{/);
  assert.ok(source.includes('return controller;'));
  assert.ok(source.includes('useEffect(() => () => { (window as any).coveFullProductUiBridge?.roomUnmounted(); }, []);'));
  assert.throws(()=>a.productController('export const unrelated = 1;'));
});
test('full App cleanup leaves the room while connected before parent/socket teardown without clearing unknown owners',()=>{
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  const leave=source.indexOf('const fullProductRoom=await window.coveFullProductLeaveRoom?.()');
  const unmount=source.indexOf('window.covePerformanceUnmount?.()',leave);
  const disconnect=source.indexOf('qa?.socket.disconnect()',leave);
  assert.ok(leave>=0&&leave<unmount&&unmount<disconnect);
  assert.ok(source.includes('localPreview,fullProductRoom,unmountAvailable'));
  assert.ok(source.includes('renderer.fullProductRoom?.completed===true&&renderer.unmountAvailable'));
  const renderer=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  assert.match(renderer,/roomUnmounted\(\)\{roomMounted=false;\}/);
  assert.match(renderer,/latest\.leave\(\);\s+const until=started\+2000;/);
  assert.match(renderer,/while\(roomMounted&&performance\.now\(\)<until\)await delay\(25\)/);
  assert.equal(renderer.includes('removeAllListeners'),false);
  assert.equal(renderer.includes("socket.off('connect')"),false);
  assert.ok(source.includes("'timeouts','intervals','socketListeners'"));
});
test('observer remains the existing bounded fixture and excludes publisher preview before passive effects',()=>{
  const source=a.fixtureObserver(read('apps/desktop/tests/ui/screen-performance-fixture.ts'));
  assert.ok(source.includes("params.get('index') === '0' && video.closest('.share-view')"));
  assert.ok(source.includes('patternSnapshotResources.created === resources.patternSnapshotResources.closed'));
  prepare();assert.ok(fs.readFileSync(path.join(__dirname,'observer.ts'),'utf8').includes('export {peerConnections,iceQA}'));
});
test('explicit synthetic microphone precedes App and is tracked and disposed without physical capture',()=>{
  const renderer=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  const microphone=fs.readFileSync(path.join(__dirname,'synthetic-microphone.ts'),'utf8');
  const fixture=read('apps/desktop/tests/ui/screen-performance-fixture.ts');
  const observer=fs.readFileSync(path.join(__dirname,'observer.ts'),'utf8');
  assert.ok(renderer.indexOf('installScreenPerformanceFixture(params,peerConnections)')<renderer.indexOf('guardFixtureMicrophone(voiceMode)'));
  assert.ok(renderer.indexOf('guardFixtureMicrophone(voiceMode)')<renderer.indexOf("import('../../apps/desktop/src/app/App')"));
  assert.match(microphone,/navigator\.mediaDevices\.getUserMedia=getUserMedia/);
  assert.match(microphone,/!constraints\?\.audio\|\|Boolean\(constraints\.video\)/);
  assert.match(fixture,/gain\.gain\.value = 0\.03/);
  assert.match(fixture,/oscillator\.connect\(gain\)\.connect\(destination\)/);
  assert.match(fixture,/navigator\.mediaDevices\.getUserMedia = syntheticUserMedia/);
  assert.match(observer,/super\(\{\.\.\.options,sinkId:\{type:'none'\}\}/);
  assert.match(microphone,/return fixtureSyntheticUserMedia\.call\(navigator\.mediaDevices,constraints\)/);
  assert.equal(microphone.includes('new AudioContext'),false);
  assert.equal(microphone.includes('getDisplayMedia'),false);
  assert.match(renderer,/syntheticMicrophone\.release\(\);\s+const evidence=await cleanup\(\)/);
  assert.match(fixture,/oscillator\.stop\(\); track\.stop\(\); await context\.close\(\)/);
  assert.match(fixture,/resources\.openSyntheticAudioContexts === 0/);
  assert.match(renderer,/controllerCommits\+\+/);
  assert.match(renderer,/ready:targetWindow\.coveMediaQA\.ready,controllerCommits,/);
  const source=a.launcher(read('tooling/verify-screen-performance.cjs'));
  assert.match(source,/syntheticMicrophone:\{provider:'screen-performance-fixture'/);
  assert.match(fs.readFileSync(path.join(__dirname,'owned-main.cjs'),'utf8'),/physicalMicrophone:false,humanVoice:false,speakerOutput:false/);
});
test('App bootstrap seeds before import, loads 200 real rows and uses actual App routing',()=>{
  const source=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  assert.ok(source.indexOf("localStorage.setItem('cove_server_url',base)")<source.indexOf("import('../../apps/desktop/src/app/App')"));
  assert.match(source,/rememberAccountSession\(\{serverUrl:base,token,accountId:account\.id/);
  assert.match(source,/latest\.loadOlderMessages\(\)/);assert.match(source,/querySelectorAll\('\.message-row'\)\.length!==200/);
  assert.match(source,/<StrictMode><App\/><\/StrictMode>/);assert.equal(source.includes('<HashRouter'),false);
});
test('fixture initialization is awaited before microphone guard, sample access and App import',()=>{
  const renderer=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  const pending=renderer.indexOf("covePerformanceProductStylesState='pending'");
  const initialize=renderer.indexOf('const performanceFixture=await installScreenPerformanceFixture(params,peerConnections)');
  assert.ok(pending>=0&&pending<initialize);
  assert.ok(initialize<renderer.indexOf('const syntheticMicrophone=guardFixtureMicrophone(voiceMode)'));
  assert.ok(initialize<renderer.indexOf('const sample=performanceFixture.sample.bind(performanceFixture)'));
  assert.ok(initialize<renderer.indexOf("import('../../apps/desktop/src/app/App')"));
  assert.match(renderer,/if\(!performanceFixture\|\|typeof performanceFixture\.sample!=='function'/);
  assert.match(renderer,/targetWindow\.coveScreenPerformance=performanceFixture/);
  assert.match(renderer,/void bootstrap\(\)\.catch\(\(\)=>\{/);
  assert.match(renderer,/covePerformanceProductStylesState='failed'/);
  assert.match(renderer,/console\.error\('\[full-product-startup:error\] '\+startupPhase\)/);
  assert.equal(renderer.includes('const performanceFixture=targetWindow.coveScreenPerformance'),false);
});
function loadTypeScript(source,globals={}){
  const ts=require('typescript'),module={exports:{}};
  const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(javascript,{module,exports:module.exports,URLSearchParams,Float32Array,Math,Object,Map,Number,...globals});
  return module.exports;
}
test('explicit active voice keeps size/codec policy and rejects invalid modes',()=>{
  assert.throws(()=>configure({COVE_FULL_UI_VOICE:'microphone'}),/Invalid full App voice/);
  const env={COVE_FULL_UI_VOICE:'synthetic-varying'};configure(env);
  assert.equal(env.COVE_FULL_UI_VOICE,'synthetic-varying');assert.equal(JSON.parse(env.COVE_FPS_CASES)[0].expectCodec,'video/AV1');
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  assert.ok(source.includes('fullProductUi=1&fullMotionSwitch='));
  assert.ok(source.includes("'&fullMeterDiagnostic='"));
  assert.ok(source.includes("'&fullVoice='+fullUiVoice"));
  assert.ok(source.includes('full.selfMuted!==fullUiSelfMuted'));
  assert.ok(source.includes('last.meterValueChanges>first.meterValueChanges'));
  assert.ok(source.includes('last.controllerCommits>first.controllerCommits'));
  assert.ok(source.includes("mic?.provider!=='screen-performance-fixture'"));
  assert.ok(source.includes('mic.physicalMicrophone!==false'));
  assert.ok(source.includes("mic.sources.filter(source=>source.trackState==='live').length!==1"));
  assert.ok(source.includes('mic.sources.length>4||full.syntheticMicrophone.requests>4'));
});
test('active source guard distinguishes bounded ended history from exactly one live enabled source',()=>{
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  const expression=source.match(/if\(!fullUiSelfMuted&&\((mic\.gainMin[^\n]+)\)\)throw Error\('Varying synthetic/)[1];
  const qualify=new Function('mic','full','return !('+expression+');');
  const active={contextState:'running',trackState:'live',trackEnabled:true,elapsedSeconds:10};
  const ended={...active,trackState:'ended'};
  const mic=sources=>({gainMin:0.005,gainMax:0.05,curveSeconds:120,sources});
  const full={syntheticMicrophone:{requests:2}};
  assert.equal(qualify(mic([ended,active]),full),true);
  for(const sources of [[],[ended],[active,active],Array(5).fill(ended),[{...active,trackEnabled:false}],
    [{...active,contextState:'suspended'}],[{...active,elapsedSeconds:120}],[{...ended,trackState:'unknown'},active]])
    assert.equal(qualify(mic(sources),full),false);
  assert.equal(qualify(mic([active]),{syntheticMicrophone:{requests:5}}),false);
});
test('finite AudioParam curve is bounded and owned; no extra graph or timer',()=>{
  const fixture=read('apps/desktop/tests/ui/screen-performance-fixture.ts');
  const start=fixture.indexOf('export function screenPerformanceSyntheticVoice('),end=fixture.indexOf('export function installScreenPerformanceFixture(',start);
  const {screenPerformanceSyntheticVoice:plan}=loadTypeScript(fixture.slice(start,end));
  const muted=plan(new URLSearchParams());assert.equal(muted.mode,'muted');assert.equal(muted.curve,null);assert.equal(muted.gainMax,0.03);
  for(const value of ['fullVoice=synthetic-varying','fullVoice=invalid'])assert.throws(()=>plan(new URLSearchParams(value)));
  const active=plan(new URLSearchParams('performance=1&fullProductUi=1&fullVoice=synthetic-varying'));
  assert.equal(active.curveSeconds,120);assert.equal(active.curve.length,2401);
  assert.ok([...active.curve].every(value=>Number.isFinite(value)&&value>=0.005-1e-8&&value<=0.05+1e-8));
  assert.ok(Math.abs(active.curve[20]-0.05)<1e-8);assert.ok(Math.abs(active.curve[40]-0.005)<1e-8);
  const factory=fixture.slice(fixture.indexOf('const syntheticUserMedia:'),fixture.indexOf('navigator.mediaDevices.getUserMedia = syntheticUserMedia'));
  assert.equal((factory.match(/new AudioContext/g)||[]).length,1);assert.equal((factory.match(/createOscillator/g)||[]).length,1);
  assert.equal((factory.match(/createGain/g)||[]).length,1);assert.ok(factory.includes('setValueCurveAtTime'));
  assert.equal(factory.includes('setInterval'),false);assert.equal(factory.includes('setTimeout'),false);
  assert.ok(factory.includes("sinkId: { type: 'none' }"));
});
test('actual meter observation counts numeric changes separately from keys and returns only anonymous bounded values',()=>{
  const {createMeterObservation}=loadTypeScript(fs.readFileSync(path.join(__dirname,'meter-observation.ts'),'utf8'));
  const observation=createMeterObservation();observation.observe({accountA:0.1});
  const first=observation.snapshot();assert.equal(first.meterValueChanges,0);assert.equal(first.meterKeyChanges,1);
  observation.observe({accountA:0.1});assert.equal(observation.snapshot().meterValueChanges,0);
  observation.observe({accountA:0.2,accountB:0.3});assert.equal(observation.snapshot().meterValueChanges,1);
  observation.observe({accountB:0.3});assert.equal(observation.snapshot().meterKeyChanges,3);
  assert.equal(observation.snapshot().meterMinimum,0.1);assert.equal(observation.snapshot().meterMaximum,0.3);
  assert.equal(first.meterValues[0],0.1);assert.equal(JSON.stringify(observation.snapshot()).includes('account'),false);
  observation.observe(Object.fromEntries(Array.from({length:40},(_,index)=>['id-'+index,index/40])));
  assert.equal(observation.snapshot().meterValues.length,16);
});
test('chat render counter instruments only fixed product body and runs independently of controller commits',()=>{
  const source=a.productChat(read('apps/desktop/src/features/chat/ChatPanelV2.tsx'));
  assert.ok(source.includes('coveFullProductUiBridge?.chatRender();\n  const imageRef'));
  assert.throws(()=>a.productChat('const unrelated = 1;'));
  const renderer=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  assert.ok(renderer.includes('chatRender(){chatRenderCount++;}'));
  assert.ok(renderer.includes('rtcMeterObservation.update(controller)'));
  assert.ok(renderer.includes('controllerCommits,chatRenderCount,...meterObservation.snapshot()'));
  assert.ok(fs.readFileSync(path.join(__dirname,'vite-plugin.cjs'),'utf8').includes("['apps/desktop/src/features/chat/ChatPanelV2.tsx',productChat]"));
});
test('meter transition diagnostic is default-off and fixes only explicit mode at 24 seconds',()=>{
  const normal={};configure(normal);assert.equal(normal.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC,'0');assert.equal(normal.COVE_FPS_SAMPLE_SECONDS,'12');
  const diagnostic={COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC:'1'};configure(diagnostic);assert.equal(diagnostic.COVE_FPS_SAMPLE_SECONDS,'24');
  for(const env of [{COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC:'yes'},{COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC:'1',COVE_FPS_SAMPLE_SECONDS:'12'}])assert.throws(()=>configure(env));
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  assert.ok(source.includes("window.coveFullProductMeterTransitionSample('+n+')"));
  assert.ok(source.includes("const phase=n<8?'normal-a':n<16?'transition-none':'normal-a2'"));
  assert.ok(source.includes('d.hoveredShellElements!==reference'));
  assert.ok(source.includes('meterTransitionDiagnostic?.disposed===true'));
  assert.ok(source.includes('meterTransitionDiagnostic?.styleMounted===false'));
  assert.ok(a.launcher(read('tooling/verify-screen-performance.cjs')).includes("mixed total summary is not product performance evidence"));
});
test('same-session meter CSS diagnostic changes exactly two selectors and removes its owned style',()=>{
  let currentStyle=null,created=0,removed=0;
  const nodes=[{name:'volume-live-level',visible:true},{name:'vertical-live-level',visible:false}].map(node=>({...node,
    checkVisibility:()=>node.visible,getBoundingClientRect:()=>({width:10,height:10})}));
  const document={createElement(tag){assert.equal(tag,'style');created++;return {textContent:'',isConnected:false,remove(){this.isConnected=false;currentStyle=null;removed++;}};},
    head:{appendChild(style){style.isConnected=true;currentStyle=style;}},
    querySelectorAll(selector){if(selector==='.cove-shell :hover')return [];return nodes.filter(node=>selector==='.cove-shell .'+node.name);}};
  const {installMeterTransitionDiagnostic,meterTransitionPhase,meterTransitionRule}=loadTypeScript(
    fs.readFileSync(path.join(__dirname,'meter-transition-diagnostic.ts'),'utf8'),{document,getComputedStyle:()=>({transitionDuration:currentStyle?'0s':'0.09s',transitionProperty:currentStyle?'none':'width'})});
  assert.equal(meterTransitionRule,'.cove-shell .volume-live-level,.cove-shell .vertical-live-level{transition:none!important}');
  for(const [index,phase] of [[0,'normal-a'],[7,'normal-a'],[8,'transition-none'],[15,'transition-none'],[16,'normal-a2'],[24,'normal-a2']])assert.equal(meterTransitionPhase(index),phase);
  for(const invalid of [-1,25,1.5])assert.throws(()=>meterTransitionPhase(invalid));
  const off=installMeterTransitionDiagnostic(false);assert.equal(off.snapshot().phase,'disabled');assert.equal(created,0);
  const active=installMeterTransitionDiagnostic(true);active.setSampleIndex(0);assert.equal(created,0);
  assert.equal(active.snapshot().meters[0].cssVisibleCount,1);assert.equal(active.snapshot().meters[1].cssVisibleCount,0);
  active.setSampleIndex(8);active.setSampleIndex(9);assert.equal(created,1);assert.equal(active.snapshot().meters[0].transitionDuration[0],'0s');
  active.setSampleIndex(16);assert.equal(removed,1);assert.equal(active.snapshot().styleMounted,false);
  active.dispose();assert.equal(active.snapshot().disposed,true);assert.throws(()=>active.setSampleIndex(24));
  const cancelled=installMeterTransitionDiagnostic(true);cancelled.setSampleIndex(8);cancelled.dispose();assert.equal(cancelled.snapshot().styleMounted,false);
});
test('owned peers block supported native mouse events without retaining coordinates and preserve Escape abort',()=>{
  const source=fs.readFileSync(path.join(__dirname,'owned-main.cjs'),'utf8');
  const declarations=read('apps/desktop/node_modules/electron/electron.d.ts');
  assert.ok(declarations.includes("on(event: 'before-mouse-event'"));
  assert.ok(source.includes("wc.on('before-mouse-event',blockMouse)"));
  assert.ok(source.includes("wc.off('before-mouse-event',blockMouse)"));
  assert.ok(source.includes('blockedMouse=Math.min(1000,state.inputIsolation.blockedMouse+1)'));
  assert.ok(source.includes("input.key==='Escape'"));
  const getter=source.match(/isCancelled\(\)\{return state\.inputIsolation\.abortRequested===true;\}/)?.[0];
  assert.ok(getter);
  const state={inputIsolation:{abortRequested:false}},api=vm.runInNewContext('({'+getter+'})',{state});
  assert.equal(api.isCancelled(),false);state.inputIsolation.abortRequested=true;
  assert.equal(api.isCancelled(),true);assert.equal(state.inputIsolation.abortRequested,true);
  assert.equal(/throw|event|input\.key/.test(getter),false);
  assert.equal(/\b(?:mouse|event)\.(?:x|y|movementX|movementY)\b/.test(source),false);
});
test('real RTC store observer pre-subscribes UI keys, survives root silence and never re-subscribes unchanged keys',()=>{
  const {createRtcMeterObservation}=loadTypeScript(fs.readFileSync(path.join(__dirname,'rtc-meter-observation.ts'),'utf8'));
  const {createAudioMeterStore}=loadTypeScript(read('apps/desktop/src/features/media/audio/audioMeterLevels.ts'));
  const {createMeterObservation}=loadTypeScript(fs.readFileSync(path.join(__dirname,'meter-observation.ts'),'utf8'));
  const levels=createMeterObservation(),store=createAudioMeterStore();
  const observer=createRtcMeterObservation(values=>levels.observe(values));
  const rtc={audioMeters:store,localSocketId:'self',voiceMembers:[{socketId:'peer'}],get speakingLevels(){return store.getLevels('voice');}};
  const controller={rtc,roomMembers:[{socketId:'self'},{socketId:'peer'}]};
  observer.update(controller);const initial=observer.snapshot();
  assert.equal(initial.observationMode,'external-store');assert.equal(initial.activeHarnessMeterSubscriptions,4);
  assert.equal(store.subscriptionCount(),4);observer.update(controller);
  assert.equal(observer.snapshot().harnessMeterSubscriptionRegistrations,initial.harnessMeterSubscriptionRegistrations);
  store.publish({self:0.1,peer:0.2},{});store.publish({self:0.2,peer:0.3},{});
  assert.equal(observer.snapshot().meterStoreNotifications,2);assert.ok(levels.snapshot().meterValueChanges>=2);
  assert.ok(levels.snapshot().meterMaximum>0); // No additional controller update occurred.
  controller.roomMembers.push({socketId:'new-peer'});observer.update(controller);
  assert.equal(observer.snapshot().activeHarnessMeterSubscriptions,6);
  const unknown=store.subscribe('voice','unknown',()=>{});
  observer.stop();observer.stop();assert.equal(observer.resources().harnessMeterSubscriptions,0);
  assert.equal(observer.resources().meterStoreSubscriptions,1); // Never conceal a real/unknown subscriber.
  observer.update(controller);store.publish({self:0.4},{});assert.equal(observer.snapshot().activeHarnessMeterSubscriptions,0);
  unknown();assert.equal(observer.resources().meterStoreSubscriptions,0);
});
test('RTC meter observer supports old React state and precisely retires replaced stores',()=>{
  const {createRtcMeterObservation}=loadTypeScript(fs.readFileSync(path.join(__dirname,'rtc-meter-observation.ts'),'utf8'));
  const {createAudioMeterStore}=loadTypeScript(read('apps/desktop/src/features/media/audio/audioMeterLevels.ts'));
  const observed=[],observer=createRtcMeterObservation(values=>observed.push(values));
  observer.update({rtc:{speakingLevels:{self:0.1}}});observer.update({rtc:{speakingLevels:{self:0.2}}});
  assert.equal(observer.snapshot().observationMode,'react-state');assert.equal(observed.length,2);assert.equal(observer.resources().meterStoreSubscriptions,0);
  const old=createAudioMeterStore(),next=createAudioMeterStore();
  const controller=store=>({rtc:{audioMeters:store,localSocketId:'self',get speakingLevels(){return store.getLevels('voice');}},roomMembers:[]});
  observer.update(controller(old));assert.equal(old.subscriptionCount(),2);
  observer.update(controller(next));assert.equal(old.subscriptionCount(),0);assert.equal(next.subscriptionCount(),2);
  observer.stop();assert.equal(next.subscriptionCount(),0);assert.equal(observer.resources().meterStoreSubscriptions,0);
});
test('store-mode guards require actual numeric progress and all subscriptions zero while allowing zero root commits',()=>{
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  assert.ok(source.includes("last.observationMode==='external-store'&&last.activeHarnessMeterSubscriptions>0&&last.meterStoreNotifications>first.meterStoreNotifications"));
  assert.ok(source.includes("last.observationMode==='react-state'?last.controllerCommits>first.controllerCommits"));
  assert.ok(source.includes('last.meterPositiveObservations>first.meterPositiveObservations'));
  assert.equal(source.split("'meterStoreSubscriptions','harnessMeterSubscriptions'").length,3);
  const renderer=fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8');
  assert.ok(renderer.includes('...rtcMeterObservation.resources()'));
  assert.ok(renderer.indexOf('rtcMeterObservation.stop();',renderer.indexOf('coveFullProductLeaveRoom=async'))<renderer.indexOf('latest.leave();'));
  assert.ok(renderer.indexOf('rtcMeterObservation.stop();',renderer.indexOf('performanceFixture.cleanup=async'))<renderer.indexOf('syntheticMicrophone.release();'));
});
test('leaf DOM snapshot reads only bounded anonymous inline percentages and records avatar classes',()=>{
  let values=['0%','12.5%','4%'];
  const document={querySelectorAll(selector){if(selector==='.member-avatar .speaking')return [{},{}];assert.equal(selector,'.vertical-volume');
    return values.map(value=>({style:{getPropertyValue(name){assert.equal(name,'--volume-level');return value;}}}));}};
  const {snapshotDomMeters}=loadTypeScript(fs.readFileSync(path.join(__dirname,'dom-meter-observation.ts'),'utf8'),{document});
  const before=snapshotDomMeters();assert.equal(before.mountedCount,3);assert.equal(before.values[2],12.5);assert.equal(before.speakingAvatarCount,2);assert.equal(before.invalidCount,0);
  values=['bad','101%'];assert.equal(snapshotDomMeters().invalidCount,2);
  values=Array(25).fill('1%');assert.equal(snapshotDomMeters().sampledCount,16);assert.equal(snapshotDomMeters().truncated,true);
  assert.equal(JSON.stringify(before).includes('socket'),false);
});
test('active store mode requires changing nonzero actual DOM over the whole sample window, allowing equal first and last',()=>{
  const source=a.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  const before="if(!doms.every(dom=>",start=source.indexOf(before),end=source.indexOf("throw Error('Actual meter leaf DOM",start);
  assert.ok(start>0&&end>start);
  const expression=source.slice(start+3,end).trim().replace(/\)$/,'');
  const accepts=new Function('doms','return !('+expression+');');
  const dom=values=>({mountedCount:values.length,sampledCount:values.length,invalidCount:0,values});
  assert.equal(accepts([dom([1]),dom([2]),dom([1])]),true);
  assert.equal(accepts([dom([1]),dom([1]),dom([1])]),false);
  assert.equal(accepts([dom([0]),dom([0])]),false);
  assert.equal(accepts([dom([]),dom([1])]),false);
  assert.equal(accepts([dom([1]),{...dom([2]),invalidCount:1}]),false);
  assert.ok(source.includes("observationMode==='external-store'){const doms="));
  assert.ok(fs.readFileSync(path.join(__dirname,'renderer.tsx'),'utf8').includes('verticalMeterDom:snapshotDomMeters()'));
});
