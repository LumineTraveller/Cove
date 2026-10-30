'use strict';
const fs=require('node:fs'),path=require('node:path');
const TIMEOUT_MS=60000,POLL_MS=50;
const READY_FILE='foreground-ready.json',CONTINUE_FILE='foreground-continue';
function foregroundGateEnabled(env=process.env){
  const value=env.COVE_FULL_UI_FOREGROUND_GATE??'0';
  if(!['0','1'].includes(value))throw Error('Invalid full App foreground gate');
  return value==='1';
}
async function waitForForegroundGate({directory,validate,onUpdate=()=>{},isCancelled=()=>false,
  files=fs.promises,now=()=>performance.now(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof validate!=='function')
    throw Error('Foreground gate requires the existing absolute result directory and original presentation guard');
  const ready=path.join(directory,READY_FILE),continuation=path.join(directory,CONTINUE_FILE);
  const state={enabled:true,status:'preparing',timeoutMs:TIMEOUT_MS,pollMs:POLL_MS,actualWaitMs:0,continued:false,verified:false};
  const exists=async()=>{
    try{const entry=await files.lstat(continuation);if(!entry.isFile())throw Error('Foreground continue marker must be a regular file');return true;}
    catch(error){if(error?.code==='ENOENT')return false;throw error;}
  };
  let started=null;
  try{
    if(await exists())throw Error('Foreground continue marker existed before readiness');
    await files.writeFile(ready,JSON.stringify({schemaVersion:1,stage:'before-initial-screen-share',
      timeoutMs:TIMEOUT_MS,pollMs:POLL_MS,continueFile:CONTINUE_FILE})+'\n',{flag:'wx'});
    started=now();state.status='waiting';onUpdate({...state});
    for(;;){
      if(isCancelled())throw Error('Foreground gate cancelled before screen sharing');
      const elapsed=now()-started;
      if(elapsed>=TIMEOUT_MS){state.status='timed-out';throw Error('Foreground gate timed out after 60 seconds');}
      const continued=await exists();
      state.actualWaitMs=now()-started;
      if(state.actualWaitMs>=TIMEOUT_MS){state.status='timed-out';throw Error('Foreground gate timed out after 60 seconds');}
      if(continued){
        if(isCancelled())throw Error('Foreground gate cancelled before screen sharing');
        state.continued=true;state.status='validating';
        // The caller supplies the unchanged source/publisher/display guard.
        // No gate branch changes focus, stacking, bounds or renderer policy.
        await validate();
        if(isCancelled())throw Error('Foreground gate cancelled before screen sharing');
        state.verified=true;state.status='continued';onUpdate({...state});return {...state};
      }
      await delay(Math.min(POLL_MS,TIMEOUT_MS-state.actualWaitMs));
    }
  }catch(error){
    if(started!==null&&!state.continued)state.actualWaitMs=now()-started;
    if(state.status!=='timed-out')state.status=isCancelled()?'cancelled':'failed';
    onUpdate({...state});throw error;
  }
}
module.exports={foregroundGateEnabled,waitForForegroundGate,TIMEOUT_MS,POLL_MS,READY_FILE,CONTINUE_FILE};
