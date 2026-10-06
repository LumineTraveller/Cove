const {app,BrowserWindow}=require('electron');
const path=require('node:path'), fs=require('node:fs');
const artifacts=path.resolve(process.env.COVE_UI_QA_ARTIFACTS||'runtime/annotation-update/cursor');
fs.mkdirSync(artifacts,{recursive:true});app.setPath('userData',path.join(artifacts,'profile'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
const checks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
const timeout=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=s=>win.webContents.executeJavaScript(s,true);
  const wait=async(s)=>{for(let i=0;i<160;i++){if(await js(s))return;await delay(25);}throw Error(s);};
  const check=async(s,label)=>{const passed=Boolean(await js(s));checks.push({label,passed});if(!passed)throw Error(label);};
  try{
    await win.loadURL(process.env.COVE_UI_QA_URL||'http://127.0.0.1:55483/tests/ui/remote-cursor-qa.html');
    await wait("document.querySelector('.remote-video-surface')?.getAttribute('aria-busy')==='false'");
    await check("!getComputedStyle(document.querySelector('video')).cursor.includes('data:image')",'normal viewing has no remote dot');
    await js('cursorQa.setActive(true)');await wait("Boolean(document.querySelector('.controlling'))");
    await check("getComputedStyle(document.querySelector('video')).cursor.includes('data:image/svg+xml')",'authorized control uses the dot on actual video');
    await check("getComputedStyle(document.querySelector('#outside')).cursor.indexOf('data:image')<0",'leaving the area restores normal CSS cursor');
    const image=await js(`(async()=>{const cursor=getComputedStyle(document.querySelector('video')).cursor,uri=cursor.match(/url\\(\"([^\"]+)\"\\)/)[1],image=new Image();image.src=uri;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return {cursor,width:image.width,height:image.height,center:[...c.getContext('2d').getImageData(4,4,1,1).data]}})()`);
    if(image.width!==8||image.height!==8||!image.cursor.includes('4 4')||image.center[0]<240)throw Error('Dot image/hotspot incorrect');
    checks.push({label:'Chromium decodes an 8px centered white dot with exact 4,4 hotspot',passed:true});
    const r=await js("document.querySelector('video').getBoundingClientRect().toJSON()");
    win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(r.left+10),y:Math.round(r.top+r.height/2),button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(r.left+10),y:Math.round(r.top+r.height/2),button:'left',clickCount:1});await delay(80);
    await check("cursorQa.inputs.length===0",'letterbox clicking does not map into the remote source');
    for(const reason of ['stop','revoke','disconnect','annotation mode']){
      await js('cursorQa.setActive(false)');await wait("!document.querySelector('.controlling')");
      await check("!getComputedStyle(document.querySelector('video')).cursor.includes('data:image')",reason+' removes dot at the component authorization boundary');
      await js('cursorQa.setActive(true)');await wait("Boolean(document.querySelector('.controlling'))");
    }
    await js('cursorQa.setVisible(false)');await wait("!document.querySelector('video')");
    await check("getComputedStyle(document.body).cursor.indexOf('data:image')<0",'closing viewing leaves no dot outside the removed component');
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:true,checks,image},null,2));
    console.log(`PASS ${checks.length} remote cursor checks`);clearTimeout(timeout);win.destroy();app.exit(0);
  }catch(error){fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));console.error(error);clearTimeout(timeout);win.destroy();app.exit(1);}
});
