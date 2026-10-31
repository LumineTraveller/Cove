'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {foregroundGateEnabled,waitForForegroundGate,TIMEOUT_MS,POLL_MS,READY_FILE,CONTINUE_FILE}=require('./foreground-gate.cjs');
const {configure}=require('./run.cjs'),adapters=require('./source-adapters.cjs');
const directory=path.resolve('runtime/fps-validation-full-ui-20261029/gate-cpu-only');
function fixture({releaseAt=150,stale=false,regular=true,cancelAt=Infinity,validationError=null,cancelOnRelease=false}={}){
  let clock=0,ready=false,cancelled=false,validated=0;const waits=[],updates=[],writes=[];
  const files={async lstat(file){assert.equal(file,path.join(directory,CONTINUE_FILE));
    if(stale||(ready&&clock>=releaseAt)){if(cancelOnRelease)cancelled=true;return {isFile:()=>regular};}
    throw Object.assign(Error('missing'),{code:'ENOENT'});},
    async writeFile(file,value,options){writes.push({file,value,options});ready=true;}};
  const run=()=>waitForForegroundGate({directory,files,now:()=>clock,isCancelled:()=>cancelled||clock>=cancelAt,
    delay:async ms=>{waits.push(ms);await Promise.resolve();clock+=ms;},onUpdate:value=>updates.push(value),
    validate:()=>{assert.equal(ready,true);assert.ok(clock>=releaseAt);validated++;if(validationError)throw validationError;}});
  return {run,waits,updates,writes,validated:()=>validated};
}
test('foreground preparation gate is strictly opt-in without changing the bounded workload',()=>{
  assert.equal(foregroundGateEnabled({}),false);assert.equal(foregroundGateEnabled({COVE_FULL_UI_FOREGROUND_GATE:'1'}),true);
  for(const value of ['',true,1,'yes','true'])assert.throws(()=>configure({COVE_FULL_UI_FOREGROUND_GATE:value}));
  const baseline={COVE_FULL_UI_MOTION_SWITCH:'1'},gated={...baseline,COVE_FULL_UI_FOREGROUND_GATE:'1'};
  configure(baseline);configure(gated);assert.equal(baseline.COVE_FULL_UI_FOREGROUND_GATE,'0');
  for(const key of Object.keys(baseline))if(key!=='COVE_FULL_UI_FOREGROUND_GATE')assert.equal(gated[key],baseline[key],key);
});
test('gate writes only fixed safe metadata beside result, asynchronously polls and validates immediately after release',async()=>{
  const f=fixture(),state=await f.run();assert.deepEqual(f.waits,[50,50,50]);assert.equal(f.validated(),1);
  assert.equal(state.actualWaitMs,150);assert.equal(state.status,'continued');assert.equal(state.continued,true);assert.equal(state.verified,true);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].file,path.join(directory,READY_FILE));assert.deepEqual(f.writes[0].options,{flag:'wx'});
  assert.deepEqual(JSON.parse(f.writes[0].value),{schemaVersion:1,stage:'before-initial-screen-share',timeoutMs:60000,pollMs:50,continueFile:'foreground-continue'});
  assert.equal(f.updates[0].status,'waiting');assert.equal(f.updates.at(-1).status,'continued');
  assert.equal(TIMEOUT_MS,60000);assert.equal(POLL_MS,50);
});
test('gate times out at 60 seconds without starting capture or hiding a presentation rejection',async()=>{
  const timeout=fixture({releaseAt:Infinity});await assert.rejects(timeout.run(),/timed out after 60 seconds/);
  assert.equal(timeout.waits.length,1200);assert.ok(timeout.waits.every(ms=>ms===50));assert.equal(timeout.validated(),0);
  assert.equal(timeout.updates.at(-1).actualWaitMs,60000);assert.equal(timeout.updates.at(-1).status,'timed-out');
  const rejection=Error('original foreground geometry guard rejected'),lost=fixture({validationError:rejection});
  await assert.rejects(lost.run(),error=>error===rejection);assert.equal(lost.updates.at(-1).verified,false);
  assert.equal(lost.updates.at(-1).continued,true);assert.equal(lost.updates.at(-1).status,'failed');
});
test('stale, non-file and cancelled continuation cannot pass the publication barrier',async()=>{
  const stale=fixture({stale:true});await assert.rejects(stale.run(),/existed before readiness/);assert.equal(stale.writes.length,0);
  const nonFile=fixture({regular:false});await assert.rejects(nonFile.run(),/regular file/);assert.equal(nonFile.validated(),0);
  for(const args of [{cancelAt:100},{cancelOnRelease:true}]){
    const cancelled=fixture(args);await assert.rejects(cancelled.run(),/cancelled before screen sharing/);
    assert.equal(cancelled.validated(),0);assert.equal(cancelled.updates.at(-1).status,'cancelled');
  }
});
test('adapter locates gate after reader qualification in the actual result directory and retains every original guard/watchdog',()=>{
  const original=fs.readFileSync(path.join(adapters.root,'apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8');
  const source=adapters.electron(original);assert.doesNotThrow(()=>new vm.Script(source));
  const startup=source.indexOf('const startup=await waitVisiblePresentationStartup('),reader=source.indexOf('if(!readerCheck.passed)'),
    gate=source.indexOf('if(fullUiForegroundGate){await waitForForegroundGate('),capture=source.indexOf("await startOwnedScreenShare(sender,config,'initial-publication-returned');");
  assert.ok(startup>0&&reader>startup&&gate>reader&&capture>gate);
  const gateStatement=source.slice(gate,source.indexOf('\n',gate));
  assert.match(gateStatement,/\{directory,validate:\(\)=>assertOwnedVisiblePresentation\(\),isCancelled:\(\)=>finished\|\|shuttingDown\|\|fullUiMain\?\.isCancelled\(\)===true/);
  assert.equal(/\.focus\(|\.show\(|\.moveTop\(|\.setBounds\(/.test(gateStatement),false);
  for(const marker of ["directory=path.resolve(process.env.COVE_FPS_RUN_DIR||'')","path.join(directory,'result.json')",
    "setTimeout(()=>void finish(Error('Performance watchdog expired')),330000)",'rejectOwnedVisiblePresentation(\'sampling\',state)',
    "if(!startup.established)rejectOwnedVisiblePresentation('startup',startup.state)",'if(!readerCheck.passed)'])assert.ok(source.includes(marker),marker);
  const launcher=adapters.launcher(fs.readFileSync(path.join(adapters.root,'tooling/verify-screen-performance.cjs'),'utf8'));
  assert.ok(launcher.includes("foregroundGate:{enabled:process.env.COVE_FULL_UI_FOREGROUND_GATE==='1',timeoutMs:60000,pollMs:50}"));
  assert.ok(launcher.includes("setTimeout(()=>reject(Error('Performance measurement timeout')),360000)"));
});
test('actual owned Escape flag cancels the gate poll and wins over marker or late validation completion',async()=>{
  const owned=fs.readFileSync(path.join(__dirname,'owned-main.cjs'),'utf8');
  const getter=owned.match(/isCancelled\(\)\{return state\.inputIsolation\.abortRequested===true;\}/)?.[0];assert.ok(getter);
  const escape=owned.match(/wc\.on\('before-input-event',\(event,input\)=>\{([\s\S]*?)\n    \}\);/)?.[1];assert.ok(escape);
  const adapted=adapters.electron(fs.readFileSync(path.join(adapters.root,'apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8'));
  const callback=adapted.match(/isCancelled:\(\)=>finished\|\|shuttingDown\|\|fullUiMain\?\.isCancelled\(\)===true/)?.[0];assert.ok(callback);
  for(const point of ['poll','marker','validation']){
    let clock=0,ready=false,continued=false,validations=0,published=0,prevented=0;
    const state={inputIsolation:{abortRequested:false,blockedKeyboard:0}};
    const fullUiMain=vm.runInNewContext('({'+getter+'})',{state});
    const cancel=()=>vm.runInNewContext(escape,{state,event:{preventDefault(){prevented++;}},input:{type:'keyDown',key:'Escape'}});
    const isCancelled=vm.runInNewContext('({'+callback+'}).isCancelled',{finished:false,shuttingDown:false,fullUiMain});
    const files={async lstat(){
      if(!ready)throw Object.assign(Error('missing'),{code:'ENOENT'});
      if(point==='marker'){continued=true;await Promise.resolve();cancel();}
      if(continued)return {isFile:()=>true};
      throw Object.assign(Error('missing'),{code:'ENOENT'});
    },async writeFile(){ready=true;}};
    await assert.rejects((async()=>{
      await waitForForegroundGate({directory,files,now:()=>clock,isCancelled,
        delay:async ms=>{clock+=ms;if(point==='poll')cancel();else continued=true;},
        validate:async()=>{validations++;if(point==='validation'){await Promise.resolve();cancel();}}});published++;
    })(),/cancelled before screen sharing/);
    assert.equal(published,0);assert.equal(clock<=50,true);assert.equal(prevented,1);
    assert.equal(validations,point==='validation'?1:0);assert.equal(fullUiMain.isCancelled(),true);
  }
});
test('Escape after gate completion but during preference awaits cannot start the initial capture',async()=>{
  const adapted=adapters.electron(fs.readFileSync(path.join(adapters.root,'apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8'));
  const start=adapted.indexOf('      const fullUiCompatibilityTarget=Boolean(config.compatibility);');
  const end=adapted.indexOf("await startOwnedScreenShare(sender,config,'initial-publication-returned');",start)+"await startOwnedScreenShare(sender,config,'initial-publication-returned');".length;
  const code=adapted.slice(start,end);assert.ok(code.includes('fullUiMain?.isCancelled()===true'));
  for(const late of ['setter','preference-ready']){
    let cancelled=false,published=0;
    await assert.rejects(vm.runInNewContext('(async()=>{'+code+'})()',{
      config:{compatibility:false},sender:{},fullUiForegroundGate:true,finished:false,shuttingDown:false,
      fullUiMain:{isCancelled:()=>cancelled},boundedJs:async()=>{if(late==='setter')cancelled=true;},
      wait:async()=>{if(late==='preference-ready')cancelled=true;},startOwnedScreenShare:async()=>{published++;},
    }),/cancelled before screen sharing/);
    assert.equal(published,0);
  }
});
