'use strict';
// CPU-only contract tests. Never load Electron, start D3D or read a desktop.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const http=require('node:http');
const {configuration,startServer,summarize}=require('./readback.cjs');
const setup=require('./readback-renderer.cjs');
const createColorOracle=require('./readback-color-oracle.cjs');
const delay=()=>new Promise(resolve=>setImmediate(resolve));
const clamp=value=>Math.max(0,Math.min(255,Math.round(value)));
function oracle(x,y,serial) {
  if(y<2&&x<16){const gray=(serial>>Math.floor(x/2))&1?224:32;return[gray,gray,gray,255];}
  const colors=[[0,0,255,255],[0,255,0,255],[255,0,0,255],[255,255,255,255],
    [0,0,0,255],[255,255,0,255],[255,0,255,255],[0,255,255,255]];
  if(y>=24&&y<40){const gray=[0,32,64,96,128,160,192,255][x>>3];return[gray,gray,gray,255];}
  if(y>=44&&y<52)return colors[x>>3];
  if(y>=52&&y<60)return colors[(y&1)*2+(x&1)];
  return colors[(y>=32?2:0)+(x>=32?1:0)];
}
function yuv(bgra) {
  const [b,g,r]=bgra.map(v=>v/255),y=.2126*r+.7152*g+.0722*b;
  return[clamp(16+219*y),clamp(128+224*(b-y)/1.8556),clamp(128+224*(r-y)/1.5748)];
}
function payload(format,serial) {
  const bytes=new Uint8Array(format==='nv12'?6144:16384);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
    const p=oracle(x,y,serial);
    if(format==='bgra')bytes.set(p,(y*64+x)*4);else bytes[y*64+x]=yuv(p)[0];
  }
  if(format==='nv12')for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    const p=[0,0,0,255];for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const q=oracle(x*2+dx,y*2+dy,serial);for(let c=0;c<3;c++)p[c]+=q[c]/4;}
    bytes.set(yuv(p).slice(1),4096+y*64+x*2);
  }
  return bytes;
}
// Fixed scalar reference vectors evaluated from the pinned C equations. The
// mock CPU conversion consumes bytes and uses this literal table, independently
// of the renderer's expected-source H709 oracle.
const h709Vectors=[
  [[63,102,240],[255,1,3,255]],[[173,42,26],[0,255,11,255]],[[32,240,118],[1,0,243,255]],
  [[235,128,128],[255,255,255,255]],[[16,128,128],[0,0,0,255]],
  [[43,128,128],[31,31,31,255]],[[126,128,128],[128,128,128,255]],[[181,128,128],[192,192,192,255]],
];
function harness({format='nv12',bufferKind='sab',inflight=3,frames=3,isolated=true,cpuModel='h709',cpuDelta=0,cpuGate=null}={}) {
  let listener;const records=[],cpuFrames=[];
  class CpuFrame {
    constructor(buffer,init) {
      this.bytes=new Uint8Array(structuredClone(buffer,{transfer:[buffer]}));this.init=init;
      this.format=init.format;this.codedWidth=init.codedWidth;this.codedHeight=init.codedHeight;
      this.closed=false;cpuFrames.push(this);
    }
    async copyTo(destination,{rect}) {
      if(cpuGate)await cpuGate;
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
        const x=rect.x+dx,y=rect.y+dy;let rgba;
        if(this.format==='BGRA'){const offset=(y*64+x)*4;rgba=[this.bytes[offset+2],this.bytes[offset+1],this.bytes[offset],this.bytes[offset+3]];}
        else {
          const offset=4096+Math.floor(y/2)*64+(x&~1),yv=this.bytes[y*64+x],uv=this.bytes[offset],vv=this.bytes[offset+1];
          if(cpuModel==='h709') {
            const vector=h709Vectors.find(([input])=>input[0]===yv&&input[1]===uv&&input[2]===vv);assert.ok(vector,'mock only supports fixed owned palette');rgba=vector[1].slice();
          } else {
            const luma=(yv-16)/219,u=(uv-128)/224,v=(vv-128)/224;
            const r=luma+(cpuModel==='bt601'?1.402:1.5748)*v,b=luma+(cpuModel==='bt601'?1.772:1.8556)*u;
            const kr=cpuModel==='bt601'?.299:.2126,kb=cpuModel==='bt601'?.114:.0722,g=(luma-kr*r-kb*b)/(1-kr-kb);
            rgba=[clamp(r*255),clamp(g*255),clamp(b*255),255];
          }
        }
        rgba[0]=clamp(rgba[0]+cpuDelta);
        destination.set(rgba,(dy*2+dx)*4);
      }
      return[{offset:0,stride:8}];
    }
    allocationSize(){return 16;}
    close(){this.closed=true;this.bytes.fill(0);}
  }
  const context=vm.createContext({window:{coveNativeScreen:{supported:true,onFrame:(_id,callback)=>{listener=callback;return()=>{listener=null;};}}},
    crossOriginIsolated:isolated,SharedArrayBuffer:isolated?SharedArrayBuffer:undefined,ArrayBuffer,Uint8Array,VideoFrame:CpuFrame,
    performance:{now:()=>performance.now()},console});
  const config={width:64,height:64,pixelFormat:format,bufferKind,frames,inflight};
  const api=vm.runInContext('('+setup.toString()+')',context)('readback_test',config,vm.runInContext('('+createColorOracle.toString()+')',context));
  function frame(serial,slot=serial-1) {
    let resolve,reject;const copying=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const record={serial,slot,buffer:null,finished:false,copyArgs:null};records.push(record);
    const gpu={format:format.toUpperCase(),codedWidth:64,codedHeight:64,timestamp:serial*1000,
      colorSpace:format==='nv12'?{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true},
      allocationSize(...args){assert.equal(args.length,0);return format==='nv12'?6144:16384;},
      copyTo(...args){record.copyArgs=args;record.buffer=args[0];return copying;}};
    const task=listener(gpu,{requestId:'readback_test',width:64,height:64,serial,slot,timestamp:serial*1000}).then(()=>{record.finished=true;});
    record.complete=(overrideSerial=serial,overrideLayout=null)=>{
      new Uint8Array(record.buffer).set(payload(format,overrideSerial));
      resolve(overrideLayout||(format==='nv12'?[{offset:0,stride:64},{offset:4096,stride:64}]:[{offset:0,stride:256}]));
    };
    record.reject=reject;return{record,task};
  }
  return{context,api,frame,records,cpuFrames,state:()=>context.window.__coveReadbackProbe,cleanup:()=>context.window.__coveReadbackCleanup()};
}
test('matrix and bounded explicit filters do not require Electron',()=>{
  const all=configuration([],false);assert.equal(all.cases.length,16);assert.equal(all.frames,24);
  assert.match(all.helper,/readback-helper-hires\.exe$/);
  const minimal=configuration(['--sizes','64','--formats','nv12','--buffers','ab,sab','--inflight','1,3','--frames','6'],false);
  assert.equal(minimal.cases.length,4);
  assert.equal(configuration(['--sizes','1920'],false).cases.length,8);
  for(const args of [['--inflight','4'],['--frames','251'],['--sizes','3840'],['--buffers','ab,ab'],['--formats','rgba'],['--frames','6','--frames','9']])assert.throws(()=>configuration(args,false));
});
test('owned loopback page supplies real isolation headers and rejects unknown routes',async()=>{
  const owned=await startServer();
  const get=url=>new Promise((resolve,reject)=>{http.get(url,response=>{response.resume();response.once('end',()=>resolve(response));}).once('error',reject);});
  try {
    const response=await get(owned.url);assert.equal(response.statusCode,200);
    assert.equal(response.headers['cross-origin-opener-policy'],'same-origin');assert.equal(response.headers['cross-origin-embedder-policy'],'require-corp');
    assert.match(response.headers['content-security-policy'],/connect-src 'none'/);
    assert.equal((await get(owned.url+'/other')).statusCode,404);assert.equal(owned.requests(),1);
  }finally{await owned.close();}
});
test('summary uses actual completion timestamps and labels synthetic cadence',()=>{
  const renderer={samples:[{callAtMs:0,settledAtMs:10,copyCallWallMs:2,copyPromiseWallMs:10,copyPostCallWallMs:8,allocationWallMs:1,validationWallMs:100},
    {callAtMs:20,settledAtMs:30,copyCallWallMs:4,copyPromiseWallMs:10,copyPostCallWallMs:6,allocationWallMs:1,validationWallMs:200}],maxCopyPromises:2,maxCallbacks:2};
  const summary=summarize(renderer);assert.equal(summary.copyCall.meanMs,3);assert.equal(summary.completionWindowMs,30);
  assert.equal(summary.completedReadbacksPerSecond,2000/30);assert.match(summary.throughputScope,/not desktop capture or Cove FPS/);
});
test('SAB gate fails without isolated page before a callback can register',()=>{
  const probe=harness({isolated:false});assert.equal(probe.api.isolated,false);assert.equal(probe.state().errorCode,'renderer_cross_origin_isolation_required');
});
test('pinned H709 independent integer oracle matches literal scalar vectors, including known blue errors',()=>{
  const oracle=createColorOracle();assert.equal(oracle.revision,'b56492e2dfc064f65ef27fed9c45d9bbfc2e2ad2');
  assert.equal(oracle.sourceSha256,'6fdd463fd0d944e29df7f439b92376ab143e168e4a328d13758495a895f05cfd');
  assert.match(oracle.sourceHashObject,/raw Gitiles base64-decoded.*LF/);
  assert.deepEqual(oracle.constants,{UB:128,UG:14,VG:34,VR:115,YG:18997,YB:-1160});
  for(const[input,expected]of h709Vectors)assert.deepEqual(oracle.nv12ToRgba(...input),expected);
  assert.equal(oracle.nv12ToRgba(173,42,26)[2],11);assert.equal(255-oracle.nv12ToRgba(32,240,118)[2],12);
});
for(const format of ['nv12','bgra'])for(const bufferKind of ['ab','sab'])test(`${format} ${bufferKind}: three true pending writes retain callbacks, sequence and CPU golden`,async()=>{
  const probe=harness({format,bufferKind});const jobs=[probe.frame(1),probe.frame(2),probe.frame(3)];
  await delay();assert.equal(probe.state().result.completed,0);assert.equal(probe.state().result.maxCopyPromises,3);
  assert.equal(probe.state().result.maxCallbacks,3);assert.ok(jobs.every(job=>!job.record.finished));
  for(const{record}of jobs){assert.equal(record.copyArgs.length,1,'format must be omitted even for BGRA');assert.equal(Object.prototype.toString.call(record.buffer),bufferKind==='sab'?'[object SharedArrayBuffer]':'[object ArrayBuffer]');}
  jobs[2].record.complete();await jobs[2].task;assert.equal(probe.state().result.completed,1);assert.equal(jobs[0].record.finished,false);
  jobs[1].record.complete();jobs[0].record.complete();await Promise.all(jobs.map(job=>job.task));
  assert.equal(probe.state().status,'complete');assert.equal(probe.state().result.passed,true);
  assert.equal(probe.state().result.cpuGolden.constructTransferDetached,true);assert.equal(probe.state().result.cpuGolden.sabToArrayBufferCopy,bufferKind==='sab');
  assert.equal(probe.state().result.cpuGolden.maximumRgbError,0);
  assert.equal(probe.state().result.cpuGolden.originalSourceComparison.passed,format==='bgra');
  if(format==='nv12')assert.equal(probe.state().result.cpuGolden.originalSourceComparison.maximumError,12);
  assert.equal(probe.state().result.samples.map(sample=>sample.serial).join(','),'1,2,3');assert.ok(probe.cpuFrames.every(frame=>frame.closed));
  for(const{record}of jobs)if(record.buffer.byteLength)assert.ok(new Uint8Array(record.buffer).every(value=>value===0));
  assert.equal((await probe.cleanup()).callbacksDrained,true);
});
for(const cpuModel of ['bt601','rational709'])test(`CPU RGB negative control rejects ${cpuModel} instead of silently accepting a different oracle`,async()=>{
  const probe=harness({cpuModel});const{record,task}=probe.frame(1);record.complete();await task;
  assert.equal(probe.state().errorCode,'renderer_cpu_rgb_mismatch');assert.equal(probe.state().result.pixelsPassed,true);
  assert.equal(probe.state().result.samples.length,1,'raw successful sample is retained independently of CPU RGB failure');
  assert.equal(probe.state().result.cpuGolden.passed,false);assert.equal(probe.state().result.cpuGolden.frameClosedAfterChecks,true);
  assert.ok(probe.state().result.cpuGolden.maximumRgbError>4);assert.equal(probe.state().result.cpuGolden.fixedSyntheticSamples.length,8);
});
test('CPU RGB negative control rejects a five-code-value corruption under unchanged tolerance four',async()=>{
  const probe=harness({cpuDelta:5});const{record,task}=probe.frame(1);record.complete();await task;
  assert.equal(probe.state().errorCode,'renderer_cpu_rgb_mismatch');assert.equal(probe.state().result.cpuGolden.maximumRgbError,5);
  assert.equal(probe.state().result.cpuGolden.tolerance,4);
});
test('finishing other copies cannot publish completion before the retained CPU golden callback finishes',async()=>{
  let finishGolden;const cpuGate=new Promise(resolve=>{finishGolden=resolve;});const probe=harness({cpuGate});
  const jobs=[probe.frame(1),probe.frame(2),probe.frame(3)];for(const job of jobs)job.record.complete();
  await Promise.all(jobs.slice(1).map(job=>job.task));assert.equal(probe.state().result.samples.length,3);
  assert.equal(probe.state().status,'waiting');assert.equal(jobs[0].record.finished,false);
  finishGolden();await jobs[0].task;assert.equal(probe.state().status,'complete');
});
test('cleanup cannot complete, mutate SAB or return the source callback before actual write settles',async()=>{
  const probe=harness({frames:3});const{record,task}=probe.frame(1);new Uint8Array(record.buffer).fill(73);
  let cleaned=false;const cleaning=probe.cleanup().then(value=>{cleaned=true;return value;});
  await delay();assert.equal(record.finished,false);assert.equal(cleaned,false);assert.ok(new Uint8Array(record.buffer).every(value=>value===73));
  record.complete();await task;assert.equal((await cleaning).callbacksDrained,true);assert.ok(new Uint8Array(record.buffer).every(value=>value===0));
});
test('stale actual pixel sequence is rejected despite valid transport serial',async()=>{
  const probe=harness();const{record,task}=probe.frame(1);record.complete(2);await task;
  assert.equal(probe.state().status,'failed');assert.equal(probe.state().errorCode,'renderer_pixels_mismatch');assert.equal(probe.state().result.sequencePassed,false);
});
test('malformed plane overlaps are rejected after actual completion',async()=>{
  const probe=harness();const{record,task}=probe.frame(1);record.complete(1,[{offset:0,stride:64},{offset:0,stride:64}]);await task;
  assert.equal(probe.state().errorCode,'renderer_layout_invalid');assert.equal(record.finished,true);
});
test('rejected underlying write still holds callback until rejection and reports failure',async()=>{
  const probe=harness();const{record,task}=probe.frame(1);new Uint8Array(record.buffer).fill(49);await delay();assert.equal(record.finished,false);
  assert.ok(new Uint8Array(record.buffer).every(value=>value===49));
  record.reject(new Error('synthetic_copy_rejected'));await task;assert.equal(probe.state().errorCode,'synthetic_copy_rejected');assert.equal(record.finished,true);
  assert.ok(new Uint8Array(record.buffer).every(value=>value===0));
});
