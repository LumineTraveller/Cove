import { useEffect, useId, useRef, useState } from 'react';
import { CaretUp, Cursor, GearSix, PaintBrush, CircleNotch } from '@phosphor-icons/react';
import type { useScreenAnnotations } from './useScreenAnnotations';
import './annotationUI.css';

export function ShareOperationsMenu({ self, annotations, remoteState, cooldownSeconds, onRemote, onStopRemote }: {
  self: boolean;
  annotations: ReturnType<typeof useScreenAnnotations>;
  remoteState: 'available' | 'pending' | 'active' | 'unsupported';
  cooldownSeconds: number;
  onRemote: () => void;
  onStopRemote: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => { if (annotations.localActive) setOpen(false); }, [annotations.localActive]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const remoteBusy = remoteState === 'pending' || remoteState === 'active';
  const remoteDisabled = !remoteBusy && (remoteState === 'unsupported' || cooldownSeconds > 0 || !annotations.remoteControlAllowed);
  const annotationDisabled = !annotations.ready || annotations.pendingAction || annotations.isRequestPending ||
    !annotations.state?.enabled || (!self && annotations.permission === 'sharer');
  const remoteTitle = remoteState === 'unsupported' ? '双方都需要支持远控的 Windows 客户端' :
    !annotations.remoteControlAllowed ? '共享者已禁止远控' : cooldownSeconds > 0 ? `请等待 ${cooldownSeconds} 秒后再申请` : undefined;
  const remote = () => {
    setOpen(false);
    if (remoteBusy) onStopRemote();
    else {
      annotations.exit();
      onRemote();
    }
  };
  const annotate = () => {
    if (remoteBusy) onStopRemote();
    if (annotations.localActive) setOpen(false);
    void annotations.start();
  };
  return <div className="share-operations" ref={ref} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus();
    } else if (event.key === 'ArrowUp' && !open) {
      event.preventDefault(); setOpen(true);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('.share-operations-popover button:not(:disabled)')?.focus());
    }
  }}>
    <button ref={buttonRef} className="share-operations-trigger" aria-expanded={open} aria-controls={menuId}
      onClick={() => setOpen(value => !value)}>
      <GearSix size={17} />{self ? '管理共享' : '共享操作'}
      {self && Boolean(annotations.state?.requests.length) && <span className="annotation-menu-request-count"
        aria-label={`${annotations.state!.requests.length} 个待处理的批注申请`}>{annotations.state!.requests.length}</span>}
      <CaretUp size={12} />
    </button>
    {open && <div className="share-operations-popover" id={menuId} aria-label={self ? '管理共享' : '共享操作'}>
      {self ? <button className={!annotations.remoteControlAllowed ? 'remote-forbidden' : ''}
        disabled={!annotations.ready || Boolean(annotations.pendingAction)}
        aria-pressed={annotations.remoteControlAllowed}
        title={annotations.remoteControlAllowed ? '点击禁止远控，并停止当前远控' : '点击允许远控申请'}
        onClick={() => { void annotations.setRemoteControlAllowed(!annotations.remoteControlAllowed); }}>
        <Cursor size={18} />{annotations.remoteControlAllowed ? '允许远控' : '禁止远控'}
      </button> : <button className={remoteState === 'pending' ? 'remote-pending' : ''}
        disabled={remoteDisabled} title={remoteTitle} onClick={remote}>
        {remoteState === 'pending' ? <CircleNotch size={18} /> : <Cursor size={18} />}
        {remoteState === 'active' ? '停止远程控制' : remoteState === 'pending' ? '取消请求' : cooldownSeconds > 0 ? `${cooldownSeconds} 秒后可申请` : '远程控制'}
      </button>}
      {self && <button aria-label="允许批注" aria-pressed={annotations.annotationsAllowed}
        disabled={!annotations.ready || Boolean(annotations.pendingAction)}
        title="允许时，同频道观看者可直接批注；关闭会撤销绘画输入"
        onClick={() => { void annotations.setAnnotationsAllowed(!annotations.annotationsAllowed); }}>
        <PaintBrush size={18} />{annotations.annotationsAllowed ? '批注已开启' : '批注已关闭'}
      </button>}
      <button disabled={Boolean(annotationDisabled)} onClick={annotate}
        title={!annotations.ready ? '需要支持批注的服务器' : !self && !annotations.state?.enabled ? '共享者尚未开启批注' : !self && annotations.permission === 'sharer' ? '当前仅共享者可以批注' : undefined}>
        <PaintBrush size={18} />{annotations.isRequestPending ? '等待批注批准' : annotations.localActive ? '返回批注' : self && window.coveAnnotationOverlay ? '在共享屏幕绘画' : '开始批注'}
      </button>
      {annotations.error && <p className="annotation-menu-error" role="status">{annotations.error}</p>}
    </div>}
  </div>;
}
