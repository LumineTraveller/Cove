'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const relative='tooling/full-product-ui-benchmark';
function replaceOnce(source,before,after,label){
  if(source.split(before).length!==2)throw Error('Full App adapter source contract changed: '+label);
  return source.replace(before,after);
}
function qualifyFullProductDisplay(displays){
  if(!Array.isArray(displays)||displays.length!==1)return false;
  const display=displays[0],size=display?.size,scale=display?.scaleFactor;
  return Number.isFinite(scale)&&scale>0&&Number.isFinite(size?.width)&&Number.isFinite(size?.height)&&
    Math.abs(Math.round(size.width*scale)-2560)<=2&&Math.abs(Math.round(size.height*scale)-1600)<=2;
}
function productController(source){
  source=source.replace(/\r\n/g,'\n');
  source=replaceOnce(source,'export function useRoomController(', 'function useRoomControllerProduct(', 'controller export');
  return source+`\n// Isolated diagnostic bridge only; the actual product controller remains intact.\nexport function useRoomController(props: ChatRoomProps) {\n  const controller = useRoomControllerProduct(props);\n  useEffect(() => { (window as any).coveFullProductUiBridge?.commit(controller); });\n  useEffect(() => () => { (window as any).coveFullProductUiBridge?.roomUnmounted(); }, []);\n  return controller;\n}\n`;
}
function fixtureObserver(source){
  source=source.replace(/\r\n/g,'\n');
  return replaceOnce(source,"if (video.closest('[data-cove-performance-local-preview]')) continue;",
    "if (video.closest('[data-cove-performance-local-preview]') || (params.get('index') === '0' && video.closest('.share-view'))) continue;",'publisher per-frame observer exclusion');
}
function productChat(source){
  return replaceOnce(source.replace(/\r\n/g,'\n'),'  const imageRef = useRef<HTMLInputElement>(null);',
    '  (window as any).coveFullProductUiBridge?.chatRender();\n  const imageRef = useRef<HTMLInputElement>(null);','chat component body counter');
}
function launcher(source){
  source=source.replace(/\r\n/g,'\n');
  source=replaceOnce(source,"[path.join(root,'apps/desktop/tests/ui/screen-performance.electron.cjs')]",
    `[path.join(root,'${relative}/electron.cjs')]`,'owned Electron entry');
  const start=source.indexOf('  fs.writeFileSync(bootstrap,`import {createServer,normalizePath}');
  const end=source.indexOf('\n  let vite,electron;',start);
  if(start<0||end<start)throw Error('Full App adapter source contract changed: Vite bootstrap');
  source=source.slice(0,start)+`  fs.writeFileSync(bootstrap,require(path.join(root,'${relative}/vite-bootstrap.cjs')).source({root,directory,entry,dependencies}));`+source.slice(end);
  source=replaceOnce(source,"  fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({",
    `  sources.push('apps/desktop/src/app/App.tsx','apps/desktop/src/features/rooms/ChatRoomV2.tsx','apps/desktop/src/features/rooms/useRoomController.ts','apps/desktop/src/features/chat/ChatPanelV2.tsx','apps/desktop/src/features/media/audio/useAudioMeters.ts',...fs.readdirSync(path.join(root,'${relative}')).filter(file=>/\\.(?:cjs|ts|tsx|html)$/.test(file)).map(file=>'${relative}/'+file));\n  fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({fullProductUi:{enabled:true,syntheticMessages:200,frameSink:process.env.COVE_FULL_UI_FRAME_SINK??'generator',codec:process.env.COVE_FULL_UI_CODEC??'av1',voiceMode:process.env.COVE_FULL_UI_VOICE??'muted',expectedSelfMuted:process.env.COVE_FULL_UI_VOICE!=='synthetic-varying',syntheticMicrophone:{provider:'screen-performance-fixture',gainMin:process.env.COVE_FULL_UI_VOICE==='synthetic-varying'?0.005:0.03,gainMax:process.env.COVE_FULL_UI_VOICE==='synthetic-varying'?0.05:0.03,curveSeconds:process.env.COVE_FULL_UI_VOICE==='synthetic-varying'?120:0,physicalMicrophone:false,humanVoice:false,speakerOutput:false},stats:process.env.COVE_FULL_UI_STATS==='1',devTools:false,hmr:false},`,'source provenance');
  source=replaceOnce(source,"'apps/desktop/src/features/media/audio/useAudioMeters.ts',",
    "'apps/desktop/src/features/media/audio/useAudioMeters.ts','apps/desktop/src/features/media/useWebRTC.ts','apps/desktop/src/features/media/audio/audioMeterLevels.ts','apps/desktop/src/features/media/components/AudioMeterBindings.tsx',",'audio meter source provenance');
  source=replaceOnce(source,'fullProductUi:{enabled:true,syntheticMessages:200,',
    "fullProductUi:{enabled:true,syntheticMessages:200,foregroundGate:{enabled:process.env.COVE_FULL_UI_FOREGROUND_GATE==='1',timeoutMs:60000,pollMs:50},",'foreground readiness source provenance');
  source=replaceOnce(source,'visiblePresentation:c.visiblePresentation,senderWindowBeforeSampling:',
    'visiblePresentation:c.visiblePresentation,motionScenario:c.motionScenario,senderWindowBeforeSampling:','motion phase console result');
  return replaceOnce(source,'fullProductUi:{enabled:true,syntheticMessages:200,',
    `fullProductUi:{enabled:true,syntheticMessages:200,flatDiagnostics:{enabled:process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1',diagnosticOnly:process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1'},motionSwitch:require(path.join(root,'${relative}/motion-scenario.cjs')).motionOptions(process.env),captureActivityPolicy:{requested:process.env.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE==='1',defaultBackgroundThrottling:true,scope:'Only the active native publisher renderer lease; original policy must restore on stop.'},meterTransitionDiagnostic:{enabled:process.env.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC==='1',diagnosticOnly:process.env.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC==='1',phases:[{sampleIndex:0,phase:'normal-a'},{sampleIndex:8,phase:'transition-none'},{sampleIndex:16,phase:'normal-a2'}],meaning:'Same-session CSS A/B/A diagnostic; mixed total summary is not product performance evidence.'},`,'diagnostic source provenance');
}
function electron(source){
  source=source.replace(/\r\n/g,'\n');
  source=replaceOnce(source,'      presentationGeometry=visiblePresentationGeometry(screen.getAllDisplays());',
    `      if(!require(path.join(root,'${relative}/source-adapters.cjs')).qualifyFullProductDisplay(screen.getAllDisplays()))throw Error('Full App 1728x1080 baseline requires one 2560x1600 display');\n      presentationGeometry=visiblePresentationGeometry(screen.getAllDisplays());`,'fixed 2560x1600 geometry qualification');
  source=replaceOnce(source,"[path.join(__dirname,'screen-performance-backend.cjs')]",
    `[path.join(root,'${relative}/backend.cjs')]`,'owned seed backend');
  source=replaceOnce(source,"const patternLayouts=require('./screen-performance-pattern-layouts.json');",
    `const patternLayouts=require('./screen-performance-pattern-layouts.json');\nconst {installOwnedFullProductMain}=require(path.join(root,'${relative}/owned-main.cjs'));\nconst fullUiStats=process.env.COVE_FULL_UI_STATS==='1';\nconst fullUiVoice=process.env.COVE_FULL_UI_VOICE??'muted',fullUiSelfMuted=fullUiVoice==='muted';\nif(!['muted','synthetic-varying'].includes(fullUiVoice))throw Error('Invalid full App voice control');\nlet fullUiMain=null;\nfunction forPeerSessions(method,...args){for(let index=0;index<2;index++)session.fromPartition('cove-full-product-ui-'+index)[method](...args);}`,'main bridge import');
  for(const method of ['setPermissionRequestHandler','setPermissionCheckHandler','setDisplayMediaRequestHandler'])
    source=replaceOnce(source,'session.defaultSession.'+method+'(',`forPeerSessions('${method}',`,'partition '+method);
  source=replaceOnce(source,"show:minimizeSender&&index===0,webPreferences:{offscreen,",
    "show:minimizeSender&&index===0,frame:false,title:'Cove isolated full App '+index,webPreferences:{partition:'cove-full-product-ui-'+index,offscreen,",'isolated peer storage');
  source=replaceOnce(source,'selectedCaptureSource=selected.source;sourceSelection=selected.metadata;',
    'selectedCaptureSource=selected.source;sourceSelection=selected.metadata;fullUiMain?.setCaptureSource(selected.source);','annotation source');
  source=replaceOnce(source,'    for(const config of cases){',
    `    fullUiMain=installOwnedFullProductMain({root,peers,rendererOrigin:process.env.COVE_QA_RENDERER_URL,backendOrigin:info.base,result});\n    for(const config of cases){`,'owned bridge setup');
  source=replaceOnce(source,"'/tests/ui/media-integration.html?'+query",
    `'/@fs/'+path.join(root,'${relative}/full-product.html').replace(/\\\\/g,'/')+'?'+query+'&fullProductUi=1&fullVoice='+fullUiVoice+'&fullStats='+(fullUiStats?'1':'0')+'&fullAccount='+encodeURIComponent(JSON.stringify(info.accounts[index].account))`,'full App URL');
  source=replaceOnce(source,"await wait(peers[index],'Boolean(window.coveMediaQA.rtc.inVoice)');",
    "await wait(peers[index],'Boolean(window.coveMediaQA.rtc.inVoice)');await js(peers[index],'if(window.coveMediaQA.rtc.isMuted!=='+fullUiSelfMuted+')window.coveMediaQA.rtc.toggleMute()');await wait(peers[index],'window.coveMediaQA.rtc.isMuted==='+fullUiSelfMuted);",'explicit synthetic voice mute state');
  // Match normal CaptureSettings: commit the requested preference before sharing.
  // This is fixture flow alignment, not a workaround for an ended stock track.
  source=replaceOnce(source,"      await startOwnedScreenShare(sender,config,'initial-publication-returned');",
    "      const fullUiCompatibilityTarget=Boolean(config.compatibility);\n      await boundedJs(sender,'window.coveMediaQA.rtc.setScreenCompatibilityMode('+fullUiCompatibilityTarget+');void 0',1000);\n      await wait(sender,'window.coveMediaQA.rtc.screenCompatibilityMode==='+fullUiCompatibilityTarget,3000);\n      if(fullUiForegroundGate&&(finished||shuttingDown||fullUiMain?.isCancelled()===true))throw Error('Foreground gate cancelled before screen sharing');\n      await startOwnedScreenShare(sender,config,'initial-publication-returned');",'settled compatibility preference before initial share');
  source=replaceOnce(source,'let fullUiMain=null;',
    "const fullUiMeterDiagnostic=process.env.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC==='1';\nconst fullUiFlatDiagnostics=process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1';\nlet fullUiMain=null;",'meter diagnostic main control');
  source=replaceOnce(source,'let fullUiMain=null;',
    `const {foregroundGateEnabled,waitForForegroundGate}=require(path.join(root,'${relative}/foreground-gate.cjs'));\nconst fullUiForegroundGate=foregroundGateEnabled();\nlet fullUiMain=null;`,'foreground readiness main control');
  source=replaceOnce(source,'      const nativeRequestsBefore=nativeRequests;',
    "      if(fullUiForegroundGate){await waitForForegroundGate({directory,validate:()=>assertOwnedVisiblePresentation(),isCancelled:()=>finished||shuttingDown||fullUiMain?.isCancelled()===true,onUpdate:state=>{result.foregroundGate=state;save();}});}\n      const nativeRequestsBefore=nativeRequests;",'bounded foreground readiness before initial publication');
  source=replaceOnce(source,"'&fullProductUi=1&fullVoice='",
    "'&fullProductUi=1&fullFlatDiagnostics='+(fullUiFlatDiagnostics?'1':'0')+'&fullMeterDiagnostic='+(fullUiMeterDiagnostic?'1':'0')+'&fullVoice='",'meter diagnostic renderer control');
  source=replaceOnce(source,'        const visibleBefore=assertOwnedVisiblePresentation();',
    "        if(fullUiMeterDiagnostic)await Promise.all(peers.map(win=>boundedJs(win,'window.coveFullProductMeterTransitionSample('+n+')',1000)));\n        const visibleBefore=assertOwnedVisiblePresentation();",'same session meter CSS boundaries');
  source=replaceOnce(source,'!pane.mounted||!pane.overlayMounted||!pane.statsEnabled||',
    '!pane.mounted||pane.overlayMounted!==fullUiStats||pane.statsEnabled!==fullUiStats||','explicit stats guard');
  source=replaceOnce(source,"pane.layout!=='top-strip-v1'||pane.overlayPosition!=='absolute'||\n            typeof pane.backdropFilter!=='string'||!pane.backdropFilter.includes('blur(')||",
    "pane.layout!=='top-strip-v1'||(fullUiStats&&(pane.overlayPosition!=='absolute'||\n            typeof pane.backdropFilter!=='string'||(fullUiFlatDiagnostics?pane.backdropFilter!=='none':!pane.backdropFilter.includes('blur('))))||",'conditional diagnostic CSS guard');
  source=replaceOnce(source,'        const visibleAfter=assertOwnedVisiblePresentation();',
    `        const visibleAfter=assertOwnedVisiblePresentation();\n        fullUiMain.assert();\n        for(const sample of [send,receive]){const full=sample.fullProductUi,mic=sample.syntheticAudio;\n          if(!full?.ready||full.syntheticMessages!==200||full.messageRows!==200||full.selfMuted!==fullUiSelfMuted||full.expectedSelfMuted!==fullUiSelfMuted||full.voiceMode!==fullUiVoice||!full.inVoice||full.statsEnabled!==fullUiStats)throw Error('Full App room/chat/mute/stats contract was lost');\n          if(mic?.provider!=='screen-performance-fixture'||mic.mode!==fullUiVoice||mic.physicalMicrophone!==false||mic.humanVoice!==false||mic.speakerOutput!==false||full.syntheticMicrophone?.provider!==mic.provider||full.syntheticMicrophone?.requests<1||full.syntheticMicrophone?.rejectedRequests!==0)throw Error('Isolated synthetic audio provider contract was lost');\n          if(!fullUiSelfMuted&&(mic.gainMin!==0.005||mic.gainMax!==0.05||mic.curveSeconds!==120||mic.sources.length<1||mic.sources.length>4||full.syntheticMicrophone.requests>4||mic.sources.filter(source=>source.trackState==='live').length!==1||mic.sources.some(source=>source.trackState!=='live'&&source.trackState!=='ended')||mic.sources.filter(source=>source.trackState==='live').some(source=>source.contextState!=='running'||source.trackState!=='live'||!source.trackEnabled||!(source.elapsedSeconds>=0&&source.elapsedSeconds<120))))throw Error('Varying synthetic audio curve/live-track contract was lost');\n        }\n        result.fullProductUi.samples.push({sender:send.fullProductUi,viewer:receive.fullProductUi});\n        if(!fullUiSelfMuted&&n===sampleSeconds){for(const role of ['sender','viewer']){const first=result.fullProductUi.samples[0][role],last=result.fullProductUi.samples[result.fullProductUi.samples.length-1][role];if(!(last.meterValueChanges>first.meterValueChanges&&last.controllerCommits>first.controllerCommits&&last.meterMaximum>0))throw Error('Synthetic voice did not produce changing actual product speakingLevels during sampling');}}`,'full App sample guard');
  source=replaceOnce(source,'  await delay(150);const backendResources=await backendSnapshot();',
    '  fullUiMain?.dispose();\n  await delay(150);const backendResources=await backendSnapshot();','bridge cleanup');
  source=replaceOnce(source,'last.controllerCommits>first.controllerCommits',
    "first.observationMode===last.observationMode&&(last.observationMode==='react-state'?last.controllerCommits>first.controllerCommits:last.observationMode==='external-store'&&last.activeHarnessMeterSubscriptions>0&&last.meterStoreNotifications>first.meterStoreNotifications)&&last.meterPositiveObservations>first.meterPositiveObservations",'actual RMS observation across state and store modes');
  source=replaceOnce(source,'if(!fullUiSelfMuted&&n===sampleSeconds){',
    "if(!fullUiSelfMuted&&n===sampleSeconds){for(const role of ['sender','viewer']){if(result.fullProductUi.samples[0][role].observationMode==='external-store'){const doms=result.fullProductUi.samples.map(sample=>sample[role].verticalMeterDom);if(!doms.every(dom=>dom?.mountedCount>0&&dom.sampledCount>0&&dom.invalidCount===0&&dom.values.length>0)||!doms.some(dom=>dom.values.some(value=>value>0))||new Set(doms.map(dom=>JSON.stringify(dom.values))).size<2)throw Error('Actual meter leaf DOM did not show nonzero changing inline values during sampling');}}}\n        if(!fullUiSelfMuted&&n===sampleSeconds){",'actual leaf DOM progress across the measured window');
  source=replaceOnce(source,"          if(mic?.provider!=='screen-performance-fixture'",
    "          if(!['react-state','external-store'].includes(full.observationMode)||(full.observationMode==='external-store'&&(!(full.activeHarnessMeterSubscriptions>0)||full.meterStoreSubscriptions<full.activeHarnessMeterSubscriptions||full.meterObservationStopped)))throw Error('Actual product meter observation contract was lost');\n          if(mic?.provider!=='screen-performance-fixture'",'live meter subscription sample guard');
  source=replaceOnce(source,'        fullUiMain.assert();',
    "        fullUiMain.assert();\n        if(fullUiMeterDiagnostic){for(const role of ['sender','viewer']){const sample=role==='sender'?send:receive,d=sample.fullProductUi?.meterTransitionDiagnostic;const phase=n<8?'normal-a':n<16?'transition-none':'normal-a2';const reference=result.fullProductUi.samples[0]?.[role]?.meterTransitionDiagnostic?.hoveredShellElements;if(!d?.enabled||!d.diagnosticOnly||d.disposed||d.phase!==phase||d.sampleIndex!==n||d.styleMounted!==(phase==='transition-none')||(reference!==undefined&&d.hoveredShellElements!==reference))throw Error('Meter transition phase/style/hover diagnostic contract was lost');}}",'meter diagnostic phase and stable hover guard');
  source=replaceOnce(source,'        fullUiMain.assert();',
    "        fullUiMain.assert();\n        if(fullUiStats){for(const sample of [send,receive]){const d=sample.fullProductUi?.flatDiagnostics,expected=fullUiFlatDiagnostics?'none':'blur(18px) saturate(1.18)';if(!d||d.enabled!==fullUiFlatDiagnostics||d.diagnosticOnly!==fullUiFlatDiagnostics||d.disposed||d.styleMounted!==fullUiFlatDiagnostics||d.expectedBackdropFilter!==expected||d.overlayCount!==1||d.backdropFilters?.length!==1||d.backdropFilters[0]!==expected)throw Error('Fixed flat diagnostics style contract was lost');}}",'fixed flat diagnostics style guard');
  source=replaceOnce(source,'          qa?.rtc.leaveVoice();qa?.socket.disconnect();',
    '          qa?.rtc.leaveVoice();\n          const fullProductRoom=await window.coveFullProductLeaveRoom?.();','leave room before App/socket teardown');
  source=replaceOnce(source,'          window.covePerformanceUnmount?.();',
    '          window.covePerformanceUnmount?.();\n          qa?.socket.disconnect();','disconnect after App teardown');
  source=replaceOnce(source,'return {fixture,product,localPreview,unmountAvailable,unmounted:unmountAvailable,normalEffectsCleanupWaitMs:',
    'return {fixture,product,localPreview,fullProductRoom,unmountAvailable,unmounted:unmountAvailable,normalEffectsCleanupWaitMs:','room teardown evidence');
  source=replaceOnce(source,'renderer.fixture?.passed===true&&renderer.unmountAvailable&&',
    'renderer.fixture?.passed===true&&renderer.fullProductRoom?.completed===true&&renderer.unmountAvailable&&','room teardown success guard');
  source=replaceOnce(source,'renderer.fixture?.passed===true&&renderer.fullProductRoom?.completed===true&&',
    'renderer.fixture?.passed===true&&renderer.fixture?.meterTransitionDiagnostic?.disposed===true&&renderer.fixture?.meterTransitionDiagnostic?.styleMounted===false&&renderer.fullProductRoom?.completed===true&&','diagnostic style cleanup guard');
  source=replaceOnce(source,'renderer.fixture?.meterTransitionDiagnostic?.styleMounted===false&&renderer.fullProductRoom?.completed===true&&',
    'renderer.fixture?.meterTransitionDiagnostic?.styleMounted===false&&renderer.fixture?.flatDiagnostics?.disposed===true&&renderer.fixture?.flatDiagnostics?.styleMounted===false&&renderer.fullProductRoom?.completed===true&&','flat diagnostics style cleanup guard');
  const originalResourceKeys="'timeouts','intervals','socketListeners'";
  if(source.split(originalResourceKeys).length!==3)throw Error('Full App adapter source contract changed: both cleanup resource lists');
  source=source.replaceAll(originalResourceKeys,originalResourceKeys+",'meterStoreSubscriptions','harnessMeterSubscriptions'");
  return motionElectron(source);
}
function motionElectron(source){
  source=replaceOnce(source,'let fullUiMain=null;',
    `const {motionOptions,createMotionScenario,motionSourceHtml}=require(path.join(root,'${relative}/motion-scenario.cjs'));\nconst fullUiMotionOptions=motionOptions(),fullUiKeepCaptureActive=fullUiMotionOptions.keepCaptureActive;\nfunction fullUiExpectedPublisherThrottling(){return !(fullUiKeepCaptureActive&&(brokerSnapshot()?.rendererActivityLeases??0)>0);}\nlet fullUiMotion=null;\nlet fullUiMain=null;`,'bounded motion/switch module');
  source=replaceOnce(source,'const fullUiMotionOptions=motionOptions(),',
    `const {visiblePresentationFailureContext}=require(path.join(root,'${relative}/source-adapters.cjs'));\nconst fullUiMotionOptions=motionOptions(),`,'bounded presentation failure context helper');
  source=replaceOnce(source,'storage:nativeStorage,cpuDeliveryScheduling,cpuOwnership,',
    'storage:nativeStorage,cpuDeliveryScheduling,cpuOwnership,keepRendererActive:fullUiKeepCaptureActive,','capture-scoped renderer activity candidate');
  source=replaceOnce(source,'    meaning:\'Explicit publisher-only BrowserWindow backgroundThrottling control;',
    '    captureActivityPolicy:{requested:fullUiKeepCaptureActive,defaultBackgroundThrottling:true,expectedWhileLeaseActive:false,restoreOnStop:true},\n    meaning:\'Explicit publisher-only BrowserWindow backgroundThrottling control;','capture activity policy evidence');
  source=replaceOnce(source,'if(visiblePresentation.enabled&&!qualifyVisiblePresentationState(presentationGeometry,state))',
    'if(visiblePresentation.enabled&&!(fullUiMotion?fullUiMotion.qualify(state,qualifyVisiblePresentationState,fullUiExpectedPublisherThrottling()):qualifyVisiblePresentationState(presentationGeometry,state,{expectedPublisherBackgroundThrottling:fullUiExpectedPublisherThrottling()})))','phase-specific owned presentation qualification');
  const start=source.indexOf('    const source=generatedNv12Enabled?');
  const end=source.indexOf('\n    await sourceWindow.loadURL(',start);
  if(start<0||end<start)throw Error('Full App adapter source contract changed: motion source HTML');
  source=source.slice(0,start)+source.slice(start,end).replace('const source=generatedNv12Enabled?',
    'const source=fullUiMotionOptions.enabled?motionSourceHtml({sourceAgeSetup,sourceAgeDraw,patternBits}):generatedNv12Enabled?')+source.slice(end);
  source=replaceOnce(source,'sampleSeconds>30||!Number.isInteger(warmupMs)',
    'sampleSeconds>(fullUiMotionOptions.enabled?fullUiMotionOptions.sampleSeconds:30)||!Number.isInteger(warmupMs)','bounded extended motion sample duration');
  source=replaceOnce(source,'        sender.setBounds(presentationGeometry.senderBounds);sender.show();sender.focus();',
    '        if(fullUiMotionOptions.enabled)sourceWindow.moveTop();\n        sender.setBounds(presentationGeometry.senderBounds);sender.show();sender.focus();','one-shot owned background stacking before visible startup');
  source=replaceOnce(source,"'&fullProductUi=1&fullFlatDiagnostics='",
    "'&fullProductUi=1&fullMotionSwitch='+(fullUiMotionOptions.enabled?'1':'0')+'&fullFlatDiagnostics='",'motion renderer control');
  source=replaceOnce(source,'    helperTiming:{enabled:nativeTimingEnabled,schemaVersion:1,maximumSamples:120,',
    '    helperTiming:{enabled:nativeTimingEnabled,schemaVersion:1,maximumSamples:fullUiMotionOptions.enabled?360:120,','bounded longer helper timing coverage');
  source=replaceOnce(source,'nativeHelperTimingSummary(samples.map(sample=>sample.nativeHelperTiming))',
    'nativeHelperTimingSummary(samples.map(sample=>sample.nativeHelperTiming),fullUiMotionOptions.enabled?fullUiMotionOptions.sampleSeconds+1:31)','bounded longer helper summary coverage');
  source=replaceOnce(source,'nativeHelperTimingSnapshot(result.nativeGpu.helperTiming.records,activeNativeHelperIndex(),mode)',
    'nativeHelperTimingSnapshot(result.nativeGpu.helperTiming.records,activeNativeHelperIndex(),mode,fullUiMotionOptions.enabled?360:120)','bounded longer helper snapshot coverage');
  source=replaceOnce(source,'      for(let n=0;n<=sampleSeconds;n++){',
    `      const motionNativeStart=fullUiMotionOptions.enabled?brokerSnapshot()?.started:null;\n      if(fullUiMotionOptions.enabled)fullUiMotion=await createMotionScenario({BrowserWindow,geometry:presentationGeometry,sender,sourceWindow,result:measured,keepCaptureActive:fullUiKeepCaptureActive});\n      for(let n=0;n<=sampleSeconds;n++){\n        await fullUiMotion?.beforeSample(n);`,'motion phases with continuous producer');
  source=replaceOnce(source,'        const fullObservation=!lowObserverMode||n===0||n===sampleSeconds;',
    '        const fullObservation=fullUiMotionOptions.enabled||!lowObserverMode||n===0||n===sampleSeconds;','per-phase actual CPU/window evidence');
  source=replaceOnce(source,'        if(!lowObserverMode)save(mainStages.save);',
    '        if(!fullUiMotionOptions.enabled&&!lowObserverMode)save(mainStages.save);','motion sampling defers growing full-result serialization until final or failure');
  source=replaceOnce(source,"            pane.documentVisibilityState!=='visible'||pane.layout!=='top-strip-v1'",
    "            (!fullUiMotionOptions.enabled&&pane.documentVisibilityState!=='visible')||pane.layout!=='top-strip-v1'",'record occlusion visibility without forcing it');
  source=replaceOnce(source,"            throw Error('Visible product video/CSS/real diagnostic presentation contract was not established');",
    "            {measured.visiblePresentation.failure??=visiblePresentationFailureContext(pane,{at:Date.now(),sampleIndex:n,mainClockMs:performance.now(),fullUiStats,nativeTimingEnabled,liveGpuInfo,nativeCompletion:nativeCompletion??null,sampleSeconds,warmupMs,motionEnabled:fullUiMotionOptions.enabled,keepCaptureActive:fullUiKeepCaptureActive,motionPhase:fullUiMotion?.sample()??null});save();throw Error('Visible product video/CSS/real diagnostic presentation contract was not established');}",'save actual bounded presentation context before unchanged rejection');
  source=replaceOnce(source,'        samples.push({at,sender:send,viewer:receive,',
    '        if(fullUiMotionOptions.enabled&&(!send.fullProductUi?.motionStability?.sameProducer||!send.fullProductUi?.motionStability?.sameTrack||nativeRequests!==measured.nativeRequests||nativeGpu?.started!==motionNativeStart))throw Error(\'Motion/switch capture producer or native session changed\');\n        if(fullUiKeepCaptureActive&&(nativeGpu?.keepRendererActive!==true||nativeGpu.rendererActivityLeases!==1||sender.webContents.getBackgroundThrottling()!==false))throw Error(\'Capture activity candidate did not establish exactly one publisher renderer lease\');\n        samples.push({at,motionPhase:fullUiMotion?.sample()??null,sender:send,viewer:receive,','capture producer continuity and phase sample');
  source=replaceOnce(source,'    nativeController.reset();const afterReset=await waitNativeResources();',
    '    const rendererActivityAfterProductStop={leases:afterProductCleanup.rendererActivityLeases??null,backgroundThrottling:peers[0]?.isDestroyed()?null:peers[0]?.webContents.getBackgroundThrottling()??null};\n    nativeController.reset();const afterReset=await waitNativeResources();\n    const rendererActivityAfterReset={leases:afterReset.rendererActivityLeases??null,backgroundThrottling:peers[0]?.isDestroyed()?null:peers[0]?.webContents.getBackgroundThrottling()??null};','actual renderer policy after normal stop and reset');
  source=replaceOnce(source,'    nativeGpu={afterRendererCleanup,afterProductCleanup,afterReset,',
    '    nativeGpu={afterRendererCleanup,afterProductCleanup,afterReset,rendererActivity:{requested:fullUiKeepCaptureActive,originalBackgroundThrottling:senderBackgroundThrottling,afterProductStop:rendererActivityAfterProductStop,afterReset:rendererActivityAfterReset,restored:rendererActivityAfterProductStop.leases===0&&rendererActivityAfterReset.leases===0&&rendererActivityAfterProductStop.backgroundThrottling===senderBackgroundThrottling&&rendererActivityAfterReset.backgroundThrottling===senderBackgroundThrottling},','capture activity restoration evidence');
  source=replaceOnce(source,'passed:rendererResourcesZero&&backendResourcesZero&&(!nativeGpu||(nativeGpu.productResourcesReleased&&nativeGpu.resetResourcesReleased))',
    'passed:rendererResourcesZero&&backendResourcesZero&&(!nativeGpu||(nativeGpu.productResourcesReleased&&nativeGpu.resetResourcesReleased&&(!fullUiKeepCaptureActive||nativeGpu.rendererActivity.restored)))','candidate cleanup requires actual original renderer policy restoration');
  source=replaceOnce(source,'      if(localPreviewEnabled)measured.localPreview.afterSampling=',
    '      if(fullUiMotion){fullUiMotion.finish(samples,summary);save();}\n      if(localPreviewEnabled)measured.localPreview.afterSampling=','phase summaries including transition and pure LOW');
  source=replaceOnce(source,'      measured.cleanup=await cleanupPeers();save();',
    '      fullUiMotion?.dispose();\n      measured.cleanup=await cleanupPeers();save();','normal fixture window cleanup');
  source=replaceOnce(source,'  fullUiMain?.dispose();',
    '  fullUiMotion?.dispose();\n  fullUiMain?.dispose();','failure fixture window cleanup');
  source=replaceOnce(source,'renderer.fixture?.passed===true&&renderer.fixture?.meterTransitionDiagnostic?.disposed===true&&',
    'renderer.fixture?.passed===true&&renderer.fixture?.motionObservation?.motionObservationDisposed===true&&renderer.fixture?.motionObservation?.motionNativeObservers===0&&renderer.fixture?.meterTransitionDiagnostic?.disposed===true&&','native LOW observer cleanup guard');
  // Logging a closed redirected pipe must not crash the observation or bypass
  // normal owned-resource teardown. Other stream errors still reach finish().
  source=replaceOnce(source,"process.on('message',message=>",
    "for(const stream of [process.stdout,process.stderr])stream.on('error',error=>{if(error.code!=='EPIPE')void finish(error);});\nprocess.on('message',message=>",'bounded EPIPE cleanup guard');
  return source;
}
function visiblePresentationFailureContext(pane,context){
  const numeric=value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;
  const boolean=value=>typeof value==='boolean'?value:null;
  const choice=(value,allowed)=>value==null?null:allowed.includes(value)?value:'other';
  const size=value=>value&&Number.isFinite(value.width)&&value.width>=0&&value.width<=16384&&Number.isFinite(value.height)&&value.height>=0&&value.height<=16384
    ?{width:value.width,height:value.height}:null;
  const filter=pane?.backdropFilter;
  const safeFilter=filter==null?null:typeof filter==='string'&&filter.length<=128&&/^(?:none|blur\([0-9.]+(?:px|rem|em)\))$/.test(filter)?filter:'other';
  return {at:numeric(context.at),sampleIndex:numeric(context.sampleIndex),mainClockMs:numeric(context.mainClockMs),
    fullUiStats:boolean(context.fullUiStats),timing:{nativeTimingEnabled:boolean(context.nativeTimingEnabled),liveGpuInfo:boolean(context.liveGpuInfo),
      nativeCompletion:choice(context.nativeCompletion,['query','fence']),sampleSeconds:numeric(context.sampleSeconds),warmupMs:numeric(context.warmupMs)},
    motion:{enabled:boolean(context.motionEnabled),keepCaptureActive:boolean(context.keepCaptureActive),
      phaseIndex:numeric(context.motionPhase?.index),phase:choice(context.motionPhase?.name,['motion-visible','motion-visible-switches','motion-occluded-switches','motion-visible-restored']),
      requestedOccluded:boolean(context.motionPhase?.requestedOccluded)},
    pane:pane?{requested:boolean(pane.requested),stylesState:choice(pane.stylesState,['pending','ready','failed']),mounted:boolean(pane.mounted),
      overlayMounted:boolean(pane.overlayMounted),statsEnabled:boolean(pane.statsEnabled),hostSize:size(pane.hostSize),previewSize:size(pane.previewSize),
      overlaySize:size(pane.overlaySize),viewport:size(pane.viewport),videoObjectFit:choice(pane.videoObjectFit,['contain','cover','fill','none','scale-down']),
      backdropFilter:safeFilter,overlayPosition:choice(pane.overlayPosition,['absolute','relative','fixed','static','sticky']),
      documentVisibilityState:choice(pane.documentVisibilityState,['visible','hidden','prerender']),layout:choice(pane.layout,['top-strip-v1','central-v1'])}:null};
}
function observedPrelude(source){
  source=source.replace(/\r\n/g,'\n');
  source=replaceOnce(source,'const trackedTimeouts=new Set<number>(),trackedIntervals=new Set<number>();',
    `const trackedTimeouts=new Set<number>(),trackedIntervals=new Set<number>();
const intervalOwners=new Map<number,{delay:number|null;owner:string}>();
let developmentHeartbeat={observed:0,disposed:0,passed:true};`,'bounded interval owner labels');
  source=replaceOnce(source,'trackedIntervals.add(id);return id;}) as typeof window.setInterval;',
    "trackedIntervals.add(id);intervalOwners.set(id,{delay:Number.isFinite(delay)?Number(delay):null,owner:classifyIntervalOwner(new Error().stack??'',delay)});return id;}) as typeof window.setInterval;",'interval creation label');
  source=replaceOnce(source,'window.clearInterval=(id?:number)=>{if(id!==undefined)trackedIntervals.delete(id);nativeClearInterval(id);};',
    'window.clearInterval=(id?:number)=>{if(id!==undefined){trackedIntervals.delete(id);intervalOwners.delete(id);}nativeClearInterval(id);};','clear interval labels');
  source=replaceOnce(source,'intervals:trackedIntervals.size};},',
    'intervals:trackedIntervals.size,intervalOwners:[...trackedIntervals].slice(0,8).map(id=>intervalOwners.get(id)??{owner:"unknown",delay:null}),developmentHeartbeat};},','active interval labels');
  source=replaceOnce(source,'const iceQA={',
    'const iceQA={disposeDevelopmentHeartbeat:()=>{developmentHeartbeat=disposeDevelopmentHeartbeat(intervalOwners,trackedIntervals,id=>window.clearInterval(id));return developmentHeartbeat;},','owned development heartbeat disposal');
  const start=source.indexOf('const peerConnections=new Set<RTCPeerConnection>');
  const end=source.indexOf('// Synthetic video, never capture',start);
  if(start<0||end<start)throw Error('Full App observer source contract changed');
  return `import {Device,type types as MsTypes} from 'mediasoup-client';\nimport {classifyIntervalOwner,disposeDevelopmentHeartbeat} from './development-heartbeat';\nconst params=new URLSearchParams(location.search);\nconst proxyProtocol='tcp';\n`+source.slice(start,end)+`\nexport {peerConnections,iceQA};\n`;
}
module.exports={root,relative,replaceOnce,qualifyFullProductDisplay,launcher,electron,productController,productChat,fixtureObserver,observedPrelude,visiblePresentationFailureContext};
