const test=require('node:test');const assert=require('node:assert/strict');const dgram=require('node:dgram');
const {createLoopbackMediaProxy}=require('../tooling/loopback-media-proxy.cjs');
test('owned UDP proxy preserves datagrams, isolates clients, drops while blocked and resumes',async t=>{
 const server=dgram.createSocket('udp4');const clients=[dgram.createSocket('udp4'),dgram.createSocket('udp4')];
 await new Promise(resolve=>server.bind(0,'127.0.0.1',resolve));
 const tuples=new Set();server.on('message',(bytes,source)=>{tuples.add(source.port);server.send(bytes,source.port,'127.0.0.1');});
 const proxy=await createLoopbackMediaProxy(server.address().port,'udp');
 t.after(async()=>{clients.forEach(c=>c.close());await proxy.close();server.close();});
 const echo=(client,bytes)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('UDP echo timeout')),1000);client.once('message',reply=>{clearTimeout(timer);resolve(reply);});client.send(bytes,proxy.port,'127.0.0.1');});
 assert.deepEqual(await echo(clients[0],Buffer.from([0,1,2,0,255])),Buffer.from([0,1,2,0,255]));
 assert.deepEqual(await echo(clients[1],Buffer.from('second')),Buffer.from('second'));assert.equal(tuples.size,2);
 proxy.setBlocked(true);clients[0].send(Buffer.from('drop'),proxy.port,'127.0.0.1');
 await new Promise(resolve=>setTimeout(resolve,30));assert.ok(proxy.counts().droppedDatagrams>0);
 proxy.setBlocked(false);assert.deepEqual(await echo(clients[0],Buffer.from('resumed')),Buffer.from('resumed'));
 assert.ok(proxy.counts().toClientDatagrams>=3);assert.equal(proxy.counts().activeFlows,2);
});
test('a UDP flow first seen during a fault can be cleaned up without forwarding',async()=>{
 const server=dgram.createSocket('udp4'),client=dgram.createSocket('udp4');
 await new Promise(resolve=>server.bind(0,'127.0.0.1',resolve));
 const proxy=await createLoopbackMediaProxy(server.address().port,'udp');proxy.setBlocked(true);
 try{client.send(Buffer.from('blocked-initial-packet'),proxy.port,'127.0.0.1');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(proxy.counts().activeFlows,1);assert.equal(proxy.counts().toServerDatagrams,0);await proxy.close();await proxy.close();assert.equal(proxy.counts().activeFlows,0);}
 finally{client.close();await proxy.close();server.close();}
});
