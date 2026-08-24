import { useState } from 'react';
import { Check, Clipboard, Hash, UserRound, X } from 'lucide-react';
import { Avatar } from './Avatar';

interface Props {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  remark?: string;
  onSaveRemark: (remark: string) => void;
  onClose: () => void;
}

export function UserProfileModal({ userId, username, avatarUrl, remark = '', onSaveRemark, onClose }: Props) {
  const [draft, setDraft] = useState(remark);
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch { /* 仍可手动选中 ID */ }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={onClose}>
      <section className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/15 bg-zinc-900/95 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="other-profile-title">
        <div className="relative h-28 bg-gradient-to-br from-violet-400/20 via-cyan-500/10 to-sky-500/20">
          <button onClick={onClose} className="absolute right-4 top-4 rounded-xl bg-black/25 p-2 text-white/60 transition hover:bg-black/40 hover:text-white" aria-label="关闭用户主页"><X size={18} /></button>
        </div>
        <div className="px-7 pb-7">
          <Avatar username={username} avatarUrl={avatarUrl} size="xl" className="-mt-12 border-4 border-zinc-900 shadow-xl" />
          <h2 id="other-profile-title" className="mt-4 text-2xl font-bold text-white">{remark || username}</h2>
          {remark && <p className="mt-1 text-sm text-white/45">用户名：{username}</p>}

          <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/20 p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-white/30"><Hash size={14} /> 用户 ID</div>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all text-sm text-cyan-100/75">{userId}</code>
              <button onClick={copyId} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-2 text-xs text-white/55 transition hover:bg-white/10 hover:text-white" title="复制用户 ID"><Clipboard size={14} />{copied ? '已复制' : '复制'}</button>
            </div>
          </div>

          <label className="mt-5 block text-sm font-medium text-white/55" htmlFor="profile-remark">我的备注</label>
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-4 focus-within:border-cyan-300/50">
            <UserRound size={18} className="text-white/35" />
            <input id="profile-remark" value={draft} onChange={event => setDraft(event.target.value)} maxLength={64} className="min-w-0 flex-1 bg-transparent py-3 text-white outline-none placeholder:text-white/20" placeholder="添加仅自己可见的备注" autoFocus />
          </div>
          <p className="mt-2 text-xs text-white/30">备注只保存在这台设备，不会通知对方。</p>

          <button onClick={() => { onSaveRemark(draft); onClose(); }} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100"><Check size={17} />保存备注</button>
        </div>
      </section>
    </div>
  );
}
