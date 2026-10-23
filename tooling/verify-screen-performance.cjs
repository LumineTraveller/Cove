'use strict';
// Existing double-Chromium/product-hook/SFU fixture, with an independent profile,
// Vite cache and loopback backend for each bounded performance measurement.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process'),dgram=require('node:dgram');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  if(child.connected)child.send({type:'stop'},()=>{});
  for(let n=0;n<30&&child.exitCode===null&&child.signalCode===null;n++)await delay(100);
  if(child.exitCode!==null||child.signalCode!==null)return;
  // This exact ChildProcess/PID was created by this launcher, never selected
  // by process name. Include its owned SFU on a watchdog/signal fallback.
  if(process.platform==='win32')await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>{child.kill();resolve();});killer.once('close',resolve);});
  else child.kill('SIGKILL');
}
function logged(executable,args,env,file){const fd=fs.openSync(file,'w');const child=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:['ignore',fd,fd,'ipc']});child.once('close',()=>fs.closeSync(fd));return child;}
async function port(){const socket=dgram.createSocket('udp4');await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'127.0.0.1',resolve);});const value=socket.address().port;await new Promise(resolve=>socket.close(resolve));return value<65000?value:port();}
async function main(){
  const runtime=path.join(root,'runtime/fps-candidate');fs.mkdirSync(runtime,{recursive:true});
  const label=process.env.COVE_FPS_LABEL||'baseline';if(!/^[a-z0-9-]{1,60}$/.test(label))throw Error('Invalid performance label');
  const directory=fs.mkdtempSync(path.join(runtime,label+'-'));
  const sources=['apps/desktop/src/features/media/screen/screenCapture.ts','apps/desktop/src/features/media/screen/useScreenPublishing.ts','apps/desktop/src/features/media/screen/useScreenAnalysis.ts','apps/desktop/tests/ui/media-integration.tsx','apps/desktop/tests/ui/screen-performance-fixture.ts','apps/desktop/tests/ui/screen-performance.electron.cjs','apps/desktop/tests/ui/screen-performance-backend.cjs','tooling/verify-screen-performance.cjs'];
  fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({startedAt:new Date().toISOString(),node:process.version,files:Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))},null,2)+'\n');
  const env={...process.env,COVE_FPS_RUN_DIR:directory,COVE_TEST_NODE:process.execPath,COVE_QA_MEDIA_PORT:String(await port())};delete env.ELECTRON_RUN_AS_NODE;
  const dependencies=path.dirname(fs.realpathSync(path.join(root,'node_modules/vite')));
  const entry=pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href;
  const bootstrap=path.join(directory,'vite-bootstrap.mjs');
  fs.writeFileSync(bootstrap,`import {createServer} from ${JSON.stringify(entry)};\nconst server=await createServer({root:${JSON.stringify(path.join(root,'apps/desktop'))},configFile:${JSON.stringify(path.join(root,'apps/desktop/vite.config.ts'))},cacheDir:${JSON.stringify(path.join(directory,'vite-cache'))},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false,watch:null,fs:{allow:${JSON.stringify([root,dependencies])}}}});\nawait server.listen();process.send?.({type:'ready',url:'http://127.0.0.1:'+server.httpServer.address().port});process.on('message',async m=>{if(m?.type==='stop'){await server.close();process.disconnect?.();}});`);
  let vite,electron;let error=null;let interrupted=false;
  const onSignal=()=>{interrupted=true;void stop(electron);void stop(vite);};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try{
    vite=logged(process.execPath,[bootstrap],env,path.join(directory,'vite.log'));
    const info=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Vite startup timeout')),30000);vite.once('error',cause=>{clearTimeout(timeout);reject(cause);});vite.once('exit',code=>{clearTimeout(timeout);reject(Error('Vite exited '+code));});vite.on('message',m=>{if(m?.type==='ready'){clearTimeout(timeout);resolve(m);}});});
    electron=logged(require(path.join(root,'apps/desktop/node_modules/electron')),[path.join(root,'apps/desktop/tests/ui/screen-performance.electron.cjs')],{...env,COVE_QA_RENDERER_URL:info.url},path.join(directory,'electron.log'));
    const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Performance measurement timeout')),360000);electron.once('error',reject);electron.once('exit',code=>{clearTimeout(timeout);resolve(code);});});
    if(code!==0)error='Electron exited '+code;
  }catch(cause){error=cause.stack||String(cause);}finally{await stop(electron);await stop(vite);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);}
  const resultPath=path.join(directory,'result.json');const result=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):null;
  console.log(JSON.stringify({directory:path.relative(root,directory),passed:!error&&!interrupted&&result?.passed===true,error,interrupted,result},null,2));
  process.exitCode=error||interrupted||!result?.passed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
