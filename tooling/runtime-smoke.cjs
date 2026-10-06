// Real SQLite + real mediasoup, always scoped to an isolated temporary profile.
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {io}=require('socket.io-client');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
process.env.COVE_DATA_DIR=fs.mkdtempSync(path.join(root,'runtime','smoke-'));
process.env.COVE_DOWNLOAD_DIR=path.join(process.env.COVE_DATA_DIR,'downloads');
process.env.COVE_SERVER_SECURITY_ENABLED='false';process.env.MEDIASOUP_IP='127.0.0.1';process.env.MEDIASOUP_PORT='41020';
const {startServer,stopServer}=require(process.env.COVE_TEST_SERVER_MODULE||'../apps/server/dist/index.js');
const sockets=[];
const request=(socket,event,data)=>socket.timeout(8000).emitWithAck(event,data);
async function main(){
  const [port, samePort]=await Promise.all([startServer(0),startServer(0)]);assert.equal(port,samePort);
  const base='http://127.0.0.1:'+port;
  const accounts=[];
  for(let index=0;index<2;index++){
    const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`refactor-${index}@example.test`,password:'isolated-test-password-123',username:`Refactor ${index}`})});
    assert.equal(response.status,201);accounts.push(await response.json());
  }
  const socket=io(base,{auth:{clientProtocol:2},autoConnect:false});sockets.push(socket);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);socket.connect();});
  const registration=await request(socket,'user:register',{username:'Refactor 0',avatarUrl:null,clientId:'smoke-owner',authToken:accounts[0].token,platform:'desktop'});assert.equal(registration.ok,true);
  const created=await request(socket,'room:create',{name:'Isolated refactor validation'});assert.ok(created.room?.id);
  const roomId=created.room.id;
  const joined=await request(socket,'room:join',roomId);assert.equal(joined.ok,true);
  const capabilities=await request(socket,'ms:capabilities');assert.ok(capabilities.codecs.some(codec=>codec.mimeType==='audio/opus'));
  assert.ok(capabilities.codecs.some(codec=>codec.mimeType==='video/AV1'));
  const transport=await request(socket,'ms:create-transport',{direction:'recv'});assert.ok(transport.id);assert.ok(transport.iceCandidates.length);
  socket.disconnect();
  await new Promise(resolve=>setTimeout(resolve,100));
  if(process.argv.includes('--hold')){
    process.send?.({type:'ready',base,roomId,accounts});
    process.on('message',async message=>{if(message?.type==='stop'){await stopServer();if(process.connected)process.disconnect();}});
  }else{
    await Promise.all([stopServer(),stopServer()]);
    const nextPort=await startServer(0);assert.ok(nextPort);await stopServer();
    console.log('PASS: real SQLite, mediasoup codecs/transports, registration, room, concurrent start/stop and restart.');
  }
}
main().then(()=>{if(process.versions.electron&&!process.argv.includes('--hold'))require('electron').app.exit(0);}).catch(async error=>{console.error(error);for(const socket of sockets)socket.disconnect();await stopServer().catch(()=>{});process.exitCode=1;process.disconnect?.();if(process.versions.electron)require('electron').app.exit(1);});
