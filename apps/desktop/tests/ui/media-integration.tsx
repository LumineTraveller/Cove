import {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {io} from 'socket.io-client';
import {useWebRTC} from '../../src/features/media/useWebRTC';
const params=new URLSearchParams(location.search);
// Synthetic video, never capture the user's desktop or microphone.
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
const ctx=canvas.getContext('2d')!;
function draw(){ctx.fillStyle='#237bd8';ctx.fillRect(0,0,640,360);ctx.fillStyle='#ffb22a';ctx.fillRect((performance.now()/8)%500,90,120,180);requestAnimationFrame(draw);}
draw();
navigator.mediaDevices.getDisplayMedia=async()=>canvas.captureStream(30);
function Fixture(){
  const socket=useMemo(()=>io(params.get('base')!,{auth:{clientProtocol:2},autoConnect:false}),[]);
  const rtc=useWebRTC(socket,params.get('room')!);
  const [ready,setReady]=useState(false);const [error,setError]=useState('');
  const video=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
    socket.on('connect',()=>{
      socket.timeout(8000).emit('user:register',{username:'Refactor',avatarUrl:null,clientId:'renderer-'+params.get('index'),authToken:params.get('token'),platform:'desktop'},(cause:any,result:any)=>{
        if(cause||!result?.ok){setError(cause?.message||result?.error);return;}
        socket.timeout(8000).emit('room:join',params.get('room'),(cause:any,result:any)=>cause||result?.error?setError(cause?.message||result.error):setReady(true));
      });
    });socket.on('connect_error',cause=>setError(cause.message));socket.connect();
    return()=>{rtc.leaveVoice();socket.disconnect();};
  },[socket]);
  useEffect(()=>{if(video.current){video.current.srcObject=rtc.remoteScreen?.stream||null;void video.current.play().catch(()=>{});}},[rtc.remoteScreen]);
  useEffect(()=>{(window as any).coveMediaQA={rtc,socket,ready,error};});
  return <><p>{ready?'Room ready':'Connecting'} {error}</p><video ref={video} autoPlay muted playsInline/><pre>{rtc.inVoice?'In voice':'Not in voice'}</pre></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
