'use strict';
// Execute the real entry file against fake Electron/children/files. CPU only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {entryMode,cleanRuntimeEnvironment,boundedLogSink}=require('./run.cjs');
const filename=path.join(__dirname,'run.cjs'),source=fs.readFileSync(filename,'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function execute({electron=false,isMain=true,args=[],spawnKind='close',appFailure='synthetic_ready_rejected'}={}){
  const files=new Map(),writes=[],spawns=[],errors=[],prints=[],appCalls=[],module={exports:{}};
  const root=path.resolve(__dirname,'../../..'),directory=path.join(root,'runtime/canvas-route-probe/mechanism-cpu-mock');
  const config={stage:'mechanism',helper:path.join(root,'runtime/nv12-shader-probe/readback-helper.exe'),addon:path.join(root,'runtime/native-screen-capture/native-screen-handles.node')};
  const events=new EventEmitter(),processFake={pid:41234,argv:['node',filename,...args],versions:{node:'test',...(electron?{electron:'44.0.0'}:{})},platform:'win32',arch:'x64',
    env:{Node_Options:'never-log-this',NODE_PATH:'never-log-this-either',electron_run_as_node:'1',KEEP:'kept',COVE_CANVAS_DIRECTORY:directory,COVE_CANVAS_CONFIG:JSON.stringify(config)},
    connected:electron,send:message=>appCalls.push(['send',message]),once:events.once.bind(events),on:events.on.bind(events),off:events.off.bind(events)};
  const fakeFs={...fs,mkdirSync(){},mkdtempSync(){return directory;},
    writeFileSync(file,value){files.set(file,Buffer.from(value));writes.push(path.basename(file));},
    appendFileSync(file,value){files.set(file,Buffer.concat([files.get(file)||Buffer.alloc(0),Buffer.from(value)]));},
    readFileSync(file,encoding){if(files.has(file)){const value=files.get(file);return encoding?value.toString(encoding):value;}return fs.readFileSync(file,encoding);}};
  let child;
  function spawnFake(binary,argv,options){
    spawns.push({binary,argv,options});
    if(binary==='taskkill'){
      const killer=new EventEmitter();setImmediate(()=>{child.exitCode=1;child.signalCode='SIGTERM';child.emit('close',1);killer.emit('close',0);});return killer;
    }
    assert.ok(files.has(path.join(directory,'result.json')),'result scaffold predates spawn');assert.ok(files.has(path.join(directory,'launch.json')),'launch evidence predates spawn');
    if(spawnKind==='throw')throw new Error('synthetic_spawn_threw');
    child=new EventEmitter();Object.assign(child,{pid:51234,exitCode:null,signalCode:null,connected:spawnKind==='watchdog',stdout:new PassThrough(),stderr:new PassThrough(),
      send(){throw new Error('synthetic_send_threw');},kill(){child.exitCode=1;child.emit('close',1);}});
    setImmediate(()=>{
      child.stdout.write(Buffer.alloc(70000,65));child.stderr.write(Buffer.alloc(70000,66));
      if(spawnKind==='error'){child.exitCode=2;child.emit('error',new Error('untrusted_spawn_error'));child.emit('close',2);}
      else if(spawnKind==='close'){child.exitCode=0;child.emit('close',0);}
    });return child;
  }
  const app={setPath(name){appCalls.push(['setPath',name]);if(appFailure==='synthetic_set_path_failed')throw new Error(appFailure);},on(){},
    whenReady(){appCalls.push(['whenReady']);return Promise.reject(new Error(appFailure));},exit(code){appCalls.push(['exit',code]);}};
  const requireFake=name=>{
    if(name==='node:fs')return fakeFs;if(name==='node:child_process')return{spawn:spawnFake};
    if(name==='electron')return{app,ipcMain:{removeHandler(){}},BrowserWindow(){throw new Error('gpu_window_must_not_be_created');}};
    if(name===path.join(root,'apps/desktop/node_modules/electron'))return'fake-electron.exe';
    if(name.startsWith('.'))return require(path.resolve(__dirname,name));return require(name);
  };
  requireFake.main=isMain?module:{};
  const context=vm.createContext({require:requireFake,module,exports:module.exports,__dirname,__filename:filename,process:processFake,Buffer,
    console:{log:value=>prints.push(value),error:value=>errors.push(value)},setTimeout:(callback,ms)=>setTimeout(callback,ms===28500?(spawnKind==='watchdog'?0:ms):Math.min(ms,1)),clearTimeout});
  vm.runInContext(source,context,{filename});
  return{files,writes,spawns,errors,prints,appCalls,process:processFake,directory,
    result:()=>JSON.parse(files.get(path.join(directory,'result.json')).toString()),launch:()=>JSON.parse(files.get(path.join(directory,'launch.json')).toString())};
}
async function settle(run){for(let n=0;n<100;n++){if(run.process.exitCode!==undefined||run.appCalls.some(c=>c[0]==='exit'))return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('CPU mock bootstrap did not finish');}
test('entry selection covers Electron CommonJS with main mismatch and Node import/check',()=>{
  assert.equal(entryMode({electron:'44.0.0',isMain:false,args:[]}), 'electron');
  assert.equal(entryMode({electron:'44.0.0',isMain:true,args:['--check']}),'electron');
  assert.equal(entryMode({isMain:false,args:[]}),'import');assert.equal(entryMode({isMain:true,args:['--check']}),'check');assert.equal(entryMode({isMain:true,args:[]}),'launch');
});
test('runtime environment removes mixed-case injection variables without changing parent',()=>{
  const original={NODE_OPTIONS:'secret',Node_Options:'other',node_path:'private',ELECTRON_RUN_AS_NODE:'1',electron_run_as_node:'1',KEEP:'ok'};
  assert.deepEqual(cleanRuntimeEnvironment(original),{KEEP:'ok'});assert.equal(Object.keys(original).length,6);
});
test('bounded log sink keeps draining after cap without retaining excess bytes',()=>{
  const parts=[],sink=boundedLogSink(bytes=>parts.push(Buffer.from(bytes)),8);sink.append(Buffer.alloc(6));sink.append(Buffer.alloc(6));sink.append(Buffer.alloc(6));
  assert.equal(Buffer.concat(parts).length,8);assert.deepEqual(sink.state(),{limitBytes:8,bytesSeen:18,bytesKept:8,truncated:true});
});
test('actual Node import has no scaffold, Electron require or spawn side effects',()=>{
  const run=execute({isMain:false});assert.equal(run.files.size,0);assert.equal(run.spawns.length,0);assert.equal(run.appCalls.length,0);
});
test('actual Node check never launches Electron or writes artifacts',()=>{
  const run=execute({args:['--check','--stage','mechanism']});assert.equal(run.files.size,0);assert.equal(run.spawns.length,0);assert.equal(run.appCalls.length,0);
  assert.equal(JSON.parse(run.prints[0]).gpuExecuted,false);
});
test('actual Electron entry with main mismatch reaches ready failure and preserves result',async()=>{
  const run=execute({electron:true,isMain:false});await settle(run);assert.equal(run.spawns.length,0);assert.equal(run.appCalls.filter(c=>c[0]==='whenReady').length,1);
  assert.equal(run.result().errorCode,'synthetic_ready_rejected');assert.equal(run.result().electronMainPid,41234);assert.equal(run.result().phase,'failed');
});
test('Electron failure before main try still writes bootstrap error and exits',async()=>{
  const run=execute({electron:true,isMain:false,appFailure:'synthetic_set_path_failed'});await settle(run);
  assert.equal(run.result().phase,'electron_bootstrap_failed');assert.equal(run.result().errorCode,'synthetic_set_path_failed');assert.ok(run.errors.length>0);
});
for(const [spawnKind,errorCode]of [['throw','synthetic_spawn_threw'],['error','canvas_electron_spawn_failed'],['close','canvas_electron_incomplete_exit']])test(`launcher ${spawnKind} preserves pre-spawn scaffold and fixed failure`,async()=>{
  const run=execute({spawnKind});await settle(run);assert.equal(run.result().passed,false);assert.equal(run.result().errorCode,errorCode);assert.equal(run.process.exitCode,1);
  assert.equal(run.launch().launcherPid,41234);assert.equal(run.spawns.length,1);
  assert.equal(run.spawns[0].options.env.Node_Options,undefined);assert.equal(run.spawns[0].options.env.NODE_PATH,undefined);assert.equal(run.spawns[0].options.env.electron_run_as_node,undefined);
  if(spawnKind!=='throw'){assert.equal(run.launch().logs.stdout.bytesKept,65536);assert.equal(run.launch().logs.stderr.bytesKept,65536);assert.equal(run.launch().logs.stdout.truncated,true);}
});
test('watchdog with throwing IPC still terminates exactly its known child and records timeout',async()=>{
  const run=execute({spawnKind:'watchdog'});await settle(run);assert.equal(run.result().passed,false);assert.equal(run.result().errorCode,'canvas_launcher_watchdog');
  const kills=run.spawns.filter(call=>call.binary==='taskkill');assert.equal(kills.length,1);assert.equal(kills[0].argv.join(' '),'/PID 51234 /T /F');assert.equal(run.launch().timedOut,true);
});
