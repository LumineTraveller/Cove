const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createIceRestartRunLayout}=require('../tooling/verify-ice-restart.cjs');
const runtime=path.resolve(__dirname,'../runtime/acceptance-20261023');

test('each ICE browser invocation gets a fresh Vite cache even when the source/lockfile is unchanged',()=>{
 const first=createIceRestartRunLayout(runtime,'udp',600);
 const second=createIceRestartRunLayout(runtime,'udp',600);
 assert.notEqual(first.fixtureRunId,second.fixtureRunId);
 assert.notEqual(first.cacheDir,second.cacheDir);
 assert.notEqual(first.bootstrap,second.bootstrap);
 for(const plan of [first,second]){
  assert.equal(path.dirname(plan.cacheDir),runtime);
  assert.equal(path.dirname(plan.bootstrap),runtime);
  assert.ok(path.basename(plan.cacheDir).includes(plan.fixtureRunId));
  assert.ok(path.basename(plan.bootstrap).includes(plan.fixtureRunId));
 }
});

test('fixture cache paths reject external IDs and invalid layouts',()=>{
 assert.throws(()=>createIceRestartRunLayout(runtime,'udp',600,'../../outside'));
 assert.throws(()=>createIceRestartRunLayout('relative-runtime','udp',600));
 assert.throws(()=>createIceRestartRunLayout(runtime,'http',600));
 assert.throws(()=>createIceRestartRunLayout(runtime,'udp',-1));
 assert.throws(()=>createIceRestartRunLayout(runtime,'udp',3601));
 assert.throws(()=>createIceRestartRunLayout(runtime,'udp',NaN));
});
