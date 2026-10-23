// Real Chromium/SFU cases. Every fault is injected into this fixture's own
// loopback proxy or backend; no physical network/device settings are touched.
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=(peer,code)=>peer.webContents.executeJavaScript(code);
async function runRecoveryBrowserScenarios({sender,viewer,proxy,waitFor,backendRequest,grantControl}){
 const evidence={};
 const state=peer=>evaluate(peer,'({inVoice:window.coveMediaQA.rtc.inVoice,sharing:Boolean(window.coveMediaQA.rtc.localScreen),watching:Boolean(window.coveMediaQA.rtc.remoteScreen),muted:window.coveMediaQA.rtc.isMuted,transports:window.coveMediaQA.ice.snapshot()})');
 async function watch(){await waitFor(viewer,'window.coveMediaQA.rtc.availableScreens.length===1');await evaluate(viewer,'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');await waitFor(viewer,'Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector("video").readyState>=2');}
 async function join(peer){await evaluate(peer,'window.coveMediaQA.rtc.joinVoice()');await waitFor(peer,'window.coveMediaQA.rtc.inVoice');}
 async function beginFault(){const recv=(await state(viewer)).transports.find(t=>t.direction==='recv'&&t.state==='connected');assert.ok(recv);proxy.setBlocked(true);await waitFor(viewer,`window.coveMediaQA.ice.snapshot().some(t=>t.id===${JSON.stringify(recv.id)}&&t.restartCalls>${recv.restartCalls})`);return recv;}
 // Explicitly cancelling viewing while the shared voice transport recovers must
 // not resurrect the video consumer when its ICE path comes back.
 const cancelled=await beginFault();await evaluate(viewer,'window.coveMediaQA.rtc.stopWatchingScreen()');proxy.setBlocked(false);
 await waitFor(viewer,`window.coveMediaQA.ice.snapshot().some(t=>t.id===${JSON.stringify(cancelled.id)}&&t.state==='connected')`);
 const audio=await evaluate(viewer,'window.coveMediaQA.ice.audioProgress()');await waitFor(viewer,`window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${audio.packets}+2&&a.nonConcealedSamples>${audio.nonConcealedSamples}+960)`);
 await delay(1000);assert.equal((await state(viewer)).watching,false);evidence.cancelWatchingDuringRecovery={passed:true,voiceRetained:(await state(viewer)).inVoice};
 // Leaving during an active ICE restart cancels the owner, including callbacks
 // arriving after the application proxy has resumed forwarding.
 await watch();await beginFault();await evaluate(viewer,'window.coveMediaQA.rtc.leaveVoice()');proxy.setBlocked(false);await delay(3500);
 const left=await state(viewer);assert.equal(left.inVoice,false);assert.equal(left.watching,false);assert.ok(left.transports.every(t=>!t.producers.length&&!t.consumers.length));
 evidence.leaveDuringRecovery={passed:true,liveResources:await evaluate(viewer,'window.coveMediaQA.resources()')};
 // Keep a real path broken until the bounded strategy gives up. Then reopening
 // the proxy must not silently recapture/rejoin or resume remote control.
 await join(viewer);await watch();const exhausted=await beginFault();
 await waitFor(viewer,'!window.coveMediaQA.rtc.inVoice',45000);const exhaustedState=await state(viewer);
 const attempts=exhaustedState.transports.find(t=>t.id===exhausted.id).restartCalls-exhausted.restartCalls;
 assert.ok(attempts>=1&&attempts<=3,'ICE recovery must stop after at most three applies');
 proxy.setBlocked(false);await delay(3500);assert.equal((await state(viewer)).inVoice,false);
 assert.equal(await evaluate(viewer,'window.coveMediaQA.control.active'),false);
 evidence.retryExhaustion={passed:true,restartApplies:attempts,remainsLeftAfterProxyReturns:true};
 // Restart the disposable actual backend, dropping server session state while
 // keeping its fixture DB and endpoint. Fresh sessions require explicit rejoin.
 await join(viewer);await watch();await grantControl();
 const oldIds=await Promise.all([sender,viewer].map(peer=>evaluate(peer,'window.coveMediaQA.socket.id')));
 await backendRequest('restart');
 for(const [index,peer] of [sender,viewer].entries()){
  await waitFor(peer,`window.coveMediaQA.ready&&window.coveMediaQA.socket.connected&&window.coveMediaQA.socket.id!==${JSON.stringify(oldIds[index])}&&!window.coveMediaQA.socket.recovered&&!window.coveMediaQA.rtc.inVoice`);
  const fresh=await state(peer);assert.equal(fresh.sharing,false);assert.equal(fresh.watching,false);
 }
 assert.equal(await evaluate(viewer,'window.coveMediaQA.control.active'),false);
 await delay(3500);const resources=await backendRequest('snapshot');
 assert.equal(resources.resources.transports,0);assert.equal(resources.resources.producers,0);assert.equal(resources.resources.consumers,0);
 evidence.serverRestartFreshSession={passed:true,autoRejoin:false,autoShare:false,autoWatch:false,remoteControlRestored:false,resources:resources.resources};
 // The newly registered server session must still support an explicit clean
 // join after the previous generation's callbacks and transports were disposed.
 await join(sender);await join(viewer);await evaluate(sender,"window.coveMediaQA.rtc.startScreenShare('1080p',30,false,false,true,true)");await watch();
 await waitFor(viewer,'window.coveMediaQA.ice.audioDiagnostics().then(d=>d.taps.some(t=>t.label==="consumer"&&t.rms>1e-5&&t.tracks.some(t=>t.state==="live")))');
 evidence.explicitRejoinAfterServerRestart={passed:true};
 return evidence;
}
module.exports={runRecoveryBrowserScenarios};
