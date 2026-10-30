'use strict';
const path=require('node:path');
const {ipcMain,session}=require('electron');
exports.installOwnedFullProductMain=({root,peers,rendererOrigin,backendOrigin,result})=>{
  for(const value of [rendererOrigin,backendOrigin])if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(value))throw Error('Full App requires exact loopback origins');
  const {AnnotationOverlayController}=require(path.join(root,'apps/desktop/dist-electron/annotation-overlay.js'));
  const voiceMode=process.env.COVE_FULL_UI_VOICE??'muted';
  const meterDiagnostic=process.env.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC==='1';
  const state={enabled:true,syntheticMessages:200,voiceMode,expectedSelfMuted:voiceMode==='muted',statsEnabled:process.env.COVE_FULL_UI_STATS==='1',
    frameSink:process.env.COVE_FULL_UI_FRAME_SINK??'generator',codec:process.env.COVE_FULL_UI_CODEC??'av1',
    flatDiagnostics:{enabled:process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1',diagnosticOnly:process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1',
      meaning:'Fixed backdrop-filter-only fixture control; same original four motion phases and continuous LOW history.'},
    foregroundGate:{enabled:process.env.COVE_FULL_UI_FOREGROUND_GATE==='1',timeoutMs:60000,pollMs:50,
      meaning:'Optional pre-publication readiness only; the original foreground and geometry guards run after continue.'},
    syntheticMicrophone:{provider:'screen-performance-fixture',gainMin:voiceMode==='muted'?0.03:0.005,gainMax:voiceMode==='muted'?0.03:0.05,curveSeconds:voiceMode==='muted'?0:120,physicalMicrophone:false,humanVoice:false,speakerOutput:false},
    devToolsOpened:false,blockedNetworkRequests:0,samples:[],
    inputIsolation:{enabled:true,blockedKeyboard:0,blockedMouse:0,abortRequested:false},
    meterTransitionDiagnostic:{enabled:meterDiagnostic,diagnosticOnly:meterDiagnostic,sampleSeconds:meterDiagnostic?24:null,
      phases:meterDiagnostic?[{sampleIndex:0,phase:'normal-a'},{sampleIndex:8,phase:'transition-none'},{sampleIndex:16,phase:'normal-a2'}]:[],
      meaning:'Same capture/producer CSS A/B/A diagnostic only. Do not treat the mixed overall summary as a product performance gain.'},
    meaning:'Actual App/HashRouter/ChatRoom/useRoomController; loopback test accounts and 200 synthetic messages. No physical scan-out claim. Updater, passwords, external links and remote OS input are unavailable in this isolated baseline.'};
  result.fullProductUi=state;
  const owned=event=>peers.find(win=>!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&
    (()=>{try{return new URL(event.senderFrame.url).origin===rendererOrigin;}catch{return false;}})());
  const publisher=event=>owned(event)===peers[0];
  const send=(channel,value)=>{if(peers[0]&&!peers[0].isDestroyed())peers[0].webContents.send(channel,value);};
  const overlay=new AnnotationOverlayController((token,reason)=>send('cove:annotation-overlay:failure',{token,reason}),
    (token,input)=>send('cove:annotation-overlay:input',{token,input}));
  const channels=[],stopOwnedInputs=[];
  const handle=(channel,callback)=>{channels.push(channel);ipcMain.handle(channel,(event,...args)=>{const win=owned(event);return win?callback(win,event,...args):false;});};
  handle('cove:window:is-maximized',win=>win.isMaximized());
  handle('cove:window:minimize',win=>{win.minimize();return true;});
  handle('cove:window:toggle-maximize',win=>{if(win.isMaximized())win.unmaximize();else win.maximize();return win.isMaximized();});
  handle('cove:window:focus',win=>{if(win.isMinimized())win.restore();win.show();win.focus();return win.isFocused();});
  handle('cove:window:close',win=>{win.close();return true;});
  handle('cove:annotation-overlay:bind',(_win,event,id)=>publisher(event)?overlay.bind(id):{error:'Not the owned publisher'});
  handle('cove:annotation-overlay:update',(_win,event,token,frame)=>publisher(event)&&overlay.update(token,frame));
  handle('cove:annotation-overlay:input-mode',(_win,event,token,active)=>publisher(event)&&active===false&&overlay.setInputActive(token,false));
  handle('cove:annotation-overlay:close',(_win,event,token)=>{if(!publisher(event)||typeof token!=='string')return false;overlay.close(token);return true;});
  handle('cove:remote-control:set-active',(_win,_event,id)=>id===null?{ok:true}:{ok:false,reason:'Isolated benchmark does not inject OS input'});
  handle('cove:remote-control:input',()=>false);
  const disabled={status:'disabled',currentVersion:require(path.join(root,'apps/desktop/package.json')).version,
    latestVersion:null,progress:null,downloadedFile:null,error:null,message:'Isolated local benchmark'};
  for(const channel of ['cove:update:get-state','cove:update:check','cove:update:download','cove:update:cancel'])handle(channel,()=>disabled);
  for(const channel of ['cove:update:install','cove:update:open-release','cove:shell:open-external'])handle(channel,()=>false);
  for(const channel of ['cove:integrity:get-state','cove:integrity:check'])handle(channel,()=>({status:'unavailable',reason:'isolated-benchmark'}));
  for(const channel of ['cove:account-password:status','cove:account-password:get','cove:account-password:set',
    'cove:account-password:remove','cove:account-password:clear','cove:server-access:get','cove:server-access:set',
    'cove:server-access:remove','cove:server-access:clear'])handle(channel,()=>({available:false,ok:false,grant:null}));
  handle('cove:security:resolve-server-addresses',(_win,_event,hostname)=>hostname==='127.0.0.1'?['127.0.0.1']:[]);
  handle('cove:security:set-server-certificate-exception',(_win,_event,url,enabled)=>url===backendOrigin&&enabled===false?backendOrigin:null);
  const allowed=new Set([rendererOrigin,backendOrigin]);
  for(let index=0;index<peers.length;index++){
    const win=peers[index],wc=win.webContents;
    wc.setWindowOpenHandler(()=>({action:'deny'}));
    wc.on('will-navigate',(event,url)=>{let same=false;try{same=new URL(url).origin===rendererOrigin;}catch{}if(!same){state.blockedNetworkRequests++;event.preventDefault();}});
    wc.on('devtools-opened',()=>{state.devToolsOpened=true;});
    // Scope input isolation to these disposable benchmark peers. Escape cancels
    // on the next assertion or foreground-gate poll; typed content is never retained.
    wc.on('before-input-event',(event,input)=>{
      event.preventDefault();
      if(input.type==='keyDown'&&input.key==='Escape')state.inputIsolation.abortRequested=true;
      else state.inputIsolation.blockedKeyboard=Math.min(1000,state.inputIsolation.blockedKeyboard+1);
    });
    // Installed Electron 44 exposes this cancellable event before page dispatch.
    // Keep pointer/hover input out of owned peers; never retain event coordinates.
    const blockMouse=event=>{event.preventDefault();state.inputIsolation.blockedMouse=Math.min(1000,state.inputIsolation.blockedMouse+1);};
    wc.on('before-mouse-event',blockMouse);
    stopOwnedInputs.push(()=>{if(!wc.isDestroyed())wc.off('before-mouse-event',blockMouse);});
    for(const event of ['maximize','unmaximize'])win.on(event,()=>{if(!win.isDestroyed())wc.send('cove:window-state',win.isMaximized());});
    const isolated=session.fromPartition('cove-full-product-ui-'+index);
    isolated.webRequest.onBeforeRequest((details,callback)=>{
      let blocked=false;
      try{const url=new URL(details.url);if(['http:','https:','ws:','wss:'].includes(url.protocol)){
        const origin=url.origin.replace(/^ws:/,'http:').replace(/^wss:/,'https:');blocked=!allowed.has(origin);
      }}catch{blocked=true;}
      if(blocked)state.blockedNetworkRequests++;callback({cancel:blocked});
    });
  }
  return {setCaptureSource:source=>overlay.setCaptureSource(source),
    isCancelled(){return state.inputIsolation.abortRequested===true;},
    assert(){if(state.inputIsolation.abortRequested)throw Error('Owned benchmark cancelled by Escape');
      if(state.devToolsOpened||state.blockedNetworkRequests)throw Error('Full App external-network/no-DevTools contract was lost');},
    dispose(){overlay.setCaptureSource(null);for(const stop of stopOwnedInputs)stop();for(const channel of channels)ipcMain.removeHandler(channel);},
  };
};
