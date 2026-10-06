import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Phone } from 'lucide-react';
import {
  Microphone,
  MicrophoneSlash,
  MonitorPlay,
  PhoneDisconnect,
  SquaresFour,
  Waveform,
  Wrench,
} from '@phosphor-icons/react';
import { useWebRTC } from '../useWebRTC';
import {
  availableMiddleDockWidth,
  resolveControlBallFit,
  type ControlBallFit,
} from './controlBallResponsivePolicy';
import './controlBallMotion.css';

function measureDockWidths(dock: HTMLElement) {
  const clone = dock.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.querySelectorAll('button').forEach(button => {
    button.tabIndex = -1;
  });
  // Measure target layouts, not intermediate label/side widths in an animation.
  clone.querySelectorAll<HTMLElement>('*').forEach(element => {
    element.style.setProperty('transition', 'none', 'important');
  });
  Object.assign(clone.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    bottom: 'auto',
    transform: 'none',
    visibility: 'hidden',
    pointerEvents: 'none',
    transition: 'none',
  });
  clone.classList.remove('collapsed', 'closing', 'compact');
  clone.classList.add('expanded', 'full');
  document.body.appendChild(clone);
  const fullWidth = clone.getBoundingClientRect().width;
  clone.classList.remove('full');
  clone.classList.add('compact');
  const compactWidth = clone.getBoundingClientRect().width;
  clone.remove();
  return { fullWidth, compactWidth };
}

