const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
app.setPath('userData',fs.mkdtempSync(path.join(root,'runtime','package-ui-')));
const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
  // Renderer-only packaging gate. No updater, microphone or production API.
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>done({cancel:true}));
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,done)=>done(false));
  try{
    await win.loadFile(path.join(root,'apps/desktop/dist-app-refactor-final/win-unpacked/resources/app.asar/dist/index.html'));
    for(let index=0;index<100;index++){
      if(await win.webContents.executeJavaScript('Boolean(document.querySelector("#login-email")&&document.querySelector("#login-server"))'))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("#login-email")&&document.querySelector("#login-password"))'),true);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".auth-brand img").naturalWidth>0'),true);
    console.log('PASS: packaged desktop React/CSS/branding assets render with network and capture disabled.');
    clearTimeout(timeout);win.destroy();app.exit(0);
  }catch(error){console.error(error);clearTimeout(timeout);win.destroy();app.exit(1);}
});
