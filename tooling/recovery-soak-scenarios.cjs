const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evalIn=(win,code)=>win.webContents.executeJavaScript(code);
async function runRecoverySoak({sender,viewer,proxy,waitFor,backendRequest,durationSeconds,onProgress=()=>{}}){
 const peers=[sender,viewer];const started=Date.now();const cycles=[],mediaFaults=[];
 const operations={voiceJoins:0,voiceLeaves:0,shareStarts:0,shareStops:0,watchStarts:0,watchCancels:0,signalRecoveries:0,mediaRecoveries:0,muteToggles:0};
 async function join(){for(const peer of peers){await evalIn(peer,'window.coveMediaQA.rtc.joinVoice()');operations.voiceJoins++;await waitFor(peer,'window.coveMediaQA.rtc.inVoice');}}
 async function share(){await evalIn(sender,"window.coveMediaQA.rtc.startScreenShare('1080p',30,false,false,true,true)");operations.shareStarts++;await waitFor(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');await evalIn(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');operations.watchStarts++;await waitFor(viewer,'Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector("video").readyState>=2');}
 async function stopShare(){await evalIn(sender,'window.coveMediaQA.rtc.stopScreenShare()');operations.shareStops++;await waitFor(viewer,'!window.coveMediaQA.rtc.remoteScreen');}
 async function leave(){for(const peer of peers){await evalIn(peer,'window.coveMediaQA.rtc.leaveVoice()');operations.voiceLeaves++;}await delay(3500);}
 async function resources(){return {clients:await Promise.all(peers.map(peer=>evalIn(peer,'window.coveMediaQA.resources()'))),server:(await backendRequest('snapshot')).resources};}
 function assertClean(snapshot,baseline){for(const [index,client] of snapshot.clients.entries()){
  for(const key of ['peerConnections','liveTracks','liveTransports','liveProducers','liveConsumers','analysisTaps','intervals'])assert.equal(client[key],0,`peer ${index} leftover ${key}`);
  // The mounted useAudioMeters owner intentionally retains one reusable output
  // context for presence sounds. Capture/processing/analysis contexts must close.
  assert.ok(client.audioContexts<=1,'at most the mounted hook output context may remain');
  assert.equal(client.audioContexts,baseline.clients[index].audioContexts,'audio contexts must return to the same mounted-owner baseline');
  assert.equal(client.socketListeners,baseline.clients[index].socketListeners,'socket listeners must not grow');
  assert.ok(client.timeouts<=baseline.clients[index].timeouts+1,'pending JS timeouts must stay bounded');
 }assert.equal(snapshot.server.transports,0);assert.equal(snapshot.server.producers,0);assert.equal(snapshot.server.consumers,0);assert.equal(snapshot.server.peers,baseline.server.peers);}
 // Baseline negotiation explicitly opened the diagnostic panel. Close that UI
 // intent before checking voice-owned timer cleanup; its polling is intentional.
 await evalIn(sender,'window.coveMediaQA.rtc.toggleStats()');
 await stopShare();await leave();const baseline=await resources();assertClean(baseline,baseline);
 while(Date.now()-started<durationSeconds*1000){
  const cycle=cycles.length+1;await join();await share();
  await evalIn(viewer,'window.coveMediaQA.rtc.stopWatchingScreen()');operations.watchCancels++;await waitFor(viewer,'!window.coveMediaQA.rtc.remoteScreen');
  await evalIn(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');operations.watchStarts++;
  await waitFor(viewer,'Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector("video").readyState>=2');
  if(cycle%2===0){
   await evalIn(viewer,'window.coveMediaQA.rtc.toggleMute()');operations.muteToggles++;
   const before=await evalIn(viewer,'window.coveMediaQA.ice.snapshot()');
   await evalIn(viewer,`new Promise((resolve,reject)=>{const s=window.coveMediaQA.socket,id=s.id;const timer=setTimeout(()=>reject(Error('signal recovery timeout')),8000);s.once('connect',()=>{clearTimeout(timer);resolve(s.id===id&&s.recovered);});s.io.engine.close();})`).then(value=>assert.equal(value,true));operations.signalRecoveries++;
   const after=await evalIn(viewer,'window.coveMediaQA.ice.snapshot()');assert.deepEqual(after.map(t=>[t.id,t.restartCalls]),before.map(t=>[t.id,t.restartCalls]),'healthy signal interruption must not restart/recreate transports');
   assert.equal(await evalIn(viewer,'window.coveMediaQA.rtc.isMuted'),true);await evalIn(viewer,'window.coveMediaQA.rtc.toggleMute()');operations.muteToggles++;
  }
  if(cycle%4===0){
   const prior=await evalIn(viewer,'window.coveMediaQA.ice.snapshot().find(t=>t.direction==="recv"&&t.state==="connected")');
   proxy.setBlocked(true);await waitFor(viewer,`window.coveMediaQA.ice.snapshot().some(t=>t.id===${JSON.stringify(prior.id)}&&t.restartCalls>${prior.restartCalls})`);
   const blocked=await evalIn(viewer,'window.coveMediaQA.ice.audioProgress()');
   const blockedFrames=await evalIn(viewer,'window.coveMediaQA.ice.decodedFrames()');proxy.setBlocked(false);
   await waitFor(viewer,`window.coveMediaQA.ice.snapshot().some(t=>t.id===${JSON.stringify(prior.id)}&&t.state==="connected")`);
   await waitFor(viewer,`window.coveMediaQA.ice.decodedFrames().then(n=>n>${blockedFrames}+2)`);
   await waitFor(viewer,`window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${blocked.packets}+2&&a.nonConcealedSamples>${blocked.nonConcealedSamples}+960)`);operations.mediaRecoveries++;
   mediaFaults.push({cycle,blockedFrames,resumedFrames:await evalIn(viewer,'window.coveMediaQA.ice.decodedFrames()'),blockedAudio:blocked,resumedAudio:await evalIn(viewer,'window.coveMediaQA.ice.audioProgress()'),decodedVideoFramesResumed:true});
  }
  const live=await resources();assert.ok(live.clients.every(client=>client.liveProducers<=2&&client.liveConsumers<=2),'no duplicate producers/consumers');
  await waitFor(viewer,'window.coveMediaQA.ice.audioDiagnostics().then(d=>d.taps.some(t=>t.label==="consumer"&&t.rms>1e-5))');
  await stopShare();await leave();const clean=await resources();assertClean(clean,baseline);
  const record={cycle,elapsedMs:Date.now()-started,live,clean,proxy:proxy.counts()};cycles.push(record);onProgress(record);
  await delay(3000);
 }
 return {requestedSeconds:durationSeconds,elapsedMs:Date.now()-started,cycles:cycles.length,operations,mediaFaults,baseline,last:cycles.at(-1),samples:cycles,
  scope:'timed repeated join/leave, watch cancellation, share on/off and loopback signal/media faults; not a continuous long call or physical network handoff',nativeTimersMeasured:false};
}
module.exports={runRecoverySoak};