function visibleRect(element: Element | null): DOMRect | null {
  if (!element) return null;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function ControlBallV2({
  rtc,
  mode,
  onLeave,
  onLeaveVoice,
  onStartScreen,
  onEditScreen,
  onStartAudio,
  onToggleDebug,
  debug,
  onOpenDevices,
  onOpenSoundboard,
  soundboardButtonRef,
  soundboardAnchorRef,
  onSoundboardHoverStart,
  onSoundboardHoverEnd,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  mode: 'idle' | 'available' | 'watching' | 'self';
  onLeave: () => void;
  onLeaveVoice: () => void;
  onStartScreen: () => void;
  onEditScreen: () => void;
  onStartAudio: () => void;
  onToggleDebug: () => void;
  debug: boolean;
  onOpenDevices: () => void;
  onOpenSoundboard: () => void;
  soundboardButtonRef: {
    current: HTMLButtonElement | null;
  };
  soundboardAnchorRef: {
    current: HTMLDivElement | null;
  };
  onSoundboardHoverStart: () => void;
  onSoundboardHoverEnd: () => void;
}) {
  const [locked, setLocked] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [tinyOpen, setTinyOpen] = useState(false);
  const [adaptiveFit, setAdaptiveFit] = useState<ControlBallFit>('full');
  const [autoReleased, setAutoReleased] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockWidthsRef = useRef<ReturnType<typeof measureDockWidths> | null>(null);
  const lockedRef = useRef(true);
  const fitRef = useRef<ControlBallFit>('full');
  const autoReleasedRef = useRef(false);
  const preConstraintLockRef = useRef<boolean | null>(null);
  const pointerDownRef = useRef(false);
  const pointerResetTimer = useRef<number>();
  const leaveTimer = useRef<number>();
  const collapseTimer = useRef<number>();
  const sharedMode = mode === 'watching' || mode === 'self';
  const forcedBall = sharedMode && adaptiveFit === 'ball';
  const effectiveLocked = locked && !autoReleased && !forcedBall;
  const expanded = effectiveLocked || hovered || focusWithin || tinyOpen;
  const compactDock = rtc.inVoice && (mode === 'idle' || mode === 'available');
  const responsiveCompact = sharedMode && adaptiveFit !== 'full';
  const labelsVisible = !compactDock && !responsiveCompact && (expanded || closing);
  const selfShare = mode === 'self';
  const collapseDuration = 340;

  useLayoutEffect(() => {
    const labels = dockRef.current?.querySelectorAll<HTMLElement>('.dock-label');
    // scrollWidth retains the natural text width even when compact labels are
    // clipped to zero. Numeric endpoints let both directions animate smoothly.
    labels?.forEach(label => {
      label.style.setProperty('--dock-label-width', `${label.scrollWidth}px`);
    });
    dockWidthsRef.current = null;
  }, [mode, rtc.inVoice]);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  const clearCollapseTimer = () => {
    window.clearTimeout(collapseTimer.current);
    collapseTimer.current = undefined;
  };
  const beginCollapse = () => {
    clearCollapseTimer();
    setClosing(true);
    collapseTimer.current = window.setTimeout(() => {
      setClosing(false);
      collapseTimer.current = undefined;
    }, collapseDuration);
  };
  const toggleLock = () => {
    if (forcedBall) {
      clearCollapseTimer();
      setClosing(false);
      setTinyOpen(open => !open);
      return;
    }
    if (effectiveLocked) {
      lockedRef.current = false;
      setLocked(false);
      beginCollapse();
      setHovered(false);
      setTinyOpen(false);
      return;
    }

    autoReleasedRef.current = false;
    preConstraintLockRef.current = null;
    setAutoReleased(false);
    lockedRef.current = true;
    setLocked(true);
    setHovered(true);
    clearCollapseTimer();
    setClosing(false);
  };

  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(collapseTimer.current);
      window.clearTimeout(pointerResetTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (sharedMode) return;
    fitRef.current = 'full';
    setAdaptiveFit('full');
    setFocusWithin(false);
    setTinyOpen(false);
    if (autoReleasedRef.current) {
      const restoreLock = preConstraintLockRef.current;
      if (restoreLock != null) {
        lockedRef.current = restoreLock;
        setLocked(restoreLock);
      }
      autoReleasedRef.current = false;
      preConstraintLockRef.current = null;
      setAutoReleased(false);
    }
  }, [sharedMode]);

  useLayoutEffect(() => {
    if (!sharedMode) return;
    const anchor = soundboardAnchorRef.current;
    const dock = dockRef.current;
    const shell = anchor?.closest<HTMLElement>('.cove-shell');
    const workspace = shell?.querySelector<HTMLElement>('.workspace');
    const statusBar = shell?.querySelector<HTMLElement>('.share-status-bar');
    const statusLeft = statusBar?.querySelector<HTMLElement>('.share-status-left');
    const statusActions = statusBar?.querySelector<HTMLElement>('.share-status-actions');
    if (!anchor || !dock || !shell || !workspace || !statusBar || !statusLeft || !statusActions) {
      fitRef.current = 'full';
      setAdaptiveFit('full');
      return;
    }

    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      if (disposed) return;

      const statusRect = visibleRect(statusBar);
      const leftRect = visibleRect(statusLeft);
      const actionsRect = visibleRect(statusActions);
      const workspaceRect = workspace.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      if (!statusRect || !leftRect || !actionsRect || workspaceRect.width <= 0) {
        fitRef.current = 'full';
        setAdaptiveFit('full');
        return;
      }

      const occupiedLeft = Array.from(statusLeft.children)
        .filter(element => element.matches('b, .volume-control'))
        .map(visibleRect)
        .filter((rect): rect is DOMRect => rect !== null);
      const leftContentRight = Math.max(
        workspaceRect.left,
        ...occupiedLeft.map(rect => rect.right),
      );
      const availableWidth = availableMiddleDockWidth({
        workspaceLeft: workspaceRect.left,
        workspaceRight: workspaceRect.right,
        dockCenter: anchorRect.left + anchorRect.width / 2,
        leftContentRight,
        actionsLeft: actionsRect.left,
      });
      const { fullWidth, compactWidth } = dockWidthsRef.current
        ?? (dockWidthsRef.current = measureDockWidths(dock));
      const nextFit = resolveControlBallFit(
        availableWidth,
        fullWidth,
        compactWidth,
        fitRef.current,
      );

      if (nextFit !== fitRef.current) {
        fitRef.current = nextFit;
        setAdaptiveFit(nextFit);
        if (nextFit === 'ball' && !autoReleasedRef.current) {
          preConstraintLockRef.current = lockedRef.current;
          autoReleasedRef.current = true;
          lockedRef.current = false;
          setLocked(false);
          setAutoReleased(true);
        }
      }
    };
    const scheduleMeasure = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    [shell, workspace, anchor, dock, statusBar, statusLeft, statusActions,
      ...Array.from(statusLeft.children), shell?.querySelector('.navigation-rail')]
      .filter((element): element is Element => element instanceof Element)
      .forEach(element => resizeObserver.observe(element));
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(shell, { attributes: true, attributeFilter: ['class', 'style'] });
    mutationObserver.observe(statusBar, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    window.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    workspace.addEventListener('transitionend', scheduleMeasure);
    anchor.addEventListener('transitionend', scheduleMeasure);
    measure();

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      workspace.removeEventListener('transitionend', scheduleMeasure);
      anchor.removeEventListener('transitionend', scheduleMeasure);
    };
  }, [mode, rtc.inVoice, soundboardAnchorRef]);

  return (
    <div
      ref={soundboardAnchorRef}
      className={`control-ball-anchor ${expanded ? 'expanded' : 'collapsed'}`}
      onPointerDownCapture={() => {
        pointerDownRef.current = true;
        window.clearTimeout(pointerResetTimer.current);
        pointerResetTimer.current = window.setTimeout(() => {
          pointerDownRef.current = false;
          pointerResetTimer.current = undefined;
        }, 0);
      }}
      onFocusCapture={() => {
        if (pointerDownRef.current) return;
        clearCollapseTimer();
        setClosing(false);
        setFocusWithin(true);
      }}
      onBlurCapture={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusWithin(false);
        if (!effectiveLocked && !hovered) beginCollapse();
      }}
      onMouseEnter={() => {
        window.clearTimeout(leaveTimer.current);
        clearCollapseTimer();
        setClosing(false);
        setHovered(true);
      }}
      onMouseLeave={() => {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => {
          setHovered(false);
          if (!focusWithin) setTinyOpen(false);
          if (!effectiveLocked && !focusWithin) beginCollapse();
        }, 180);
        if (!effectiveLocked && !focusWithin) {
          window.clearTimeout(leaveTimer.current);
          leaveTimer.current = window.setTimeout(() => {
            beginCollapse();
            setHovered(false);
            if (!focusWithin) setTinyOpen(false);
          }, 180);
        }
      }}
    >
      <div
        ref={dockRef}
        className={`control-ball ${expanded ? 'expanded' : 'collapsed'} ${
          effectiveLocked ? 'locked' : 'unlocked'
        } ${labelsVisible ? 'full' : 'compact'} ${closing ? 'closing' : ''} ${
          rtc.inVoice ? 'voice-active' : 'voice-idle'
        }`}
      >
        <div className="ball-side ball-left">
          <button
            className={rtc.inVoice && !rtc.isMuted ? 'enabled-blue' : ''}
            onClick={rtc.inVoice ? rtc.toggleMute : rtc.joinVoice}
            aria-label={rtc.inVoice ? '切换麦克风' : '加入语音'}
            tabIndex={expanded ? 0 : -1}
            onContextMenu={(event) => {
              event.preventDefault();
              onOpenDevices();
            }}
            title={rtc.inVoice ? '切换麦克风' : '加入语音'}
          >
            {!rtc.inVoice ? (
              <Phone size={21} strokeWidth={2} />
            ) : rtc.isMuted ? (
              <MicrophoneSlash size={21} />
            ) : (
              <Microphone size={21} weight="fill" />
            )}
            <span className="dock-label">{rtc.inVoice ? '麦克风' : '加入语音'}</span>
          </button>
          {rtc.inVoice && (
            <>
              <button
                className={selfShare ? 'enabled-yellow' : ''}
                onClick={selfShare ? rtc.stopScreenShare : onStartScreen}
                aria-label={selfShare ? '结束共享' : '共享屏幕'}
                tabIndex={expanded ? 0 : -1}
                onContextMenu={(event) => {
                  if (!selfShare) return;
                  event.preventDefault();
                  onEditScreen();
                }}
                title={selfShare ? '左键结束共享，右键修改参数' : '共享屏幕'}
              >
                <MonitorPlay size={21} weight={selfShare ? 'fill' : 'regular'} />
                <span className="dock-label">{selfShare ? '结束共享' : '共享屏幕'}</span>
              </button>
              <button
                className={rtc.isApplicationAudioSharing ? 'enabled-purple' : ''}
                onClick={
                  rtc.isApplicationAudioSharing ? rtc.stopApplicationAudioShare : onStartAudio
                }
                aria-label="共享音频"
                tabIndex={expanded ? 0 : -1}
                title="共享音频"
              >
                <Waveform size={21} weight="bold" />
                <span className="dock-label">共享音频</span>
              </button>
            </>
          )}
        </div>
        <button
          className="ball-quad"
          onClick={toggleLock}
          aria-label={forcedBall ? '展开语音控制' : effectiveLocked ? '点击解锁收起' : '点击锁定展开'}
          aria-expanded={expanded}
          title={forcedBall ? '展开语音控制' : effectiveLocked ? '点击解锁收起' : '点击锁定展开'}
        >
          <span className={`quad-grid ${effectiveLocked ? 'upright' : 'tilted'}`}>
            <i className={`quad-lamp mic ${rtc.inVoice && !rtc.isMuted ? 'on' : ''}`} />
            <i className={`quad-lamp screen ${selfShare ? 'on' : ''}`} />
            <i className={`quad-lamp audio ${rtc.isApplicationAudioSharing ? 'on' : ''}`} />
            <i className="quad-lamp net good" />
          </span>
        </button>
        <div className="ball-side ball-right">
          {rtc.inVoice && (
            <>
              <button
                ref={soundboardButtonRef}
                onClick={onOpenSoundboard}
                aria-label="语音包"
                tabIndex={expanded ? 0 : -1}
                onMouseEnter={onSoundboardHoverStart}
                onMouseLeave={onSoundboardHoverEnd}
                onFocus={onSoundboardHoverStart}
                onBlur={onSoundboardHoverEnd}
                title="语音包"
              >
                <SquaresFour size={21} />
                <span className="dock-label">语音包</span>
              </button>
              <button
                className={debug ? 'debug-enabled' : ''}
                onClick={onToggleDebug}
                aria-label="调试信息"
                tabIndex={expanded ? 0 : -1}
                title="调试信息"
              >
                <Wrench size={21} />
                <span className="dock-label">调试信息</span>
              </button>
            </>
          )}
          <button
            className="ball-leave danger"
            onClick={rtc.inVoice ? onLeaveVoice : onLeave}
            aria-label={rtc.inVoice ? '离开语音' : '离开频道'}
            tabIndex={expanded ? 0 : -1}
            title={rtc.inVoice ? '离开语音' : '离开频道'}
          >
            <PhoneDisconnect size={22} weight="fill" />
            <span className="dock-label">{rtc.inVoice ? '离开语音' : '离开频道'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
