const {app,BrowserWindow,session}=require('electron');
const {spawn}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..');
if(!process.env.COVE_TEST_NODE)throw new Error('COVE_TEST_NODE must name the standalone Node runtime (not Electron).');
const temp=fs.mkdtempSync(path.join(root,'runtime','electron-media-'));app.setPath('userData',temp);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const backend=spawn(process.env.COVE_TEST_NODE,[path.join(root,'tooling/runtime-smoke.cjs'),'--hold'],{cwd:root,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
const ready=new Promise((resolve,reject)=>{backend.on('message',message=>{if(message?.type==='ready')resolve(message);});backend.once('error',reject);backend.once('exit',code=>reject(new Error('Backend exited '+code)));});
const windows=[];let finished=false;
async function finish(code){
  if(finished)return;finished=true;for(const win of windows)if(!win.isDestroyed())win.destroy();
  if(backend.exitCode===null){
    await new Promise(resolve=>{backend.once('exit',resolve);backend.send({type:'stop'});setTimeout(()=>{backend.kill();resolve();},5000).unref();});
  }
  app.exit(code);
}
const watchdog=setTimeout(()=>{console.error('Media regression timed out');void finish(1);},90000);
async function waitFor(win,code){for(let attempt=0;attempt<240;attempt++){if(await win.webContents.executeJavaScript(code))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out: '+code);}
app.whenReady().then(async()=>{
  try{
    const info=await ready;
    session.defaultSession.setPermissionRequestHandler((_wc,permission,done)=>done(permission==='media'));
    session.defaultSession.setPermissionCheckHandler((_wc,permission)=>permission==='media');
    for(let index=0;index<2;index++){
      const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});windows.push(win);win.webContents.setAudioMuted(true);
      win.webContents.on('console-message',(_event,_level,message)=>{if(message.includes('Error')||message.includes('error'))console.log('[renderer]',message);});
      const query=new URLSearchParams({base:info.base,room:info.roomId,token:info.accounts[index].token,index:String(index)});
      await win.loadURL('http://127.0.0.1:55173/tests/ui/media-integration.html?'+query);
      await waitFor(win,'Boolean(window.coveMediaQA?.ready)');
      await win.webContents.executeJavaScript('window.coveMediaQA.rtc.joinVoice()');
      await waitFor(win,'Boolean(window.coveMediaQA.rtc.inVoice)');
    }
    for(const win of windows)await waitFor(win,'window.coveMediaQA.rtc.voiceMembers.length===2');
    const [sender,viewer]=windows;
    await sender.webContents.executeJavaScript("window.coveMediaQA.rtc.startScreenShare('1080p',30,false,false,true)");
    await waitFor(sender,'Boolean(window.coveMediaQA.rtc.localScreen)');
    await waitFor(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');
    await viewer.webContents.executeJavaScript('window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');
    await waitFor(viewer,'document.querySelector("video").videoWidth===640&&document.querySelector("video").readyState>=2');
    const pixel=await viewer.webContents.executeJavaScript('(()=>{const c=document.createElement("canvas");c.width=1;c.height=1;c.getContext("2d").drawImage(document.querySelector("video"),0,0,1,1);return [...c.getContext("2d").getImageData(0,0,1,1).data]})()');
    assert.ok(pixel[0]+pixel[1]+pixel[2]>100,'remote frame must not be black');
    await sender.webContents.executeJavaScript('window.coveMediaQA.rtc.stopScreenShare()');
    await waitFor(viewer,'!window.coveMediaQA.rtc.remoteScreen');
    for(const win of windows)assert.equal(await win.webContents.executeJavaScript('window.coveMediaQA.rtc.inVoice'),true,'stopping screen must preserve voice');
    for(const win of windows)await win.webContents.executeJavaScript('window.coveMediaQA.rtc.leaveVoice()');
    console.log('PASS: two real Chromium/WebRTC peers, synthetic mic, screen publish/watch, non-black decoded frame and independent screen teardown.');
    clearTimeout(watchdog);await finish(0);
  }catch(error){console.error(error);clearTimeout(watchdog);await finish(1);}
});
