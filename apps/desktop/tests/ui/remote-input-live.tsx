import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { RemoteScreenVideo } from '../../src/features/media/screen/ScreenVideo';
import { RemoteScreenVideo as Baseline } from './ScreenVideo.baseline';
import { RemoteControlLifecycle } from '../../src/features/remote-control/remoteControlSession';
import '../../src/styles/ui-v2.css';
const params = new URLSearchParams(location.search);
const socket = io(`http://127.0.0.1:${params.get('relay')}`, { transports: ['websocket'], autoConnect: false });
const role = params.get('role') as 'controller' | 'sharer';
const rows: { stage: string; at: number; x?: number; type?: string }[] = [];
if(role==='controller') {
  for(const kind of ['pointerrawupdate','pointermove'])document.addEventListener(kind,event=>{
    const pointer=event as PointerEvent;
    const video=document.querySelector('video');if(!video)return;
    const rect=video.getBoundingClientRect();
    rows.push({stage:kind,at:pointer.timeStamp,x:(pointer.clientX-rect.left)/rect.width,type:pointer.pointerType});
  },{passive:true});
}
const lifecycle = new RemoteControlLifecycle({ roomId: 'owned', socket,
  bridge: (window as any).probeBridge, onSession: () => {}, onNotice: (reason) => rows.push({stage:reason,at:performance.now()}) });
const emit = socket.emit.bind(socket);
socket.emit = ((event: string, ...args: any[]) => {
  if (event === 'remote-control:input') rows.push({ stage: 'sent', at: performance.now(), x: args[0].input.x, type: args[0].input.type });
  return emit(event, ...args);
}) as typeof socket.emit;
socket.on('remote-control:input', ({input}) => rows.push({stage:'received',at:performance.now(),x:input.x,type:input.type}));
lifecycle.expectStart(role); // repeated after connection below
socket.on('connect', () => { lifecycle.expectStart(role); socket.emit('probe:ready', role); });
const canvas = document.createElement('canvas'); canvas.width=1600;canvas.height=1000;
const context=canvas.getContext('2d')!;context.fillStyle='#18212e';context.fillRect(0,0,1600,1000);
context.fillStyle='white';context.font='32px sans-serif';context.fillText('Cove owned end-to-end input test',80,160);
const stream=canvas.captureStream(1);
const Component=params.get('baseline')==='true'?Baseline:RemoteScreenVideo;
if(params.get('baseline')==='true') {
  const style=document.createElement('style');
  style.textContent='.cove-window-titlebar{display:flex!important}.remote-control-frame{position:absolute;inset:0;pointer-events:none;border:1px solid rgba(103,215,161,.65);box-shadow:inset 0 0 0 2px rgba(103,215,161,.12)}';
  document.head.append(style);
}
const onInput=(input:any)=>{rows.push({stage:'sample',at:performance.now(),x:input.x,type:input.type});lifecycle.send(input);};
function Fixture(){const [active,setActive]=useState(true);(window as any).liveProbe={socket,rows,setActive,lifecycle};return <>
  <div className="cove-window-titlebar"><div className="cove-window-controls"><button id="owned-close">X</button></div></div>
  <div className="share-view screen-maximized"><div className="video-surface"><Component stream={stream} controlling={active} onInput={onInput}/></div></div>
  </>}
createRoot(document.getElementById('root')!).render(<Fixture/>);socket.connect();
