import { useRef, useState } from 'react';
import { MonitorPlay, Cursor as MousePointer2, Radio, X } from '@phosphor-icons/react';
import { useWebRTC } from '../useWebRTC';
import { useScreenFullscreen } from './useScreenFullscreen';
import { diagnosticPacketLoss } from '../diagnostics/mediaDiagnostics';
import { type RemoteControlInput } from '../../remote-control/remoteControl';
import { RemoteScreenVideo, LocalScreenVideo } from './ScreenVideo';
import { DiagnosticsOverlayV2 } from '../diagnostics/DiagnosticsOverlayV2';
import { ShareStatusBarV2 } from './ShareStatusBarV2';
import { socket } from '../../connection/socket';
import { useScreenAnnotations } from '../annotation/useScreenAnnotations';
import { ScreenAnnotationLayer } from '../annotation/ScreenAnnotationLayer';
import { useSharerAnnotationOverlay } from '../annotation/useSharerAnnotationOverlay';

export function ShareViewV2({
  rtc,
  roomId,
  debug,
  onToggleDebug,
  remoteControl,
  sharerName,
  onInput,
  onRequestRemote,
  onStopRemote,
  onEnd,
  diagnosticsCompact,
  onToggleDiagnosticsCompact,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  roomId: string;
  debug: boolean;
  onToggleDebug: () => void;
  remoteControl: {
    state: 'available' | 'pending' | 'active' | 'unsupported';
    sharerActive?: boolean;
    controllerName?: string;
    cooldownSeconds?: number;
  };
  sharerName: string;
  onInput: (input: RemoteControlInput) => void;
  onRequestRemote: () => void;
  onStopRemote: () => void;
  onEnd: () => void;
  diagnosticsCompact: boolean;
  onToggleDiagnosticsCompact: () => void;
}) {
  const local = Boolean(rtc.localScreen);
  const remote = rtc.remoteScreen;
  const videoHostRef = useRef<HTMLDivElement>(null);
  const displayedSelf = local && !remote;
  const ownAnnotations = useScreenAnnotations({ socket, roomId, sharerSocketId: rtc.localSocketId ?? '',
    sessionId: rtc.localScreenProducerId, self: true, active: local });
  const remoteSessionId = remote
    ? rtc.availableScreens.find(screen => screen.socketId === remote.socketId)?.videoProducerId ?? null : null;
  const viewerAnnotations = useScreenAnnotations({ socket, roomId, sharerSocketId: remote?.socketId ?? '',
    sessionId: remoteSessionId, self: false, active: Boolean(remote) });
  const annotations = remote ? viewerAnnotations : ownAnnotations;
  const overlayError = useSharerAnnotationOverlay(ownAnnotations, rtc.localScreen, rtc.localScreenProducerId);
  const [muted, setMuted] = useState(false);
  const lastVolume = useRef(100);
  const {
    screenContainerRef,
    screenMaximized,
    nativeFullscreen,
    toggleFullscreen,
    toggleNativeFullscreen,
  } = useScreenFullscreen(Boolean(rtc.localScreen || rtc.remoteScreen));
  const sharer = sharerName;
  const end = () => {
    if (nativeFullscreen) void toggleNativeFullscreen();
    if (screenMaximized) toggleFullscreen();
    onEnd();
  };
  const currentVolume = (local ? rtc.screenShareVolume : rtc.screenReceiveVolume) * 100;
  const setCurrentVolume = (value: number) => {
    if (value > 0) setMuted(false);
    if (local) rtc.setScreenShareVolume(value / 100);
    else rtc.setScreenReceiveVolume(value / 100);
  };
  const toggleVolumeMute = () => {
    if (muted || currentVolume === 0) {
      setCurrentVolume(lastVolume.current || 100);
      setMuted(false);
    } else {
      lastVolume.current = currentVolume;
      setCurrentVolume(0);
      setMuted(true);
    }
  };
  return (
    <div className={`share-view ${screenMaximized ? 'screen-maximized' : ''}`}>
      <div ref={screenContainerRef} className="video-surface">
        <div className="video-content" ref={videoHostRef}>
          {remote ? (
            <RemoteScreenVideo
              stream={remote.stream}
              controlling={remoteControl.state === 'active' && !annotations.localActive}
              onInput={onInput}
            />
          ) : local ? (
            <LocalScreenVideo stream={rtc.localScreen!} />
          ) : (
            <div className="video-placeholder">
              <MonitorPlay size={42} />
              <span>共享画面将在这里显示</span>
            </div>
          )}
          {displayedSelf && window.coveAnnotationOverlay?.setInputActive
            ? annotations.localActive && <p className="annotation-owner-status" role="status">
                已进入共享屏幕绘画；窗口共享时请切到被共享窗口。Esc 退出。
                <button onClick={annotations.exit}>退出绘画</button>
              </p>
            : <ScreenAnnotationLayer annotations={annotations} self={displayedSelf} videoHostRef={videoHostRef} />}
          {overlayError && <p className="annotation-layer-status" role="status">{overlayError}</p>}
        </div>
        {debug && (
          <DiagnosticsOverlayV2
            rtc={rtc}
            compact={diagnosticsCompact}
            onToggleCompact={onToggleDiagnosticsCompact}
          />
        )}
        {false && (
          <div className="debug-overlay">
            <header>
              <Radio size={17} weight="fill" />
              媒体调试
              <button className="icon-btn" onClick={onToggleDebug} aria-label="关闭调试信息">
                <X size={15} />
              </button>
            </header>
            <div>
              <span>分辨率</span>
              <b>
                {rtc.stats.width && rtc.stats.height
                  ? `${rtc.stats.width} × ${rtc.stats.height}`
                  : '等待数据'}
              </b>
            </div>
            <div>
              <span>帧率</span>
              <b>{local ? rtc.stats.sendFps ?? '—' : rtc.stats.receiveFps ?? '—'} fps</b>
            </div>
            <div>
              <span>码率</span>
              <b>{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</b>
            </div>
            <div>
              <span>丢包</span>
              <b>
                {diagnosticPacketLoss(rtc.stats) != null
                  ? `${diagnosticPacketLoss(rtc.stats)}%`
                  : '—'}
              </b>
            </div>
          </div>
        )}
        {remoteControl.sharerActive && (
          <div className="remote-control-banner">
            <b>
              <MousePointer2 size={14} />
              {remoteControl.controllerName ?? '成员'} 正在控制你的屏幕
            </b>
            <button onClick={onStopRemote}>停止控制</button>
          </div>
        )}
      </div>
      <ShareStatusBarV2
        self={displayedSelf}
        annotations={annotations}
        sharer={sharer}
        volume={currentVolume}
        onVolume={setCurrentVolume}
        muted={muted}
        onMute={toggleVolumeMute}
        onRemote={onRequestRemote}
        remoteState={remoteControl.state}
        remoteCooldownSeconds={remoteControl.cooldownSeconds ?? 0}
        onStopRemote={onStopRemote}
        onFull={toggleNativeFullscreen}
        onEnd={end}
        fullscreenMode={nativeFullscreen ? 'full' : screenMaximized ? 'app' : null}
        onAppFull={toggleFullscreen}
        hasAudio={
          local ? Boolean(rtc.localScreen?.getAudioTracks().length) : rtc.screenReceiveHasAudio
        }
      />
    </div>
  );
}
