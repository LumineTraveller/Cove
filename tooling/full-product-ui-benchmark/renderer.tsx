import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {installScreenPerformanceFixture} from '../../apps/desktop/tests/ui/screen-performance-fixture';
import {peerConnections,iceQA} from './observer';
import {guardFixtureMicrophone} from './synthetic-microphone';
import {createMeterObservation} from './meter-observation';
import {createRtcMeterObservation} from './rtc-meter-observation';
import {snapshotDomMeters} from './dom-meter-observation';
import {installMeterTransitionDiagnostic} from './meter-transition-diagnostic';
import {createMotionObservation} from './motion-observation';

const targetWindow=window as any;
targetWindow.covePerformanceProductStylesState='pending';
let startupPhase='parameters';
const stage=(phase:string)=>{startupPhase=phase;targetWindow.coveFullProductStartup={phase,failed:false};};
stage(startupPhase);
async function bootstrap(){
const params=new URLSearchParams(location.search);
const index=Number(params.get('index')),base=params.get('base')??'',token=params.get('token')??'',room=params.get('room')??'';
if(![0,1].includes(index)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)||!token||!room||params.get('performance')!=='1'||params.get('source')!=='native')
  throw Error('Invalid isolated full App bootstrap');
const account=JSON.parse(params.get('fullAccount')??'null');
if(!account||typeof account.id!=='string'||typeof account.email!=='string'||typeof account.username!=='string')throw Error('Invalid synthetic account');
const fullStats=params.get('fullStats')==='1';
if(!['0','1'].includes(params.get('fullStats')??''))throw Error('Invalid full App stats control');
const voiceMode=params.get('fullVoice')??'muted';
if(!['muted','synthetic-varying'].includes(voiceMode))throw Error('Invalid full App voice mode');
const expectedSelfMuted=voiceMode==='muted';
const meterDiagnosticFlag=params.get('fullMeterDiagnostic')??'0';
if(!['0','1'].includes(meterDiagnosticFlag))throw Error('Invalid meter transition diagnostic control');
const meterDiagnostic=installMeterTransitionDiagnostic(meterDiagnosticFlag==='1');
const motionFlag=params.get('fullMotionSwitch')??'0';
if(!['0','1'].includes(motionFlag)||(motionFlag==='1'&&(!fullStats||voiceMode!=='muted')))
  throw Error('Motion/switch requires actual product stats and muted synthetic voice');
const motionObservation=createMotionObservation(motionFlag==='1');
targetWindow.coveFullProductMeterTransitionSample=(index:number)=>meterDiagnostic.setSampleIndex(index);
// Each BrowserWindow has its own nonpersistent Electron partition. The fixture
// account is seeded before the App/socket module can select a server or identity.
localStorage.setItem('cove_server_url',base);
localStorage.setItem('cove_client_id','isolated-full-app-'+index);
localStorage.setItem('cove_username',account.username);
localStorage.setItem('cove-theme','light');
location.hash='/room/'+encodeURIComponent(room);
stage('auth-storage');
const {rememberAccountSession}=await import('../../apps/desktop/src/features/accounts/accountAuth');
rememberAccountSession({serverUrl:base,token,accountId:account.id,email:account.email,
  profile:{username:account.username,avatarUrl:null},allowInvalidServerCertificate:false});
stage('fixture-initialization');
const performanceFixture=await installScreenPerformanceFixture(params,peerConnections);
if(!performanceFixture||typeof performanceFixture.sample!=='function'||typeof performanceFixture.cleanup!=='function')
  throw Error('Full App fixture initialization contract failed');
