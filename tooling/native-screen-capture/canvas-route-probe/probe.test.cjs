'use strict';
// CPU-only contract tests: no Electron, D3D device, native process or desktop.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),http=require('node:http');
const {configuration,startServer,summarize,readyForNativeRelease}=require('./run.cjs');
const setup=require('./renderer.cjs');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const quantize=v=>Math.floor(Math.max(0,Math.min(255,v))+.5);
function source(x,y,serial){
  if(y<2&&x<16){const g=(serial>>Math.floor(x/2))&1?224:32;return[g,g,g];}
  const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0]];
  if(y>=24&&y<40){const g=[0,32,64,96,128,160,192,255][Math.floor(x/8)];return[g,g,g];}
  if(y>=44&&y<52)return colors[Math.floor(x/8)];if(y>=52&&y<60)return colors[(y%2)*2+x%2];
  return colors[(y>=32?2:0)+(x>=32?1:0)];
}
function payload(serial,format,matrix){
  const kr=matrix==='bt709'?.2126:.299,kb=matrix==='bt709'?.0722:.114;
  const yuv=([r,g,b])=>{r/=255;g/=255;b/=255;const y=kr*r+(1-kr-kb)*g+kb*b;
    return[quantize(16+219*y),quantize(128+224*(b-y)/(2*(1-kb))),quantize(128+224*(r-y)/(2*(1-kr)))];};
  const bytes=new Uint8Array(6144);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++)bytes[y*64+x]=yuv(source(x,y,serial))[0];
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const p=[0,0,0];for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const q=source(x*2+dx,y*2+dy,serial);for(let c=0;c<3;c++)p[c]+=q[c]/4;}
    const [_,u,v]=yuv(p);if(format==='NV12')bytes.set([u,v],4096+y*64+x*2);else{bytes[4096+y*32+x]=u;bytes[5120+y*32+x]=v;}
  }
  return bytes;
}
function harness({isolated=false}={}){
  let listener,waiting,readerCancelled=false;const packets=[],calls=[],outputFrames=[];
  const reader={read(){if(packets.length)return Promise.resolve(packets.shift());if(readerCancelled)return Promise.resolve({done:true});return new Promise(resolve=>{waiting=resolve;});},
    cancel(){readerCancelled=true;waiting?.({done:true});waiting=null;return Promise.resolve();},releaseLock(){calls.push('reader-release');}};
  const track={requestFrame(){calls.push('request');},stop(){calls.push('track-stop');},contentHint:''};
  const context2d={getContextAttributes(){return{alpha:false,willReadFrequently:false,colorSpace:'srgb'};},drawImage(){calls.push('draw');}};
  const canvas={getContext(type,options){assert.equal(type,'2d');assert.equal(options.alpha,false);assert.equal(options.willReadFrequently,false);return context2d;},
    captureStream(fps){assert.equal(fps,0);return{getVideoTracks:()=>[track]};},remove(){calls.push('canvas-remove');}};
  function Processor(options){assert.equal(options.track,track);assert.equal(options.maxBufferSize,3);this.readable={getReader:()=>reader};}
  const context=vm.createContext({window:{coveNativeScreen:{supported:true,onFrame:(_id,callback)=>{listener=callback;return()=>{listener=null;};}}},
    document:{createElement:()=>canvas,body:{append(){calls.push('append');}}},crossOriginIsolated:isolated,ArrayBuffer,Uint8Array,VideoFrame:function(){},
    MediaStreamTrackProcessor:Processor,performance:{now:()=>performance.now()},console});
  const api=vm.runInContext('('+setup.toString()+')',context)('canvas_test',{width:64,height:64,frames:24,poolSize:3});
  const input=(serial)=>{
    const frame={format:'BGRA',codedWidth:64,codedHeight:64,displayWidth:64,displayHeight:64,timestamp:serial*1000,
      colorSpace:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true},closed:false,
      close(){calls.push('source-close');this.closed=true;}};
    const returned=listener(frame,{requestId:'canvas_test',serial,slot:(serial-1)%3,width:64,height:64,timestamp:serial*1000});
    return{frame,returned};
  };
  const output=(serial,{format='NV12',matrix='bt709',pixelSerial=serial,layout=null}={})=>{
    let complete,reject;const copying=new Promise((yes,no)=>{complete=yes;reject=no;});
    const record={buffer:null,args:null,closed:false};
    const frame={format,codedWidth:64,codedHeight:64,displayWidth:64,displayHeight:64,timestamp:serial*8320,
      colorSpace:{primaries:'bt709',transfer:'bt709',matrix,fullRange:false},allocationSize(){return 6144;},
      copyTo(...args){record.args=args;record.buffer=args[0];return copying;},close(){record.closed=true;calls.push('output-close');}};
    outputFrames.push(record);const packet={done:false,value:frame};if(waiting){const resolve=waiting;waiting=null;resolve(packet);}else packets.push(packet);
    record.complete=()=>{new Uint8Array(record.buffer).set(payload(pixelSerial,format,matrix));complete(layout||(format==='NV12'?[{offset:0,stride:64},{offset:4096,stride:64}]:[{offset:0,stride:64},{offset:4096,stride:32},{offset:5120,stride:32}]));};
    record.reject=reject;return record;
  };
  return{api,input,output,calls,outputFrames,state:()=>context.window.__coveCanvasRoute,cleanup:()=>context.window.__coveCanvasRouteCleanup()};
}
test('only bounded mechanism24/64 and paced120/1728 configurations are accepted',()=>{
  assert.equal(configuration([],false).frames,24);const paced=configuration(['--stage','paced'],false);
  assert.equal(paced.frames,120);assert.equal(paced.width,1728);assert.equal(paced.height,1080);assert.equal(paced.poolSize,3);assert.ok(paced.timeoutMs<30000);
  for(const args of [['--frames','121'],['--stage','other'],['--stage','paced','--stage','mechanism'],['--disable-sandbox','1']])assert.throws(()=>configuration(args,false));
});
test('owned HTTP route supplies no COI headers and accepts no other route',async()=>{
  const owned=await startServer();const get=url=>new Promise((resolve,reject)=>{http.get(url,response=>{response.resume();response.once('end',()=>resolve(response));}).once('error',reject);});
  try{const response=await get(owned.url);assert.equal(response.statusCode,200);assert.equal(response.headers['cross-origin-opener-policy'],undefined);
    assert.equal(response.headers['cross-origin-embedder-policy'],undefined);assert.equal(response.headers['cross-origin-resource-policy'],undefined);
    assert.match(response.headers['content-security-policy'],/connect-src 'none'/);assert.equal((await get(owned.url+'/bad')).statusCode,404);
  }finally{await owned.close();}
});
test('draw/JS close never makes a native slot eligible before actual Electron allRefs',()=>{
  const lease={released:false,referencesReleased:true,transferComplete:true,mainReleased:true,importedAckSent:true,permitSent:true};assert.equal(readyForNativeRelease(lease),true);
  for(const key of ['referencesReleased','transferComplete','mainReleased','importedAckSent','permitSent'])assert.equal(readyForNativeRelease({...lease,[key]:false}),false,key);
  assert.equal(readyForNativeRelease({...lease,released:true}),false);
});
test('non-COI renderer requestFrame precedes each draw and closes JS source immediately',async()=>{
  const probe=harness();assert.equal(probe.api.supported,true);assert.equal(probe.api.crossOriginIsolated,false);assert.equal(probe.api.nodeType,'undefined');
  const {frame,returned}=probe.input(1);assert.equal(returned,undefined);assert.equal(frame.closed,true);assert.equal(probe.calls.slice(-3).join(','),'request,draw,source-close');
  assert.equal(probe.state().result.canvasPendingLimit,null);assert.equal(probe.state().result.canvasPendingLimitPubliclyAvailable,false);
  assert.equal((await probe.cleanup()).pendingCopies,0);
});
for(const [format,matrix]of [['NV12','bt709'],['I420','smpte170m']])test(`${format}: actual pixel sequence and metadata-selected raw YUV pass on AB`,async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1,{format,matrix});await turn();assert.equal(record.args.length,1);
  assert.equal(Object.prototype.toString.call(record.buffer),'[object ArrayBuffer]');assert.equal(record.closed,false);
  record.complete();await turn();assert.equal(probe.state().status,'running');assert.equal(probe.state().result.outputs.length,1);
  assert.equal(probe.state().result.outputs[0].serial,1);assert.equal(probe.state().result.outputs[0].pixels.maximumError,0);
  assert.equal(probe.state().result.firstOutputMetadata.format,format);assert.equal(record.closed,true);assert.ok(new Uint8Array(record.buffer).every(v=>v===0));await probe.cleanup();
});
test('cleanup waits for real output copy settlement before closing or wiping',async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1);await turn();new Uint8Array(record.buffer).fill(73);
  let cleaned=false;const cleaning=probe.cleanup().then(value=>{cleaned=true;return value;});await turn();
  assert.equal(cleaned,false);assert.equal(record.closed,false);assert.ok(new Uint8Array(record.buffer).every(v=>v===73));
  record.complete();const result=await cleaning;assert.equal(result.pendingCopies,0);assert.equal(record.closed,true);assert.ok(new Uint8Array(record.buffer).every(v=>v===0));
});
test('unknown actual pixel sequence fails despite valid transport metadata',async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1,{pixelSerial:2});await turn();record.complete();await turn();
  assert.equal(probe.state().errorCode,'canvas_unknown_pixel_sequence');assert.equal(record.closed,true);await probe.cleanup();
});
test('overlapping output planes fail after actual settlement and still close',async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1,{layout:[{offset:0,stride:64},{offset:0,stride:64}]});await turn();record.complete();await turn();
  assert.equal(probe.state().errorCode,'canvas_output_layout_overlap');assert.equal(record.closed,true);await probe.cleanup();
});
test('legal last-frame refresh is counted once for unique FPS; regressed pixels fail',async()=>{
  const probe=harness();probe.input(1);let record=probe.output(1);await turn();record.complete();await turn();
  record=probe.output(1);await turn();record.complete();await turn();assert.equal(probe.state().result.outputs.length,1);assert.equal(probe.state().result.duplicateOutputs,1);
  probe.input(2);record=probe.output(2);await turn();record.complete();await turn();
  record=probe.output(1);await turn();record.complete();await turn();assert.equal(probe.state().errorCode,'canvas_output_sequence_regressed');await probe.cleanup();
});
test('NV12 with fallback601 metadata is rejected instead of fitting oracle',async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1,{format:'NV12',matrix:'smpte170m'});await turn();record.complete();await turn();
  assert.equal(probe.state().errorCode,'canvas_output_color_contract_unsupported');assert.equal(probe.state().result.firstOutputMetadata.colorSpace.matrix,'smpte170m');await probe.cleanup();
});
test('actual copy rejection during cleanup stays a failure and is closed only after rejection',async()=>{
  const probe=harness();probe.input(1);const record=probe.output(1);await turn();const cleaning=probe.cleanup();await turn();assert.equal(record.closed,false);
  record.reject(new Error('synthetic_copy_rejected'));const cleanup=await cleaning;assert.equal(cleanup.status,'failed');assert.equal(cleanup.errorCode,'synthetic_copy_rejected');assert.equal(record.closed,true);
});
test('summary distinguishes finite unique output cadence, missing pixels and production qualification',()=>{
  const input=s=>({serial:s,drawAtMs:s*10,drawWallMs:1}),output=s=>({serial:s,receivedAtMs:s*10+5,copyCallWallMs:1,copyPromiseWallMs:2,frameAgeMs:5,sourceToCopyCompleteAgeMs:6});
  const result=summarize({inputs:[input(1),input(2),input(3)],outputs:[output(1),output(3)],duplicateOutputs:1});
  assert.equal(result.inputFramesPerSecond,100);assert.equal(result.uniqueOutputFramesPerSecond,50);assert.deepEqual(result.missingInputSerials,[2]);
  assert.equal(result.allFramesObserved,false);assert.equal(result.productionEligible,false);
});
