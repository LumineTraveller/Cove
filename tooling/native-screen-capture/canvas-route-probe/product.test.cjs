'use strict';
// CPU-only integration against the actual, freshly transpiled product module.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const setup=require('./product-renderer.cjs');
const {configuration,compileProductModule,productRendererDrained,waitForRendererPrime,productStartupTimeline,stats}=require('./run.cjs');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function payload(serial){
  const bytes=new Uint8Array(6144),q=v=>Math.floor(Math.max(0,Math.min(255,v))+.5);
  function rgb(x,y){
    if(y<2&&x<16){const g=(serial>>Math.floor(x/2))&1?224:32;return[g,g,g];}
    const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0]];
    if(y>=24&&y<40){const g=[0,32,64,96,128,160,192,255][Math.floor(x/8)];return[g,g,g];}
    if(y>=44&&y<52)return colors[Math.floor(x/8)];if(y>=52&&y<60)return colors[(y%2)*2+x%2];
    return colors[(y>=32?2:0)+(x>=32?1:0)];
  }
  const yuv=([r,g,b])=>{r/=255;g/=255;b/=255;const y=.2126*r+.7152*g+.0722*b;
    return[q(16+219*y),q(128+224*(b-y)/(2*(1-.0722))),q(128+224*(r-y)/(2*(1-.2126)))];};
  if(serial===0){bytes.fill(16,0,4096);bytes.fill(128,4096);return bytes;}
  for(let y=0;y<64;y++)for(let x=0;x<64;x++)bytes[y*64+x]=yuv(rgb(x,y))[0];
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const c=[0,0,0];for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
    const p=rgb(x*2+dx,y*2+dy);for(let n=0;n<3;n++)c[n]+=p[n]/4;}
    const[,u,v]=yuv(c);bytes.set([u,v],4096+y*64+x*2);}
  return bytes;
}
function harness({holdValidation=false,sourceStart='after-prime',now}={}){
  let time=0,nextAdmissionTimer=0;const clock=now??(()=>time),admissionTimers=new Map();
  const setAdmissionTimer=(callback,delayMs)=>{const id=++nextAdmissionTimer;admissionTimers.set(id,{callback,dueAt:clock()+delayMs});return id;};
  const clearAdmissionTimer=id=>admissionTimers.delete(id);
  const flushAdmissionTimers=()=>{for(const[id,timer]of[...admissionTimers])if(timer.dueAt<=clock()){
    admissionTimers.delete(id);timer.callback();}};
  let listener,waiting,cancelled=false,writerClosed=false;const packets=[],messages=[],timers=new Set(),calls=[],writes=[],validationCopies=[];
  const reader={read(){if(packets.length)return Promise.resolve(packets.shift());if(cancelled)return Promise.resolve({done:true});return new Promise(resolve=>waiting=resolve);},
    cancel(){cancelled=true;waiting?.({done:true});waiting=null;return Promise.resolve();},releaseLock(){calls.push('reader-release');}};
  const track={requestFrame(){calls.push('request');},stop(){calls.push('track-stop');}};
  const canvas={width:64,height:64,isConnected:false,remove(){calls.push('canvas-remove');},
    getContext:()=>({getContextAttributes:()=>({alpha:false,willReadFrequently:false}),fillRect(){calls.push('black');},drawImage(frame){calls.push('draw-'+frame.serial);}}),
    captureStream:()=>({getVideoTracks:()=>[track],getTracks:()=>[track]})};
  function Processor(){this.readable={getReader:()=>reader};}
  function Channel(){this.port1={onmessage:null,close(){}};this.port2={close(){},postMessage:id=>messages.push(()=>this.port1.onmessage?.({data:id}))};}
  const writer={write(frame){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});writes.push({frame,complete:resolve,reject});return promise;},
    close(){writerClosed=true;return Promise.resolve();},releaseLock(){}};
  function Generator(){this.writable={getWriter:()=>writer};this.stop=()=>calls.push('generator-stop');this.getSettings=()=>writes.length?{width:64,height:64,frameRate:30}:{};}
  function Frame(buffer,init){this.data=new Uint8Array(buffer.slice(0));this.format=init.format;this.timestamp=init.timestamp;
    this.codedWidth=this.displayWidth=init.codedWidth;this.codedHeight=this.displayHeight=init.codedHeight;
    this.colorSpace=init.colorSpace;this.closed=false;this.allocationSize=()=>6144;
    this.copyTo=target=>{new Uint8Array(target).set(this.data);const layout=[{offset:0,stride:64},{offset:4096,stride:64}];
      return init.layout&&holdValidation?new Promise(resolve=>validationCopies.push(()=>resolve(layout))):Promise.resolve(layout);};
    this.close=()=>{this.closed=true;};}
  const context=vm.createContext({window:{coveNativeScreen:{supported:true,onFrame(_id,callback){listener=callback;return()=>listener=null;}},
      setTimeout:setAdmissionTimer,clearTimeout:clearAdmissionTimer},
    document:{createElement:()=>canvas},crossOriginIsolated:false,ArrayBuffer,Uint8Array,VideoFrame:Frame,MediaStreamTrackGenerator:Generator,
    MediaStreamTrackProcessor:Processor,MessageChannel:Channel,performance:{now:clock,timeOrigin:performance.timeOrigin},
    setTimeout(callback){timers.add(callback);return callback;},clearTimeout(callback){timers.delete(callback);}});
  const module=vm.runInContext(compileProductModule().expression,context);
  const api=vm.runInContext('('+setup.toString()+')',context)('product_test',{width:64,height:64,frames:24,poolSize:3,canvasPlacement:'detached',productSourceStart:sourceStart},module);
  const input=serial=>{
    const frame={serial,format:'BGRA',codedWidth:64,codedHeight:64,displayWidth:64,displayHeight:64,timestamp:serial*1000,
      colorSpace:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true},closed:false,close(){this.closed=true;calls.push('input-close-'+serial);}};
    return{frame,promise:listener(frame,{requestId:'product_test',serial,slot:(serial-1)%3,width:64,height:64,timestamp:serial*1000})};
  };
  const output=(serial,timestamp=serial*10000+100)=>{
    const frame=new Frame(payload(serial).buffer,{format:'NV12',codedWidth:64,codedHeight:64,timestamp,
      colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}});
    const packet={done:false,value:frame};if(waiting){const resolve=waiting;waiting=null;resolve(packet);}else packets.push(packet);return frame;
  };
  return{api,input,output,writes,calls,state:()=>context.window.__coveCanvasRoute,cleanup:()=>context.window.__coveCanvasRouteCleanup(),
    finishValidation(){for(const complete of validationCopies.splice(0))complete();},
    flushAdmissionTimers,pendingAdmissionTimers:()=>admissionTimers.size,
    flushMessages(){for(const task of messages.splice(0))task();
      // The default clock drains only admission wakes. Completion deadlines
      // stay explicit; a supplied clock lets a test inspect the delayed state.
      while(!now&&admissionTimers.size){time=Math.max(time,Math.min(...[...admissionTimers.values()].map(timer=>timer.dueAt)));
        flushAdmissionTimers();for(const task of messages.splice(0))task();}},
    timeout(){const callback=[...timers][0];assert.ok(callback);callback();},writerClosed:()=>writerClosed};
}
async function prime(p){p.output(0);await turn();assert.equal(p.state().result.product.primed,true);}
test('product stage compiles the current self-contained source and keeps actual detached after-prime default',()=>{
  const c=configuration(['--stage','product'],false);assert.equal(c.width,1728);assert.equal(c.frames,120);
  assert.equal(c.canvasPlacement,'detached');assert.equal(c.productSourceStart,'after-prime');
  assert.throws(()=>configuration(['--stage','product','--canvas-placement','attached'],false));
  assert.throws(()=>configuration(['--stage','product','--bounded-sink','direct'],false));
  const compiled=compileProductModule();assert.match(compiled.sourceSha256,/^[a-f0-9]{64}$/);assert.match(compiled.compiledSha256,/^[a-f0-9]{64}$/);
  const exports=vm.runInNewContext(compiled.expression);assert.equal(typeof exports.createNativeCanvasFrameSink,'function');
  assert.equal(stats([null,undefined,1]).count,1);
});
test('eager skips only the product ready gate and rejects unrelated stages or visibility transitions',()=>{
  const normal=configuration(['--stage','product'],false),eager=configuration(['--stage','product','--product-source-start','eager'],false);
  assert.equal(waitForRendererPrime(normal),true);assert.equal(waitForRendererPrime(eager),false);
  assert.deepEqual({...eager,productSourceStart:'after-prime'},normal);
  assert.equal(waitForRendererPrime(configuration(['--stage','bounded'],false)),true);
  for(const stage of ['mechanism','paced','bounded'])assert.throws(()=>configuration(['--stage',stage,'--product-source-start','eager'],false),/requires_product_stage/);
  assert.throws(()=>configuration(['--stage','product','--product-source-start','later'],false),/invalid_canvas_product_source_start/);
  assert.throws(()=>configuration(['--stage','product','--product-source-start','eager','--visibility','visible-then-hidden'],false),/requires_stable_visibility/);
});
test('eager observes real pre-prime inputs without admitting them before the actual module prime',async()=>{
  let time=0;const p=harness({sourceStart:'eager',now:()=>time});
  assert.equal(p.calls.includes('black'),true);assert.equal(p.state().result.product.primed,false);
  time=1;const a=p.input(1);time=2;const b=p.input(2);await a.promise;
  assert.equal(a.frame.closed,true);assert.equal(b.frame.closed,false);p.flushMessages();
  assert.equal(p.calls.some(call=>call.startsWith('draw-')),false);
  time=3;await prime(p);time=4;p.flushMessages();
  assert.equal(b.frame.closed,false);assert.equal(p.calls.includes('draw-2'),false);assert.equal(p.pendingAdmissionTimers(),1);
  time=5;p.flushAdmissionTimers();assert.equal(p.calls.includes('draw-2'),false,'the timer only posts the original admission task');
  p.flushMessages();await b.promise;assert.equal(p.pendingAdmissionTimers(),0);
  assert.equal(b.frame.closed,true);assert.equal(p.calls.includes('draw-2'),true);assert.equal(p.calls.includes('draw-1'),false);
  const startup=p.state().result.product.startup;
  assert.equal(startup.moduleCreateStartedAtMs,0);assert.equal(startup.moduleCreatedAtMs,0);
  assert.equal(startup.firstInputAtMs,1);assert.equal(startup.firstInputBeforePrime,true);
  assert.equal(startup.firstInputModulePhase,'prime');assert.equal(startup.inputsBeforePrime,2);assert.equal(startup.primeReadyAtMs,3);
  p.output(2);await turn();assert.equal(p.writes.length,1);p.writes[0].complete();await turn();
  assert.equal(productRendererDrained(p.state().result),true);assert.equal((await p.cleanup()).pendingInputFrames,0);
});
test('startup timeline aligns process origins and preserves absent or unobserved startup events',()=>{
  const renderer={product:{sourceStart:'eager',startup:{timeOriginMs:1000,moduleCreateStartedAtMs:1,moduleCreatedAtMs:2,
    primeReadyAtMs:10,firstInputAtMs:12,firstInputBeforePrime:false,inputsBeforePrime:0}}};
  const timeline=productStartupTimeline(renderer,{timeOriginMs:900,spawnRequestedAtMs:104,spawnedAtMs:105,readyObservedAtMs:106,pacerStartedAtMs:107,firstOfferAtMs:111});
  assert.equal(timeline.moduleCreatedEpochMs,1002);assert.equal(timeline.sourceSpawnRequestedEpochMs,1004);
  assert.equal(timeline.primeReadyEpochMs,1010);assert.equal(timeline.firstSourceOfferEpochMs,1011);assert.equal(timeline.firstNativeInputEpochMs,1012);
  assert.equal(timeline.firstInputBeforePrime,false);assert.equal(timeline.inputsBeforePrime,0);
  const absent=productStartupTimeline(null,null);assert.equal(absent.primeReadyEpochMs,null);assert.equal(absent.firstInputBeforePrime,null);
});
test('actual product schedules idle admission; submit closes input after draw and writer preserves native timestamp',async()=>{
  const p=harness();assert.equal(p.api.status,'priming');await prime(p);
  const input=p.input(1);assert.equal(p.calls.includes('draw-1'),false);assert.equal(input.frame.closed,false);
  assert.equal(p.state().result.product.startup.firstInputBeforePrime,false);assert.equal(p.state().result.product.startup.inputsBeforePrime,0);
  p.flushMessages();await input.promise;assert.equal(input.frame.closed,true);assert.equal(p.calls.includes('draw-1'),true);
  const output=p.output(1);await turn();assert.equal(output.closed,true);assert.equal(p.writes.length,1);
  assert.equal(p.writes[0].frame.timestamp,1000);assert.equal(p.writes[0].frame.closed,false);
  assert.equal(p.state().result.outputs.length,0);p.writes[0].complete();await turn();
  assert.equal(p.writes[0].frame.closed,true);assert.equal(p.state().result.outputs[0].pixels.passed,true);
  assert.equal(p.state().result.outputs[0].outputTimestampUs,1000);assert.equal(productRendererDrained(p.state().result),true);
  const cleanup=await p.cleanup();assert.equal(cleanup.callbacks,0);assert.equal(cleanup.pendingCopies,0);assert.equal(cleanup.writerClosed,true);
  assert.equal(cleanup.readerStopped,null);assert.equal(cleanup.modulePrivateDrainObservable,false);
});
test('superseded original input closes without draw and all real writes remain bounded',async()=>{
  const p=harness();await prime(p);const a=p.input(1),b=p.input(2);await a.promise;assert.equal(a.frame.closed,true);
  p.flushMessages();await b.promise;assert.equal(b.frame.closed,true);p.output(2);await turn();
  assert.equal(p.writes.length,1);p.writes[0].complete();await turn();
  assert.deepEqual(Array.from(p.state().result.product.submissions,s=>s.result),['superseded','drawn']);
  assert.equal(p.state().result.product.maxWrites,1);await p.cleanup();
});
test('capture timeout propagates fixed product code and stop settles a retained pending source',async()=>{
  const p=harness();await prime(p);const a=p.input(1);p.flushMessages();await a.promise;const b=p.input(2);
  p.timeout();await b.promise;assert.equal(b.frame.closed,true);assert.equal(p.state().errorCode,'canvas_product_capture_timeout');
  assert.equal(p.state().result.product.moduleFailures[0].code,'capture_timeout');
  const cleanup=await p.cleanup();assert.equal(cleanup.pendingInputFrames,0);assert.equal(cleanup.moduleStopCalled,true);
});
test('cleanup awaits the actual Generator write and never closes its frame early',async()=>{
  const p=harness();await prime(p);const a=p.input(1);p.flushMessages();await a.promise;p.output(1);await turn();
  const frame=p.writes[0].frame;let cleaned=false;const cleaning=p.cleanup().then(value=>{cleaned=true;return value;});await turn();
  assert.equal(cleaned,false);assert.equal(frame.closed,false);assert.equal(p.writerClosed(),false);
  p.writes[0].complete();const result=await cleaning;assert.equal(result.pendingWrites,0);assert.equal(frame.closed,true);assert.equal(result.writerClosed,true);
});
test('validation settling after a module timeout cannot reach Generator after retirement',async()=>{
  const p=harness({holdValidation:true});await prime(p);const input=p.input(1);p.flushMessages();await input.promise;
  p.output(1);await turn();assert.equal(p.state().result.product.validationCopies,1);assert.equal(p.writes.length,0);
  p.timeout();assert.equal(p.state().errorCode,'canvas_product_write_timeout');
  p.finishValidation();await turn();assert.equal(p.writes.length,0);const cleaned=await p.cleanup();
  assert.equal(cleaned.pendingCopies,0);assert.equal(cleaned.pendingWrites,0);assert.equal(cleaned.writerClosed,true);
});
