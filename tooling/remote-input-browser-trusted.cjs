const {app,BrowserWindow,screen}=require('electron');
const fs=require('fs'),path=require('path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),out=path.join(root,'runtime/remote-input-trusted');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.setPath('sessionData',path.join(out,'session'));
const source=fs.readFileSync(path.join(root,'apps/desktop/src/features/remote-control/remoteControl.ts'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const css=fs.readFileSync(path.join(root,'apps/desktop/src/styles/ui-v2.css'),'utf8');
fs.writeFileSync(path.join(out,'probe.html'),`<!doctype html><style>${css}</style><div class="cove-window-titlebar"></div><div class="share-view screen-maximized"><div class="remote-video-surface controlling" id="target"><span class="remote-control-frame"></span></div></div><script>const exports={};${code}
let rows=[],sent=[],mode='pointermove',sender;
const target=document.querySelector('#target');
function start(m){mode=m;rows=[];sent=[];sender?.cancel();sender=new exports.RemotePointerSender(input=>sent.push({at:performance.now(),x:input.x}));}
for(const kind of ['pointermove','pointerrawupdate'])target.addEventListener(kind,e=>{rows.push({kind,at:performance.now(),x:e.clientX,trusted:e.isTrusted});if(kind===mode)sender.send({type:'pointer',x:e.clientX/800,y:.5});});
window.probe={start,result:()=>({rows,sent,rawSupported:'onpointerrawupdate' in window,secure:isSecureContext,topHit:document.elementFromPoint(200,10)?.className})};</script>`);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:800,height:500,frame:false,show:true,webPreferences:{backgroundThrottling:false}});
 const watchdog=setTimeout(()=>app.exit(2),15000);
 try{
  await win.loadFile(path.join(out,'probe.html'));const results=[];
  for(const mode of ['pointermove','pointerrawupdate']){
   await win.webContents.executeJavaScript(`probe.start(${JSON.stringify(mode)})`);await delay(80);
   const start=performance.now();for(let i=0;i<150;i++){
    const due=start+i*8;while(performance.now()<due)await delay(1);
    win.webContents.sendInputEvent({type:'mouseMove',x:120+(i%100)*5,y:180});
   }await delay(50);results.push({mode,...await win.webContents.executeJavaScript('probe.result()')});
  }
  const stat=a=>{a.sort((a,b)=>a-b);return{n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)}};
  const report={observedUTC:new Date().toISOString(),display:screen.getPrimaryDisplay(),results:results.map(r=>({mode:r.mode,rawSupported:r.rawSupported,secure:r.secure,topHit:r.topHit,events:r.rows.reduce((a,e)=>(a[e.kind]=(a[e.kind]||0)+1,a),{}),untrusted:r.rows.filter(e=>!e.trusted).length,sent:r.sent.length,gaps:stat(r.sent.slice(1).map((s,i)=>s.at-r.sent[i].at))}))};
  fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({report,results},null,2));console.log(JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'window.png'),(await win.webContents.capturePage()).toPNG());
 }finally{clearTimeout(watchdog);win.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1)});