targetWindow.coveScreenPerformance=performanceFixture;
// The final getUserMedia provider is explicit and installed before actual App
// import/joinVoice. getDisplayMedia remains the real owned-screen fixture path.
stage('synthetic-microphone-guard');
const syntheticMicrophone=guardFixtureMicrophone(voiceMode);
stage('socket-module');
const {socket,getServerURL}=await import('../../apps/desktop/src/features/connection/socket');
if(getServerURL()!==base)throw Error('Full App socket did not use its loopback backend');
let latest:any=null,prepared=false,preparing=false,cancelled=false,error:string|null=null,root:ReturnType<typeof createRoot>|null=null;
const stopGlobalEffects:Array<()=>void>=[];
const controlledInput={enabled:true,blockedTrustedPointer:0};
const blockTrustedPointer=(event:Event)=>{
  if(!event.isTrusted)return;
  event.preventDefault();event.stopImmediatePropagation();
  controlledInput.blockedTrustedPointer=Math.min(1000,controlledInput.blockedTrustedPointer+1);
};
for(const name of ['pointerdown','pointermove','mousedown','click','dblclick','contextmenu','wheel','touchstart']){
  window.addEventListener(name,blockTrustedPointer,{capture:true,passive:false});
  stopGlobalEffects.push(()=>window.removeEventListener(name,blockTrustedPointer,true));
}
let diagnosticsInitialized=false,controllerCommits=0,chatRenderCount=0,roomMounted=false;
const meterObservation=createMeterObservation();
const rtcMeterObservation=createRtcMeterObservation(levels=>meterObservation.observe(levels));
const delay=(ms:number)=>new Promise<void>(resolve=>window.setTimeout(resolve,ms));
function syntheticCount(){return latest?.messages?.filter((message:any)=>typeof message.id==='string'&&message.id.startsWith('full-ui-message-')).length??0;}
function tagPresentation(){
  const host=document.querySelector('.cove-v2-page');
  if(host?.getAttribute('data-cove-performance-presentation')!=='1')host?.setAttribute('data-cove-performance-presentation','1');
  if(index===0){const preview=document.querySelector('.share-view .screen-video-surface');
    if(preview?.getAttribute('data-cove-performance-local-preview')!=='1')preview?.setAttribute('data-cove-performance-local-preview','1');}
}
async function prepareRoom(){
  if(preparing||prepared||cancelled||!latest?.roomSynced||!latest?.messagesLoaded)return;
  preparing=true;
  try{
    const until=performance.now()+25000;
    while(!cancelled&&performance.now()<until){
      const count=syntheticCount();
      if(count===200){await delay(0);if(document.querySelectorAll('.message-row').length!==200)throw Error('Synthetic message DOM count mismatch');
        const list=document.querySelector<HTMLElement>('.message-list');if(list)list.scrollTop=list.scrollHeight;
        prepared=true;return;}
      if(count>200||(!latest.loadingOlderMessages&&!latest.hasOlderMessages))throw Error('Synthetic message history was incomplete');
      if(!latest.loadingOlderMessages)latest.loadOlderMessages();
      await delay(100);
    }
    if(!cancelled)throw Error('Full App history preparation deadline');
  }catch{error='full_app_history_preparation_failed';}
  finally{preparing=false;}
}
targetWindow.coveFullProductUiBridge={commit(controller:any){
  controllerCommits++;
  rtcMeterObservation.update(controller);
  roomMounted=true;
  latest=controller;tagPresentation();
  if(!diagnosticsInitialized&&latest.roomSynced){diagnosticsInitialized=true;
    if(fullStats){latest.setDebug(true);if(!latest.rtc.statsEnabled)latest.rtc.toggleStats();}}
  void prepareRoom();
},roomUnmounted(){roomMounted=false;},chatRender(){chatRenderCount++;}};
// App owns socket disconnection; the room owns its leave/recovered-connect
// listener. Leave through the public controller while App is still connected,
// then await the final room passive cleanup before unmounting its parent.
targetWindow.coveFullProductLeaveRoom=async()=>{
  rtcMeterObservation.stop();
  const started=performance.now();
  if(!roomMounted)return {requested:false,completed:true,socketConnected:socket.connected,waitMs:0};
  if(!socket.connected)return {requested:false,completed:false,socketConnected:false,reason:'socket_disconnected',waitMs:0};
  latest.leave();
  const until=started+2000;
  while(roomMounted&&performance.now()<until)await delay(25);
  return {requested:true,completed:!roomMounted,socketConnected:socket.connected,waitMs:performance.now()-started};
};
const resources=()=>({...iceQA.resources(),...rtcMeterObservation.resources(),...motionObservation.resources(),syntheticMicrophone:syntheticMicrophone.snapshot(),
  socketListenerNames:Object.entries((socket as any)._callbacks??{}).filter(([,list]:any)=>list.length>0).map(([name])=>/^\$?[a-z][a-z0-9:_-]{0,63}$/i.test(name)?name:'other').slice(0,16),
  socketListeners:Object.values((socket as any)._callbacks??{}).reduce((n:number,list:any)=>n+list.length,0)});
