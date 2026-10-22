import {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {io} from 'socket.io-client';
import {useWebRTC} from '../../src/features/media/useWebRTC';
import {CLIENT_PROTOCOL_VERSION, CLIENT_RELEASE_VERSIONS} from '@cove/contracts';
import {Device, type types as MsTypes} from 'mediasoup-client';
const params=new URLSearchParams(location.search);
// Observe public mediasoup APIs only. Credentials stay in memory; reports expose
// a changed/not-changed assertion, never SDP, ICE passwords or candidate tuples.
const mediaTransports: Array<{transport:MsTypes.Transport;initialFragment:string;restartCalls:number;changed:boolean;
  producers:MsTypes.Producer[];consumers:MsTypes.Consumer[]}> = [];
for(const method of ['createSendTransport','createRecvTransport'] as const){
  const original=Device.prototype[method];
  Device.prototype[method]=function(options:MsTypes.TransportOptions){
    const proxy=Number(params.get('iceProxy'));
    const actual=method==='createRecvTransport'&&Number.isInteger(proxy)&&proxy>=1024&&proxy<=65535
      ? {...options,iceCandidates:options.iceCandidates.filter(c=>c.protocol==='tcp').map(c=>({...c,ip:'127.0.0.1',address:'127.0.0.1',port:proxy}))}:options;
    const transport=original.call(this,actual);
    const record={transport,initialFragment:options.iceParameters.usernameFragment,restartCalls:0,changed:false,
      producers:[] as MsTypes.Producer[],consumers:[] as MsTypes.Consumer[]};
    mediaTransports.push(record);
    transport.observer.on('newproducer',producer=>record.producers.push(producer));
    transport.observer.on('newconsumer',consumer=>record.consumers.push(consumer));
    const restart=transport.restartIce.bind(transport);
    transport.restartIce=async options=>{record.restartCalls++;record.changed ||= options.iceParameters.usernameFragment!==record.initialFragment;await restart(options);};
    return transport;
  };
}
const iceQA={
  snapshot:()=>mediaTransports.map(r=>({id:r.transport.id,direction:r.transport.direction,state:r.transport.connectionState,
    restartCalls:r.restartCalls,credentialsChanged:r.changed,
    producers:r.producers.filter(p=>!p.closed).map(p=>({id:p.id,paused:p.paused})),
    consumers:r.consumers.filter(c=>!c.closed).map(c=>c.id)})),
  decodedFrames:async()=>{let count=0;for(const r of mediaTransports){if(r.transport.closed||r.transport.direction!=='recv')continue;
    for(const report of (await r.transport.getStats()).values())if(report.type==='inbound-rtp'&&report.kind==='video')count+=report.framesDecoded||0;}return count;},
  audioProgress:async()=>{const totals={packets:0,samples:0,energy:0};for(const r of mediaTransports){if(r.transport.closed||r.transport.direction!=='recv')continue;
    for(const report of (await r.transport.getStats()).values())if(report.type==='inbound-rtp'&&report.kind==='audio'){
      totals.packets+=report.packetsReceived||0;totals.samples+=report.totalSamplesReceived||0;totals.energy+=report.totalAudioEnergy||0;}}return totals;},
};
// Synthetic video, never capture the user's desktop or microphone.
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
const ctx=canvas.getContext('2d')!;
function draw(){ctx.fillStyle='#237bd8';ctx.fillRect(0,0,640,360);ctx.fillStyle='#ffb22a';ctx.fillRect((performance.now()/8)%500,90,120,180);requestAnimationFrame(draw);}
draw();
navigator.mediaDevices.getDisplayMedia=async()=>canvas.captureStream(30);
function Fixture(){
  const socket=useMemo(()=>io(params.get('base')!,{auth:{clientProtocol:CLIENT_PROTOCOL_VERSION,clientPlatform:'desktop',clientVersion:CLIENT_RELEASE_VERSIONS.desktop},autoConnect:false}),[]);
  const rtc=useWebRTC(socket,params.get('room')!);
  const [ready,setReady]=useState(false);const [error,setError]=useState('');
  const video=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    socket.on('connect',()=>{
      socket.timeout(8000).emit('user:register',{username:'Refactor',avatarUrl:null,clientId:'renderer-'+params.get('index'),authToken:params.get('token'),platform:'desktop',clientVersion:CLIENT_RELEASE_VERSIONS.desktop},(cause:any,result:any)=>{
        if(cause||!result?.ok){setError(cause?.message||result?.error);return;}
        socket.timeout(8000).emit('room:join',params.get('room'),(cause:any,result:any)=>cause||result?.error?setError(cause?.message||result.error):setReady(true));
      });
    });socket.on('connect_error',cause=>setError(cause.message));socket.connect();
    return()=>{rtc.leaveVoice();socket.disconnect();};
  },[socket]);
  useEffect(()=>{if(video.current){video.current.srcObject=rtc.remoteScreen?.stream||null;void video.current.play().catch(()=>{});}},[rtc.remoteScreen]);
  useEffect(()=>{(window as any).coveMediaQA={rtc,socket,ready,error,ice:iceQA};});
  return <><p>{ready?'Room ready':'Connecting'} {error}</p><video ref={video} autoPlay muted playsInline/><pre>{rtc.inVoice?'In voice':'Not in voice'}</pre></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
