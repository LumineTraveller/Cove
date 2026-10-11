import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShareViewV2 } from '../../src/features/media/screen/ShareViewV2';
import { normalizedVideoPoint } from '../../src/features/remote-control/remoteControl';
import '../../src/styles/ui-v2.css';

const rows: Record<string, unknown>[] = [];
const params = new URLSearchParams(location.search);
const canvas = document.createElement('canvas');
canvas.width = Number(params.get('width')) || 2560;
canvas.height = Number(params.get('height')) || 1600;
const ctx = canvas.getContext('2d')!;
ctx.fillStyle = '#18212e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = 'white'; ctx.font = '32px sans-serif';
ctx.fillText('Cove owned fullscreen edge diagnostic', 80, 160);
const stream = canvas.captureStream(1);
for (const kind of ['pointerrawupdate', 'pointermove']) {
  document.addEventListener(kind, (e) => {
    const p = e as PointerEvent;
    rows.push({ stage: kind, at: performance.now(), x: p.clientX, y: p.clientY,
      trusted: p.isTrusted, target: (p.target as HTMLElement).tagName });
  }, { passive: true });
}
function Fixture() {
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(true);
  const rtc = {
    localScreen: null, remoteScreen: visible ? { socketId: 'owned', stream } : null,
    localSocketId: null, localScreenProducerId: null, availableScreens: [],
    screenShareVolume: 1, screenReceiveVolume: 1,
    setScreenShareVolume() {}, setScreenReceiveVolume() {}, stats: {},
  } as any;
  (window as any).edgeQa = {
    rows, setActive, setVisible,
    inspect() {
      const v = document.querySelector('video')!;
      const rect = v.getBoundingClientRect();
      const points = [0, 0.1, 0.5, 1, 2, 10].map(y => ({ y,
        hit: document.elementFromPoint(innerWidth / 2, y)?.tagName,
        mapped: normalizedVideoPoint(innerWidth / 2, y, rect, v.videoWidth, v.videoHeight, devicePixelRatio) }));
      return { fullscreen: document.fullscreenElement?.className ?? null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        rect: rect.toJSON(), video: { width: v.videoWidth, height: v.videoHeight }, points };
    },
  };
  return <>
    <div className="cove-window-titlebar"><div className="cove-window-controls"><button>X</button></div></div>
    <div style={{ position: 'fixed', inset: '40px 10px 10px' }}>
      <ShareViewV2 rtc={rtc} roomId="owned" debug={false} onToggleDebug={() => {}}
        remoteControl={{ state: active ? 'active' : 'available' }} sharerName="Synthetic fixture"
        onInput={input => rows.push({ stage: 'sent', at: performance.now(), ...input })}
        onRequestRemote={() => setActive(true)} onStopRemote={() => setActive(false)}
        onEnd={() => setVisible(false)} diagnosticsCompact={true} onToggleDiagnosticsCompact={() => {}} />
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