targetWindow.coveMediaQA={get rtc(){return latest?.rtc;},socket,get ready(){return prepared&&!cancelled&&Boolean(latest?.roomSynced)&&!error;},get error(){return error;},ice:iceQA,resources};
function snapshot(){return {ready:targetWindow.coveMediaQA.ready,controllerCommits,chatRenderCount,...meterObservation.snapshot(),voiceMode,expectedSelfMuted,syntheticMessages:syntheticCount(),messageRows:document.querySelectorAll('.message-row').length,
  ...rtcMeterObservation.snapshot(),
  verticalMeterDom:snapshotDomMeters(),
  meterTransitionDiagnostic:meterDiagnostic.snapshot(),
  motionStability:motionObservation.snapshot(latest?.rtc),
  controlledInput:{...controlledInput},selfMuted:latest?.rtc?.isMuted===true,inVoice:latest?.rtc?.inVoice===true,statsEnabled:latest?.rtc?.statsEnabled===true,
  chatAriaHidden:document.querySelector('.chat-slot')?.getAttribute('aria-hidden')??null,
  debugPanelMounted:Boolean(document.querySelector('.diagnostics-v2')),syntheticMicrophone:syntheticMicrophone.snapshot(),devToolsRequested:false};}
const sample=performanceFixture.sample.bind(performanceFixture);
performanceFixture.sample=async()=>({...await sample(),fullProductUi:snapshot()});
const cleanup=performanceFixture.cleanup.bind(performanceFixture);
performanceFixture.cleanup=async()=>{
  rtcMeterObservation.stop();
  meterDiagnostic.dispose();
  motionObservation.dispose();
  syntheticMicrophone.release();
  const evidence=await cleanup();
  return {...evidence,meterTransitionDiagnostic:meterDiagnostic.snapshot(),motionObservation:motionObservation.resources(),syntheticMicrophone:{...syntheticMicrophone.snapshot(),
    liveTracks:evidence.liveSyntheticAudioTracks,openContexts:evidence.openSyntheticAudioContexts}};
};
targetWindow.covePerformanceUnmount=()=>{if(cancelled)return;cancelled=true;rtcMeterObservation.stop();motionObservation.dispose();root?.unmount();for(const stop of stopGlobalEffects)stop();
  void performanceFixture.cleanup();socket.disconnect();iceQA.disposeDevelopmentHeartbeat();};
stage('app-modules');
const [{default:App},{installAutoHideScrollbars},{installViewportResizeState},{applyTheme}]=await Promise.all([
  import('../../apps/desktop/src/app/App'),import('../../apps/desktop/src/autoHideScrollbars'),
  import('../../apps/desktop/src/viewportResize'),import('../../apps/desktop/src/features/settings/theme'),
  import('../../apps/desktop/src/styles/index.css'),import('../../apps/desktop/src/styles/ui-v2.css'),
]);
applyTheme('light');stopGlobalEffects.push(installAutoHideScrollbars(),installViewportResizeState());
stage('app-mount');
root=createRoot(document.getElementById('root')!);root.render(<StrictMode><App/></StrictMode>);
targetWindow.covePerformanceProductStylesState='ready';stage('app-mounted');
}
void bootstrap().catch(()=>{
  targetWindow.covePerformanceProductStylesState='failed';
  targetWindow.coveFullProductStartup={phase:startupPhase,failed:true};
  // Fixed stage codes only. Never log an error payload/URL/account/token here.
  console.error('[full-product-startup:error] '+startupPhase);
});
