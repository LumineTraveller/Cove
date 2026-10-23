// Isolated real runtime for browser acceptance. IPC contains synthetic fixture
// account tokens in memory only; persisted reports never include them.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
// Observe fixture-owned runtime timers without changing their deadlines/ref state.
const timers=new Map(),nativeTimeout=global.setTimeout,nativeClearTimeout=global.clearTimeout;
global.setTimeout=(callback,ms,...args)=>{const origin=new Error().stack.split('\n').slice(2,5).map(line=>line.trim());let timer;timer=nativeTimeout(function(){timers.delete(timer);callback.apply(this,args);},ms);timers.set(timer,{ms,origin});return timer;};
global.clearTimeout=timer=>{timers.delete(timer);nativeClearTimeout(timer);};
const {smokeClientIdentity}=require('./smoke-client-identity.cjs');const identity=smokeClientIdentity();
const root=path.resolve(__dirname,'..');const runtime=path.join(root,'runtime','acceptance-20261023');fs.mkdirSync(runtime,{recursive:true});
process.env.COVE_DATA_DIR=fs.mkdtempSync(path.join(runtime,'backend-'));
process.env.COVE_DOWNLOAD_DIR=path.join(process.env.COVE_DATA_DIR,'downloads');process.env.COVE_SERVER_SECURITY_ENABLED='false';
process.env.MEDIASOUP_IP='127.0.0.1';process.env.MEDIASOUP_PORT=String(process.env.COVE_QA_MEDIA_PORT||41024);
process.env.COVE_HTTP_HOST='127.0.0.1';process.env.MEDIASOUP_LISTEN_IP='127.0.0.1';
const {startServer,stopServer}=require(path.join(root,'apps/server/dist/index.js'));
let port=0;let roomId;let accounts=[];let stopping=false;
async function stop(){if(stopping)return;stopping=true;await stopServer();console.log('[acceptance-backend-stopped]',JSON.stringify({resources:process.getActiveResourcesInfo(),timers:[...timers].filter(([timer])=>timer.hasRef()).map(([,detail])=>detail),handles:process._getActiveHandles().map(handle=>handle.constructor?.name)}));process.disconnect?.();}
async function main(){
 port=await startServer(0);const base='http://127.0.0.1:'+port;
 for(let index=0;index<2;index++){const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json',...identity.headers},body:JSON.stringify({email:`acceptance-${index}@example.test`,password:'isolated-fixture-password-123',username:`Acceptance ${index}`})});assert.equal(response.status,201);accounts.push(await response.json());}
 const {io}=require('socket.io-client');const socket=io(base,{auth:identity.auth,autoConnect:false});
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);socket.connect();});
 assert.equal((await socket.timeout(8000).emitWithAck('user:register',{authToken:accounts[0].token,clientId:'acceptance-seed',...identity.registration})).ok,true);
 const created=await socket.timeout(8000).emitWithAck('room:create',{name:'Isolated recovery acceptance'});assert.ok(created.room?.id);roomId=created.room.id;socket.disconnect();
 process.send?.({type:'ready',base,roomId,accounts});
 process.on('message',async message=>{try{
  if(message?.type==='stop')await stop();
  else if(message?.type==='restart'){await stopServer();await startServer(port);process.send?.({type:'restarted',requestId:message.requestId});}
  else if(message?.type==='snapshot'){const {peers}=require(path.join(root,'apps/server/dist/features/media/ms.js'));let transports=0,producers=0,consumers=0;for(const peer of peers.values()){for(const [key,value] of Object.entries(peer))if(/Transport$/.test(key)&&value&&!value.closed)transports++;producers+=peer.producers.size;consumers+=peer.consumers.size;}process.send?.({type:'snapshot',requestId:message.requestId,resources:{peers:peers.size,transports,producers,consumers}});}
 }catch(error){console.error(error);process.send?.({type:'backend-error',requestId:message?.requestId,error:error.message});}});
}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
main().catch(async error=>{console.error(error);await stopServer().catch(()=>{});process.exitCode=1;process.disconnect?.();});
