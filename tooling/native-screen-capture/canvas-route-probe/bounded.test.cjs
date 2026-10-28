'use strict';
// CPU state-machine tests. No Electron/native child/GPU or real wall timer.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const setup=require('./bounded-renderer.cjs'),{configuration,boundedRendererDrained}=require('./run.cjs');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function rgb(x,y,serial){
  if(y<2&&x<16){const g=(serial>>Math.floor(x/2))&1?224:32;return[g,g,g];}
  const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0]];
  if(y>=24&&y<40){const g=[0,32,64,96,128,160,192,255][Math.floor(x/8)];return[g,g,g];}
  if(y>=44&&y<52)return colors[Math.floor(x/8)];if(y>=52&&y<60)return colors[(y%2)*2+x%2];
  return colors[(y>=32?2:0)+(x>=32?1:0)];
}
function bytesFor(serial){
  const bytes=new Uint8Array(6144),q=v=>Math.floor(Math.max(0,Math.min(255,v))+.5);
  const yuv=([r,g,b])=>{r/=255;g/=255;b/=255;const y=.2126*r+.7152*g+.0722*b;
    return[q(16+219*y),q(128+224*(b-y)/(2*(1-.0722))),q(128+224*(r-y)/(2*(1-.2126)))];};
  if(serial===0){bytes.fill(16,0,4096);bytes.fill(128,4096);return bytes;}
  for(let y=0;y<64;y++)for(let x=0;x<64;x++)bytes[y*64+x]=yuv(rgb(x,y,serial))[0];
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const p=[0,0,0];for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const c=rgb(x*2+dx,y*2+dy,serial);for(let n=0;n<3;n++)p[n]+=c[n]/4;}
    const [,u,v]=yuv(p);bytes.set([u,v],4096+y*64+x*2);
  }return bytes;
}
function harness({manualMessages=false,sinkMode='direct',detachCpuBuffer=true,canvasPlacement='attached'}={}){
  let listener,waiting,cancelled=false,writerClosed=false,settingsReady=false;const packets=[],calls=[],writes=[],messageTasks=[],timers=new Set();
  const reader={read(){if(packets.length)return Promise.resolve(packets.shift());if(cancelled)return Promise.resolve({done:true});return new Promise(resolve=>{waiting=resolve;});},
    cancel(){cancelled=true;waiting?.({done:true});waiting=null;return Promise.resolve();},releaseLock(){calls.push('reader-release');}};
  const track={requestFrame(){calls.push('request');},stop(){calls.push('track-stop');}};
  const context2d={getContextAttributes:()=>({alpha:false,willReadFrequently:false,colorSpace:'srgb'}),
    drawImage(){calls.push('draw');},fillRect(){calls.push('prime-black');}};
  const canvas={isConnected:false,style:{display:'',visibility:'',opacity:''},getContext:()=>context2d,
    captureStream(fps){assert.equal(fps,0);return{getVideoTracks:()=>[track]};},remove(){this.isConnected=false;calls.push('canvas-remove');}};
  function Processor(options){assert.equal(options.track,track);assert.equal(options.maxBufferSize,1);this.readable={getReader:()=>reader};}
  const writer={ready:Promise.resolve(),write(frame){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    writes.push({frame,complete(){settingsReady=true;resolve();},reject});return promise;},
    close(){writerClosed=true;return Promise.resolve();},releaseLock(){calls.push('writer-release');}};
  function Generator(options){assert.equal(options.kind,'video');calls.push('generator-create');this.writable={getWriter:()=>writer};this.stop=()=>calls.push('generator-stop');
    this.getSettings=()=>settingsReady?{width:64,height:64,frameRate:120}:{};}
  function Frame(data,init){
    this.closed=false;this.timestamp=init.timestamp;this.close=()=>{this.closed=true;};
    if(data instanceof ArrayBuffer){assert.deepEqual(Array.from(init.transfer),[data]);assert.equal(init.layout.length,2);
      this.data=detachCpuBuffer?structuredClone(data,{transfer:init.transfer}):data.slice(0);
      this.format=init.format;this.codedWidth=init.codedWidth;this.codedHeight=init.codedHeight;this.colorSpace=init.colorSpace;
    }else{this.source=data;this.format=data.format;this.codedWidth=data.codedWidth;this.codedHeight=data.codedHeight;this.colorSpace=data.colorSpace;}
  }
  function Channel(){const port1={onmessage:null,closed:false,close(){this.closed=true;}},port2={closed:false,close(){this.closed=true;},
    postMessage(){calls.push('admission-post');const task=()=>{if(!port1.closed&&!port2.closed)port1.onmessage?.();};
      if(manualMessages)messageTasks.push(task);else setImmediate(task);}};
    this.port1=port1;this.port2=port2;}
  const context=vm.createContext({window:{coveNativeScreen:{supported:true,onFrame(_id,callback){listener=callback;return()=>{listener=null;};}}},
    document:{createElement:()=>canvas,body:{append(value){assert.equal(value,canvas);canvas.isConnected=true;calls.push('canvas-append');}}},crossOriginIsolated:false,ArrayBuffer,Uint8Array,VideoFrame:Frame,
    MediaStreamTrackProcessor:Processor,MediaStreamTrackGenerator:Generator,MessageChannel:Channel,performance:{now:()=>performance.now()},
    setTimeout(callback){timers.add(callback);return callback;},clearTimeout(callback){timers.delete(callback);}});
  const api=vm.runInContext('('+setup.toString()+')',context)('bounded_test',{width:64,height:64,frames:24,poolSize:3,boundedSink:sinkMode,canvasPlacement});
  const input=serial=>{
    const frame={format:'BGRA',codedWidth:64,codedHeight:64,displayWidth:64,displayHeight:64,timestamp:serial*1000,
      colorSpace:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true},closed:false,close(){this.closed=true;calls.push('source-close');}};
    const item={frame,settled:false};item.promise=listener(frame,{requestId:'bounded_test',serial,slot:(serial-1)%3,width:64,height:64,timestamp:serial*1000})
      .then(()=>{item.settled=true;});return item;
  };
  const output=(serial,timestamp=serial*10000+100)=>{
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const record={buffer:null,closed:false};
    const frame={format:'NV12',codedWidth:64,codedHeight:64,displayWidth:64,displayHeight:64,timestamp,
      colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false},allocationSize:()=>6144,
      copyTo(buffer){record.buffer=buffer;return promise;},close(){record.closed=true;}};
    record.complete=()=>{new Uint8Array(record.buffer).set(bytesFor(serial));resolve([{offset:0,stride:64},{offset:4096,stride:64}]);};record.reject=reject;
    const packet={done:false,value:frame};if(waiting){const callback=waiting;waiting=null;callback(packet);}else packets.push(packet);return record;
  };
  return{api,input,output,writes,calls,state:()=>context.window.__coveCanvasRoute,cleanup:()=>context.window.__coveCanvasRouteCleanup(),
    timeout(){const callback=[...timers][0];assert.ok(callback);callback();},flushMessages(){for(const task of messageTasks.splice(0))task();},writerClosed:()=>writerClosed};
}
async function prime(probe){const frame=probe.output(0);await turn();frame.complete();await turn();assert.equal(probe.state().result.bounded.primed,true);}
async function finishOutput(probe,serial,timestamp){const frame=probe.output(serial,timestamp);await turn();frame.complete();await turn();
  assert.equal(frame.closed,false);probe.writes.at(-1).complete();await turn();return frame;}

