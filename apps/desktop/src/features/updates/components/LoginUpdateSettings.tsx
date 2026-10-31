import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { UpdateCenter } from './UpdateCenter';
import type { ClientUpgradeRequirement } from '../clientVersion';
import { UPDATE_SETTINGS_OPEN_EVENT } from '../update';

function UpdateSettingsDialog({ onClose, requiredUpgrade, onRetryVersion }: {
  onClose(): void;
  requiredUpgrade?: ClientUpgradeRequirement;
  onRetryVersion?: () => Promise<unknown>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return <dialog ref={dialogRef} className="auth-update-dialog" aria-labelledby="login-update-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="auth-update-content">
      <header className="auth-update-heading">
        <div><h2 id="login-update-title">更新设置</h2><p>设置下载来源，检查并获取新版 Cove。</p></div>
        <button type="button" className="update-status-close" aria-label="关闭更新设置" onClick={onClose}><X size={19} /></button>
      </header>
      <UpdateCenter embedded requiredUpgrade={requiredUpgrade} onRetryVersion={onRetryVersion} />
    </div>
  </dialog>;
}

export function LoginUpdateSettings({ requiredUpgrade, onRetryVersion }: {
  requiredUpgrade?: ClientUpgradeRequirement;
  onRetryVersion?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const openSettings = () => setOpen(true);
    window.addEventListener(UPDATE_SETTINGS_OPEN_EVENT, openSettings);
    return () => window.removeEventListener(UPDATE_SETTINGS_OPEN_EVENT, openSettings);
  }, []);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  return <>
    <button ref={triggerRef} type="button" className="auth-update-trigger" aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(true)}><RefreshCw size={16} />更新设置</button>
    {open && <UpdateSettingsDialog onClose={close} requiredUpgrade={requiredUpgrade} onRetryVersion={onRetryVersion} />}
  </>;
}
