import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShareViewV2 } from '../../src/features/media/screen/ShareViewV2';
import '../../src/styles/ui-v2.css';

function videoStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#23374e'; context.fillRect(0, 0, 640, 360);
  context.fillStyle = '#fff'; context.font = '28px sans-serif';
  context.fillText('Cove synthetic screen', 140, 180);
  return canvas.captureStream(1);
}

function Fixture() {
  const [localScreen, setLocalScreen] = useState(videoStream);
  const [remote, setRemote] = useState(false);
  const [shareHasAudio, setShareHasAudio] = useState(false);
  const [receiveHasAudio, setReceiveHasAudio] = useState(true);
  const [shareVolume, setShareVolume] = useState(1);
  const [receiveVolume, setReceiveVolume] = useState(0.6);
  const calls = useRef<{ target: string; value: number }[]>([]);
  const rtc = {
    localScreen, remoteScreen: remote ? { socketId: 'remote', stream: localScreen } : null,
    localSocketId: 'self', localScreenProducerId: null, availableScreens: [],
    screenShareHasAudio: shareHasAudio, screenReceiveHasAudio: receiveHasAudio,
    screenShareVolume: shareVolume, screenReceiveVolume: receiveVolume,
    setScreenShareVolume: (value: number) => { calls.current.push({ target: 'send', value }); setShareVolume(value); },
    setScreenReceiveVolume: (value: number) => { calls.current.push({ target: 'receive', value }); setReceiveVolume(value); },
    stats: {}, statsEnabled: false,
  } as any;
  (window as any).volumeQa = {
    setShareHasAudio, setReceiveHasAudio, setRemote,
    replaceVideo: () => setLocalScreen(videoStream()),
    snapshot: () => {
      const range = document.querySelector<HTMLInputElement>('.share-status-bar input[type=range]');
      const mute = document.querySelector<HTMLButtonElement>('.share-status-bar .volume-icon');
      return { shareVolume, receiveVolume, shareHasAudio, receiveHasAudio, remote,
        label: range?.getAttribute('aria-label') ?? null, value: range?.value ?? null,
        muteLabel: mute?.getAttribute('aria-label') ?? null,
        rangeRect: range?.getBoundingClientRect().toJSON() ?? null, viewportWidth: innerWidth,
        calls: calls.current.slice() };
    },
  };
  return <div style={{ height: '100vh', padding: 12 }}>
    <ShareViewV2 rtc={rtc} roomId="fixture" debug={false} onToggleDebug={() => {}}
      remoteControl={{ state: 'available' }} sharerName="测试成员" onInput={() => {}}
      onRequestRemote={() => {}} onStopRemote={() => {}} onEnd={() => {}}
      diagnosticsCompact={true} onToggleDiagnosticsCompact={() => {}} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
