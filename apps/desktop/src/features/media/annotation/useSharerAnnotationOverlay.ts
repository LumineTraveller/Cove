import { useEffect, useRef, useState } from 'react';
import type { useScreenAnnotations } from './useScreenAnnotations';

/** Mirror the owner's session even while Cove displays somebody else's share. */
export function useSharerAnnotationOverlay(
  annotations: ReturnType<typeof useScreenAnnotations>,
  stream: MediaStream | null,
  sessionId: string | null,
) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const latest = useRef(annotations);
  latest.current = annotations;
  const drawing = useRef<{ id: string; tool: 'pen' | 'eraser'; color: string; width: number } | null>(null);

  useEffect(() => {
    const bridge = window.coveAnnotationOverlay;
    const track = stream?.getVideoTracks()[0];
    setToken(null); tokenRef.current = null; setError(null);
    if (!bridge || !sessionId || !track || track.readyState === 'ended') return;
    let disposed = false;
    let bound: string | null = null;
    const stop = () => {
      disposed = true;
      drawing.current = null;
      if (bound) void bridge.close(bound).catch(() => {});
      tokenRef.current = null;
      setToken(null);
    };
    const removeFailure = bridge.onFailure(event => {
      if (!disposed && event.token === tokenRef.current) {
        drawing.current = null;
        latest.current.exit();
        setError(event.reason);
      }
    });
    const removeInput = bridge.onInput?.(event => {
      if (disposed || event.token !== tokenRef.current) return;
      const current = latest.current;
      const input = event.input;
      const finish = () => {
        if (drawing.current) current.finishStroke(drawing.current.id);
        drawing.current = null;
      };
      if (input.type === 'exit') { finish(); current.exit(); return; }
      if (!current.canDraw || !current.localActive) return;
      switch (input.type) {
        case 'stroke-start': {
          finish();
          const id = current.sendStroke(input.tool, input.color, input.width, [input.point], crypto.randomUUID(), false);
          if (id) drawing.current = { id, tool: input.tool, color: input.color, width: input.width };
          break;
        }
        case 'stroke-point': {
          const stroke = drawing.current;
          if (stroke) current.sendStroke(stroke.tool, stroke.color, stroke.width, [input.point], stroke.id);
          break;
        }
        case 'stroke-end': finish(); break;
        case 'laser': current.sendLaser(input.point); break;
        case 'clear': finish(); void current.clear(); break;
      }
    });
    track.addEventListener('ended', stop);
    void bridge.bind(sessionId).then(result => {
      bound = result.token ?? null;
      if (disposed || track.readyState === 'ended') {
        if (bound) void bridge.close(bound).catch(() => {});
        return;
      }
      tokenRef.current = bound;
      setToken(bound);
      setError(result.error ?? null);
    }).catch(() => { if (!disposed) setError('无法启动桌面批注覆盖层。'); });
    return () => { stop(); removeFailure(); removeInput?.(); track.removeEventListener('ended', stop); };
  }, [stream, sessionId]);

  useEffect(() => {
    const bridge = window.coveAnnotationOverlay;
    if (!bridge || !token) return;
    const valid = annotations.ready && annotations.state?.enabled && annotations.state.sessionId === sessionId;
    // Only server-authorized state and this hook's permitted optimistic tail.
    void bridge.update(token, valid ? {
      strokes: [...annotations.state!.strokes, ...annotations.optimisticStrokes],
      lasers: Object.values(annotations.laserPoints),
    } : { strokes: [], lasers: [] }).then(ok => {
      if (!ok && tokenRef.current === token) setError('桌面批注会话已失效，请停止并重新共享。');
    }).catch(() => { if (tokenRef.current === token) setError('桌面批注同步失败。'); });
  }, [token, sessionId, annotations.ready, annotations.state, annotations.optimisticStrokes, annotations.laserPoints]);

  useEffect(() => {
    const bridge = window.coveAnnotationOverlay;
    if (!token || !bridge?.setInputActive) return;
    const active = annotations.ready && annotations.state?.sessionId === sessionId && annotations.canDraw && annotations.localActive;
    if (!active) drawing.current = null;
    void bridge.setInputActive(token, Boolean(active)).then(ok => {
      if (!ok && tokenRef.current === token) {
        latest.current.exit();
        setError('桌面绘画未启动，请退出后重试。');
      }
    }).catch(() => {
      if (tokenRef.current === token) { latest.current.exit(); setError('桌面绘画同步失败。'); }
    });
  }, [token, sessionId, annotations.ready, annotations.state?.sessionId, annotations.canDraw, annotations.localActive]);

  return error;
}
