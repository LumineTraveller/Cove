import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnnotationState, AnnotationStroke } from '@cove/contracts';
import { useScreenAnnotations } from '../../src/features/media/annotation/useScreenAnnotations';
import { ScreenAnnotationLayer } from '../../src/features/media/annotation/ScreenAnnotationLayer';
import { DiagnosticsOverlayV2 } from '../../src/features/media/diagnostics/DiagnosticsOverlayV2';
import '../../src/styles/ui-v2.css';

let server: AnnotationState = {
  roomId: 'fixture-room', sharerSocketId: 'fixture-owner', sessionId: 'fixture-screen',
  revision: 1, clearRevision: 0, enabled: true, permission: 'everyone', remoteControlAllowed: true,
  strokes: [], grants: [], requests: [],
};
const listeners = new Map<string, Set<(value: any) => void>>();
const publish = (event: string, value: unknown) => listeners.get(event)?.forEach(handler => handler(structuredClone(value)));
let held: { payload: any; ack: (value: any) => void }[] = [];
let hold = false, diagnosticClicks = 0;
const draws: any[] = [];
const accept = (stroke: AnnotationStroke) => {
  const existing = server.strokes.find(item => item.id === stroke.id);
  if (existing) existing.points.push(...stroke.points);
  else server.strokes.push(structuredClone(stroke));
  server.revision++;
  publish('annotation:stroke', { sessionId: server.sessionId, revision: server.revision, stroke });
};
const processDraw = ({ payload, ack }: typeof held[number]) => {
  if (payload.clearRevision !== server.clearRevision) {
    ack({ ok: false, error: { code: 'invalid_payload', message: '画布已清空，请重新落笔' } }); return;
  }
  accept({ ...payload.stroke, authorSocketId: 'fixture-viewer' });
  ack({ ok: true, revision: server.revision });
};
const socket: any = {
  id: 'fixture-viewer', connected: true,
  on(event: string, handler: (value: any) => void) {
    const handlers = listeners.get(event) ?? new Set(); handlers.add(handler); listeners.set(event, handlers);
  },
  off(event: string, handler: (value: any) => void) { listeners.get(event)?.delete(handler); },
  emit(event: string, payload: any, ack: (value: any) => void = () => {}) {
    if (event === 'annotation:get') ack({ ok: true, state: structuredClone(server) });
    if (event === 'annotation:clear') {
      server.strokes = []; server.clearRevision = ++server.revision;
      publish('annotation:state', server); ack({ ok: true, state: structuredClone(server) });
    }
    if (event === 'annotation:draw') {
      draws.push(structuredClone(payload));
      if (hold) held.push({ payload: structuredClone(payload), ack }); else processDraw({ payload, ack });
    }
  },
};
socket.volatile = { emit() {} };

function Fixture() {
  const host = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  const annotations = useScreenAnnotations({ socket, roomId: server.roomId, sharerSocketId: server.sharerSocketId,
    sessionId: server.sessionId, self: false, active: true });
  useLayoutEffect(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#183044'; context.fillRect(0, 0, 1280, 720);
    context.fillStyle = '#304b60';
    for (let x = 0; x < 1280; x += 80) context.fillRect(x, 0, 1, 720);
    for (let y = 0; y < 720; y += 80) context.fillRect(0, y, 1280, 1);
    const stream = canvas.captureStream(1);
    video.current!.srcObject = stream; void video.current!.play();
    return () => stream.getTracks().forEach(track => track.stop());
  }, []);
  useEffect(() => {
    (window as any).annotationProbe = {
      start: annotations.start, clear: annotations.clear, stroke: annotations.sendStroke, finish: annotations.finishStroke,
      state: () => structuredClone({ state: annotations.state, optimistic: annotations.optimisticStrokes, error: annotations.error,
        ready: annotations.ready, canDraw: annotations.canDraw, held: held.length, drawCount: draws.length, diagnosticClicks }),
      hold(value: boolean) { hold = value; },
      release() { hold = false; const queued = held; held = []; queued.forEach(processDraw); },
      peer(tool: 'pen' | 'eraser', color: string, points: AnnotationStroke['points'], width = 0.06) {
        accept({ id: crypto.randomUUID(), authorSocketId: 'fixture-peer', tool, color, points, width });
      },
    };
  });
  return <section className="share-view" style={{ width: 880, height: 560, margin: 32 }}>
    <div className="video-surface" style={{ position: 'relative', height: '100%', borderRadius: 16 }}>
      <div className="video-content" ref={host} style={{ position: 'absolute', inset: 0 }}>
        <video ref={video} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        <ScreenAnnotationLayer annotations={annotations} self={false} videoHostRef={host} diagnosticsMode="compact" />
      </div>
      <DiagnosticsOverlayV2 compact rtc={{ stats: { role: 'receiver' }, exportMediaDiagnostics: () => diagnosticClicks++ } as any}
        onToggleCompact={() => diagnosticClicks++} />
    </div>
  </section>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
