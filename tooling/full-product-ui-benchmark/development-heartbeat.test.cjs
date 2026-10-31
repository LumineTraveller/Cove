'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require(path.resolve(__dirname,'../../node_modules/typescript'));
const compiled=ts.transpileModule(fs.readFileSync(path.join(__dirname,'development-heartbeat.ts'),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const loaded={exports:{}};new Function('module','exports',compiled)(loaded,loaded.exports);
const {classifyIntervalOwner,disposeDevelopmentHeartbeat}=loaded.exports;
test('only loopback Vite client 30s stack receives development ownership',()=>{
  assert.equal(classifyIntervalOwner('at f (http://127.0.0.1:55173/@vite/client:619:8)',30000),'vite-client');
  for(const stack of ['http://example.com/@vite/client:1:2','http://127.0.0.1:55173/@vite/client-other:1:2','unknown'])
    assert.equal(classifyIntervalOwner(stack,30000),'other');
  assert.equal(classifyIntervalOwner('http://127.0.0.1:55173/@vite/client:619:8',100),'other');
});
test('only the exact development handle is cleared and unknown/product handles remain',()=>{
  const active=new Set([1,2,3]),owners=new Map([[1,{owner:'vite-client',delay:30000}],
    [2,{owner:'other',delay:30000}],[3,{owner:'useAudioMeters.ts',delay:100}]]),cleared=[];
  assert.deepEqual(disposeDevelopmentHeartbeat(owners,active,id=>{cleared.push(id);active.delete(id);owners.delete(id);}),
    {observed:1,disposed:1,passed:true});
  assert.deepEqual(cleared,[1]);assert.deepEqual([...active],[2,3]);
});
test('multiple development handles or unsuccessful clear cannot report success',()=>{
  const owners=new Map([[1,{owner:'vite-client',delay:30000}],[2,{owner:'vite-client',delay:30000}]]);
  assert.deepEqual(disposeDevelopmentHeartbeat(owners,new Set([1,2]),()=>assert.fail('must not clear')),
    {observed:2,disposed:0,passed:false});
  assert.deepEqual(disposeDevelopmentHeartbeat(owners,new Set([1]),()=>{}),{observed:1,disposed:0,passed:false});
});
