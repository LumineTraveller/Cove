import { useRef, useState } from 'react';
import { Camera, Check, LogOut, Server, Trash2, UserRound, X } from 'lucide-react';
import { prepareAvatar } from '../profile';
import type { UserProfile } from '../types';
import { Avatar } from './Avatar';
import packageInfo from '../../package.json';
import { openUpdateCenter } from '../update';

interface Props {
  profile: UserProfile;
  serverURL: string;
  onSave: (profile: UserProfile) => void;
  onClose: () => void;
  onOpenServerSettings?: () => void;
  onReset?: () => void;
}

export function ProfileModal({ profile, serverURL, onSave, onClose, onOpenServerSettings, onReset }: Props) {
  const [username, setUsername] = useState(profile.username);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatarUrl);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    try {
      setError('');
      setAvatarUrl(await prepareAvatar(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '头像处理失败');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const save = () => {
    const nextName = username.trim();
    if (!nextName) { setError('用户名不能为空'); return; }
    onSave({ username: nextName.slice(0, 64), avatarUrl });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={onClose}>
      <section className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/15 bg-zinc-900/95 shadow-2xl" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="profile-title">
        <div className="relative h-28 bg-gradient-to-br from-cyan-400/25 via-sky-500/10 to-violet-500/20">
          <button onClick={onClose} className="absolute right-4 top-4 rounded-xl bg-black/25 p-2 text-white/60 transition hover:bg-black/40 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300" aria-label="关闭个人名片">
            <X size={18} />
          </button>
        </div>
        <div className="px-7 pb-10">
          <div className="-mt-12 flex items-end justify-between">
            <div className="relative">
              <Avatar username={username || profile.username} avatarUrl={avatarUrl} size="xl" className="border-4 border-zinc-900 shadow-xl" />
              <button onClick={() => inputRef.current?.click()} className="absolute bottom-0 right-0 rounded-full border-2 border-zinc-900 bg-white p-2 text-zinc-900 shadow-lg transition hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-300" aria-label="更换头像" title="更换头像">
                <Camera size={16} />
              </button>
              <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => chooseAvatar(event.target.files?.[0])} />
            </div>
            {avatarUrl && (
              <button onClick={() => setAvatarUrl(null)} className="mb-1 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-white/45 transition hover:bg-white/10 hover:text-white" title="移除头像">
                <Trash2 size={15} /> 移除头像
              </button>
            )}
          </div>

          <h2 id="profile-title" className="mt-5 text-xl font-bold text-white">个人名片</h2>
          <p className="mt-1 text-sm text-white/40">头像保存在本机，并同步给当前服务器上的在线成员。</p>

          <label className="mt-5 block text-sm font-medium text-white/55" htmlFor="profile-name">用户名</label>
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-4 focus-within:border-cyan-300/50 focus-within:ring-2 focus-within:ring-cyan-300/10">
            <UserRound size={18} className="text-white/35" />
            <input id="profile-name" value={username} onChange={event => setUsername(event.target.value)} maxLength={64} className="min-w-0 flex-1 bg-transparent py-3 text-white outline-none placeholder:text-white/20" placeholder="你的名字" />
          </div>

          <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-white/30"><Server size={14} /> 当前服务器</div>
            <p className="mt-1.5 truncate font-mono text-sm text-white/60" title={serverURL}>{serverURL}</p>
          </div>

          {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}

          <div className="mt-6 flex gap-2.5">
            {onOpenServerSettings && (
              <button onClick={onOpenServerSettings} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-white/10 py-3 font-medium text-white/65 transition hover:bg-white/15 hover:text-white">
                <Server size={17} /> 服务器设置
              </button>
            )}
            <button onClick={save} disabled={!username.trim()} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-30">
              <Check size={17} /> 保存名片
            </button>
          </div>
          {onReset && (
            <button onClick={onReset} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-red-300/70 transition hover:bg-red-500/10 hover:text-red-200">
              <LogOut size={16} /> 退出账号
            </button>
          )}
        </div>
        <button onClick={openUpdateCenter} className="absolute bottom-2.5 right-4 rounded-lg px-2 py-1 text-[11px] font-medium tracking-wide text-white/20 transition hover:bg-cyan-300/10 hover:text-cyan-100/80 focus:outline-none focus:ring-2 focus:ring-cyan-300/40" title="检查 Cove 更新" aria-label={`Cove v${packageInfo.version}，点击检查更新`}>
          Cove v{packageInfo.version}
        </button>
      </section>
    </div>
  );
}
