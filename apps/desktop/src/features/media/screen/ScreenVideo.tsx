import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MonitorPlay } from '@phosphor-icons/react';
import { bindScreenVideo, type ScreenVideoStatus } from './screenVideoPlayback';
import {
  normalizedVideoPoint,
  RemotePointerSender,
  type RemoteControlInput,
} from '../../remote-control/remoteControl';

function useScreenVideo(stream: MediaStream, remote: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const retryRef = useRef<() => void>(() => undefined);
  const [presentation, setPresentation] = useState<{
    stream: MediaStream;
    status: ScreenVideoStatus;
  } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const binding = bindScreenVideo(video, stream, remote, (status) => {
      setPresentation({ stream, status });
    });
    retryRef.current = binding.retry;
    return () => {
      retryRef.current = () => undefined;
      binding.dispose();
    };
  }, [stream, remote]);

  return {
    videoRef,
    ready: presentation?.stream === stream && presentation.status === 'ready',
    failed: presentation?.stream === stream && presentation.status === 'error',
    retry: () => retryRef.current(),
  };
}

function ScreenVideoLoading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div className="screen-video-loading" role="status">
      <MonitorPlay size={36} />
      <span>{failed ? '共享画面暂时无法播放' : '正在准备共享画面…'}</span>
      {failed && <button onClick={onRetry}>重试播放</button>}
    </div>
  );
}

export function LocalScreenVideo({ stream }: { stream: MediaStream }) {
  const { videoRef, ready, failed, retry } = useScreenVideo(stream, false);
  return (
    <div className="screen-video-surface" aria-busy={!ready}>
      <video ref={videoRef} autoPlay muted playsInline />
      {!ready && <ScreenVideoLoading failed={failed} onRetry={retry} />}
    </div>
  );
}

export function RemoteScreenVideo({
  stream,
  controlling,
  onInput,
}: {
  stream: MediaStream;
  controlling: boolean;
  onInput: (input: RemoteControlInput) => void;
}) {
  const { videoRef, ready, failed, retry } = useScreenVideo(stream, true);
  const canControl = controlling && ready;
  const inputSender = useMemo(() => new RemotePointerSender(onInput), [onInput]);
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Map<'left' | 'right' | 'middle', { x: number; y: number }>());
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const point = (event: { clientX: number; clientY: number }) => {
    const video = videoRef.current;
    if (!video) return null;
    return normalizedVideoPoint(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
  };
  const rememberPoint = (mapped: { x: number; y: number } | null) => {
    if (!mapped) return null;
    lastPoint.current = mapped;
    pressedButtons.current.forEach((_, button) => {
      pressedButtons.current.set(button, mapped);
    });
    return mapped;
  };
  const release = useCallback(() => {
    inputSender.cancel();
    pressedKeys.current.forEach((code) => inputSender.send({ type: 'key', code, down: false }));
    pressedButtons.current.forEach((mapped, button) =>
      inputSender.send({ type: 'button', button, down: false, ...mapped }),
    );
    pressedKeys.current.clear();
    pressedButtons.current.clear();
  }, [inputSender]);
  useEffect(() => {
    if (!canControl) release();
    return release;
  }, [canControl, release]);
  return (
    <div
      className={`remote-video-surface ${canControl ? 'controlling' : ''}`}
      aria-busy={!ready}
      tabIndex={canControl ? 0 : -1}
      onPointerMove={(event) => {
        if (!canControl) return;
        const p = rememberPoint(point(event));
        if (p) inputSender.send({ type: 'pointer', ...p });
      }}
      onPointerDown={(event) => {
        if (!canControl) return;
        const button =
          event.button === 0
            ? 'left'
            : event.button === 1
            ? 'middle'
            : event.button === 2
            ? 'right'
            : null;
        const p = rememberPoint(point(event));
        if (!button || !p) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressedButtons.current.set(button, p);
        inputSender.send({ type: 'button', button, down: true, ...p });
      }}
      onPointerUp={(event) => {
        if (!canControl) return;
        const button =
          event.button === 0
            ? 'left'
            : event.button === 1
            ? 'middle'
            : event.button === 2
            ? 'right'
            : null;
        const p = rememberPoint(point(event));
        if (!button) return;
        const releasePoint = p ?? pressedButtons.current.get(button) ?? lastPoint.current;
        if (!releasePoint) return;
        event.preventDefault();
        pressedButtons.current.delete(button);
        inputSender.send({ type: 'button', button, down: false, ...releasePoint });
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onWheel={(event) => {
        if (!canControl) return;
        const p = point(event);
        if (!p) return;
        event.preventDefault();
        inputSender.send({
          type: 'wheel',
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ...p,
        });
      }}
      onKeyDown={(event) => {
        if (!canControl || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.add(event.code);
        inputSender.send({ type: 'key', code: event.code, down: true });
      }}
      onKeyUp={(event) => {
        if (!canControl) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.delete(event.code);
        inputSender.send({ type: 'key', code: event.code, down: false });
      }}
      onBlur={release}
      onContextMenu={(event) => canControl && event.preventDefault()}
    >
      <video ref={videoRef} autoPlay muted playsInline />
      <span className="remote-control-frame" />
      {!ready && <ScreenVideoLoading failed={failed} onRetry={retry} />}
    </div>
  );
}