test('bounded stage is finite1728x1080/120 and explicitly accepts selected helper',()=>{
  const config=configuration(['--stage','bounded','--helper','runtime/nv12-shader-probe/readback-helper-hires.exe'],false);
  assert.equal(config.width,1728);assert.equal(config.height,1080);assert.equal(config.frames,120);assert.equal(config.poolSize,3);
  assert.match(config.helper,/readback-helper-hires\.exe$/);
  assert.equal(config.boundedSink,'direct');
  assert.equal(config.visibility,'hidden');assert.equal(configuration(['--stage','bounded','--visibility','visible'],false).visibility,'visible');
  assert.equal(config.canvasPlacement,'attached');assert.equal(configuration(['--stage','bounded','--canvas-placement','detached'],false).canvasPlacement,'detached');
  assert.throws(()=>configuration(['--stage','paced','--canvas-placement','detached'],false));
  for(const visibility of ['visible-then-hidden','visible-then-minimized']){
    assert.equal(configuration(['--stage','bounded','--visibility',visibility],false).visibility,visibility);
    assert.throws(()=>configuration(['--stage','paced','--visibility',visibility],false));
  }
  assert.throws(()=>configuration(['--visibility','other'],false));
  for(const sink of ['none','direct','cpu','timestamp'])assert.equal(configuration(['--stage','bounded','--bounded-sink',sink],false).boundedSink,sink);
  assert.throws(()=>configuration(['--stage','paced','--bounded-sink','none'],false));
  assert.throws(()=>configuration(['--stage','bounded','--bounded-sink','other'],false));
});
test('detached placement omits only DOM append and preserves prime, one credit and actual Generator write',async()=>{
  const p=harness({canvasPlacement:'detached'});assert.equal(p.calls.includes('canvas-append'),false);
  const connection=p.state().result.canvasConnection;assert.equal(connection.placement,'detached');assert.equal(connection.isConnected,false);
  assert.equal(connection.width,64);assert.equal(connection.height,64);assert.equal(connection.displayStyle,'');assert.equal(connection.opacityStyle,'');
  await prime(p);await p.input(1).promise;await finishOutput(p,1);
  assert.equal(p.state().result.bounded.creditsGranted,1);assert.equal(p.writes.length,1);await p.cleanup();
  assert.equal(p.state().result.canvasConnection.isConnectedAfterCleanup,false);
});
test('no-writer control retains identical prime/admission/copy but constructs no Generator',async()=>{
  const p=harness({sinkMode:'none'});await prime(p);await p.input(1).promise;const output=p.output(1);await turn();output.complete();await turn();
  assert.equal(p.calls.includes('generator-create'),false);assert.equal(p.writes.length,0);assert.equal(output.closed,true);
  const b=p.state().result.bounded;assert.deepEqual(Array.from(b.completedSerials),[1]);assert.equal(b.writtenSerials.length,0);assert.equal(b.creditsGranted,1);
  assert.equal((await p.cleanup()).writerClosed,null);
});
test('CPU control transfers copied planes and closes original Canvas output before real writer call',async()=>{
  const p=harness({sinkMode:'cpu'});await prime(p);await p.input(1).promise;const output=p.output(1);await turn();output.complete();await turn();
  assert.equal(output.closed,true);assert.equal(output.buffer.byteLength,0);assert.equal(p.writes.length,1);
  const frame=p.writes[0].frame;assert.equal(frame.format,'NV12');assert.equal(frame.colorSpace.matrix,'bt709');assert.equal(frame.timestamp,10100);
  assert.equal(frame.closed,false);assert.deepEqual(new Uint8Array(frame.data),bytesFor(1));assert.equal(p.state().result.bounded.creditsGranted,0);
  p.writes[0].complete();await turn();assert.equal(frame.closed,true);assert.equal(p.state().result.bounded.creditsGranted,1);
  assert.equal(p.state().result.bounded.copyBuffersTransferred,1);assert.equal(p.state().result.bounded.sourceOutputsClosedBeforeWrite,1);await p.cleanup();
});
test('unsupported CPU transfer fails instead of claiming independent transferred ownership',async()=>{
  const p=harness({sinkMode:'cpu',detachCpuBuffer:false});await prime(p);p.input(1);const output=p.output(1);await turn();output.complete();await turn();
  assert.equal(p.state().errorCode,'canvas_cpu_frame_transfer_required');assert.equal(p.writes.length,0);assert.equal(output.closed,true);
  assert.equal(p.state().result.bounded.creditsGranted,0);assert.ok(new Uint8Array(output.buffer).every(v=>v===0));await p.cleanup();
});
test('timestamp control creates a pixel-sharing handle, closes original, and records native timestamp',async()=>{
  const p=harness({sinkMode:'timestamp'});await prime(p);p.input(1);const output=p.output(1);await turn();output.complete();await turn();
  assert.equal(output.closed,true);assert.equal(output.buffer.byteLength,6144);const frame=p.writes[0].frame;
  assert.equal(frame.timestamp,1000);assert.ok(frame.source);assert.equal(frame.closed,false);
  p.writes[0].complete();await turn();assert.equal(frame.closed,true);assert.equal(p.state().result.bounded.writes[0].writerFrameTimestampUs,1000);await p.cleanup();
});
test('prime occurs in setup task before native admission and mints no generator credit',async()=>{
  const p=harness();assert.equal(p.api.status,'priming');assert.deepEqual(p.calls.slice(-2),['request','prime-black']);
  await prime(p);assert.equal(p.writes.length,0);assert.equal(p.state().result.bounded.creditsGranted,0);
  const c=await p.cleanup();assert.equal(c.pendingCanvasAdmissions,0);assert.equal(c.writerClosed,true);
});
test('one admitted draw resolves immediately; one replaceable pending native frame retains callback',async()=>{
  const p=harness();await prime(p);const first=p.input(1);await first.promise;assert.equal(first.frame.closed,true);assert.equal(p.writes.length,0);
  const second=p.input(2);await turn();assert.equal(second.frame.closed,false);assert.equal(second.settled,false);
  const third=p.input(3);await second.promise;assert.equal(second.frame.closed,true);assert.equal(third.frame.closed,false);
  assert.deepEqual(Array.from(p.state().result.bounded.supersededSerials),[2]);
  const output=p.output(1);await turn();output.complete();await turn();assert.equal(p.state().result.bounded.creditsGranted,0);
  assert.equal(third.frame.closed,false);assert.equal(output.closed,false);
  p.writes[0].complete();await third.promise;await turn();assert.equal(output.closed,true);assert.equal(p.state().result.bounded.creditsGranted,1);
  assert.equal(third.frame.closed,true);await finishOutput(p,3);
  const b=p.state().result.bounded;assert.equal(b.maxCanvasAdmissions,1);assert.equal(b.maxPendingInputs,1);assert.equal(b.maxWrites,1);
  assert.deepEqual(Array.from(b.writtenSerials),[1,3]);const cleanup=await p.cleanup();assert.equal(cleanup.pendingCanvasAdmissions,0);assert.equal(cleanup.callbacks,0);
});
test('pending draw spends credit in a new message task, and task cancellation releases the retained source',async()=>{
  const p=harness({manualMessages:true});await prime(p);p.input(1);const waiting=p.input(2),output=p.output(1);await turn();output.complete();await turn();
  p.writes[0].complete();await turn();
  assert.equal(p.state().result.bounded.pendingAdmissionTask,true);assert.equal(waiting.frame.closed,false);
  assert.equal(p.calls.filter(c=>c==='draw').length,1);assert.equal(p.state().result.bounded.creditsGranted,1);
  const cleanup=await p.cleanup();await waiting.promise;p.flushMessages();await turn();
  assert.equal(p.calls.filter(c=>c==='draw').length,1);assert.equal(waiting.frame.closed,true);
  assert.equal(cleanup.pendingAdmissionTasks,0);assert.equal(cleanup.admissionPortsClosed,true);
});
test('native done and output quiet cannot drain an active or scheduled Canvas admission',()=>{
  const renderer={inputs:[{}],bounded:{primed:true,pendingAdmissionTask:false,creditsGranted:0,receipts:[{}],supersededSerials:[]}};
  assert.equal(boundedRendererDrained(renderer),false);renderer.bounded.creditsGranted=1;
  assert.equal(boundedRendererDrained(renderer),true);renderer.bounded.pendingAdmissionTask=true;
  assert.equal(boundedRendererDrained(renderer),false);renderer.bounded.pendingAdmissionTask=false;renderer.bounded.receipts.push({});
  assert.equal(boundedRendererDrained(renderer),false);
});
test('initial black refresh and old output timestamp never mint replacement credits',async()=>{
  const p=harness();await prime(p);p.input(1);let output=p.output(0);await turn();output.complete();await turn();
  assert.equal(p.state().result.bounded.creditsGranted,0);assert.equal(p.writes.length,0);await finishOutput(p,1);
  const pending=p.input(2);await pending.promise;output=p.output(1);await turn();output.complete();await turn();
  assert.equal(p.state().result.bounded.creditsGranted,1);assert.equal(p.writes.length,1);assert.equal(p.state().result.duplicateOutputs,2);
  await finishOutput(p,2);await p.cleanup();
});
test('strictly-new output without an admission fails and cannot mint a credit',async()=>{
  const p=harness();await prime(p);p.input(1);await finishOutput(p,1);const output=p.output(1,99999);await turn();output.complete();await turn();
  assert.equal(p.state().errorCode,'canvas_bounded_output_without_admission');assert.equal(p.state().result.bounded.creditsGranted,1);await p.cleanup();
});
test('fixture correlation rejects new timestamp for a pending rather than admitted input',async()=>{
  const p=harness();await prime(p);p.input(1);const waiting=p.input(2);const output=p.output(2);await turn();output.complete();await turn();
  assert.equal(p.state().status,'failed');assert.equal(p.state().result.bounded.creditsGranted,0);await waiting.promise;assert.equal(waiting.frame.closed,true);await p.cleanup();
});
test('timeout retires admission and closes pending source without inventing completion',async()=>{
  const p=harness();await prime(p);p.input(1);const waiting=p.input(2);p.timeout();await waiting.promise;
  assert.equal(p.state().errorCode,'canvas_bounded_completion_timeout');assert.equal(p.state().result.bounded.creditsGranted,0);
  assert.equal(waiting.frame.closed,true);const cleanup=await p.cleanup();assert.equal(cleanup.callbacks,0);assert.equal(cleanup.pendingCanvasAdmissions,1);
});
test('cleanup closes pending native frame then waits for actual copy and generator write settlement',async()=>{
  const p=harness();await prime(p);p.input(1);const output=p.output(1);await turn();output.complete();await turn();const waiting=p.input(2);
  let cleaned=false;const cleaning=p.cleanup().then(value=>{cleaned=true;return value;});await waiting.promise;await turn();
  assert.equal(waiting.frame.closed,true);assert.equal(cleaned,false);assert.equal(output.closed,false);assert.equal(p.writerClosed(),false);
  p.writes[0].complete();const cleanup=await cleaning;assert.equal(output.closed,true);assert.equal(cleanup.pendingWrites,0);assert.equal(cleanup.pendingCopies,0);
  assert.equal(cleanup.writerClosed,true);assert.equal(p.state().result.bounded.creditsGranted,0);assert.ok(new Uint8Array(output.buffer).every(v=>v===0));
});
test('real writer failure discovered while draining remains failed and output closes after rejection',async()=>{
  const p=harness();await prime(p);p.input(1);const output=p.output(1);await turn();output.complete();await turn();const cleaning=p.cleanup();
  assert.equal(output.closed,false);p.writes[0].reject(new Error('synthetic_writer_failed'));const cleanup=await cleaning;
  assert.equal(cleanup.status,'failed');assert.equal(cleanup.errorCode,'synthetic_writer_failed');assert.equal(output.closed,true);assert.equal(cleanup.pendingWrites,0);
});
