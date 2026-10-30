'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(require.resolve('../tooling/verify-screen-performance.cjs'),'utf8');
const code=source.slice(source.indexOf('async function port(){'),source.indexOf('\nasync function main(){'));
function fixture({alwaysDenied=false,ephemeral=56834}={}){
  const tcp=[],udp=[],random=[];
  class Tcp extends EventEmitter{
    listen(options,ready){this.options=options;this.port=options.port||ephemeral;tcp.push(this);queueMicrotask(ready);}
    address(){return {port:this.port};}
    close(done){this.closed=true;queueMicrotask(done);}
  }
  class Udp extends EventEmitter{
    bind(options,ready){this.options=options;udp.push(this);
      queueMicrotask(()=>{if(alwaysDenied||options.port===56834)this.emit('error',Object.assign(Error(),{code:'EACCES'}));else ready();});}
    close(done){this.closed=true;queueMicrotask(done);}
  }
  const sockets=[];
  const run=vm.runInNewContext('('+code.trim()+')',{
    net:{createServer:()=>new Tcp()},dgram:{createSocket:()=>{const s=new Udp();sockets.push(s);return s;}},
    crypto:{randomInt:(lo,hi)=>{random.push([lo,hi]);return 62000;}},
  });
  return {run,tcp,udp,sockets,random};
}
test('loopback port search escapes sequential cross-protocol reservations without changing policies',async()=>{
  const f=fixture();assert.equal(await f.run(),62000);
  assert.equal(f.tcp.length,9);assert.equal(f.udp.length,9);
  assert.deepEqual(f.random,[[49152,65336]]);
  assert.ok(f.tcp.slice(0,8).every(s=>s.options.port===0));
  assert.ok(f.tcp.every(s=>s.options.host==='127.0.0.1'&&s.options.exclusive&&s.closed));
  assert.ok(f.udp.every(s=>s.options.address==='127.0.0.1'&&s.options.exclusive&&s.closed));
});
test('port denial exhausts exactly 32 attempts and closes both owned sockets every time',async()=>{
  const f=fixture({alwaysDenied:true});await assert.rejects(f.run(),/after 32 probes \(EACCES\)/);
  assert.equal(f.tcp.length,32);assert.equal(f.udp.length,32);
  assert.ok(f.tcp.every(s=>s.closed));assert.ok(f.sockets.every(s=>s.closed));
});
test('ephemeral ports above the SFU range are not handed to the worker',async()=>{
  const f=fixture({ephemeral:65535});assert.equal(await f.run(),62000);
  assert.equal(f.udp.length,1);assert.equal(f.sockets.length,9);
  assert.ok(f.tcp.every(s=>s.closed));assert.ok(f.sockets.every(s=>s.closed));
});
