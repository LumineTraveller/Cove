import { useState, useEffect, useRef, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface Soundpack {
  id: string;
  name: string;
  filename: string;
  uploader: string;
  createdAt: number;
}

interface Props {
  socket: Socket;
  roomId: string;
  serverURL: string;
}

export function SoundPackPanel({ socket, roomId, serverURL }: Props) {
  const [packs, setPacks]         = useState<Soundpack[]>([]);
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef     = useRef<HTMLAudioElement | null>(null);
  // 用 ref 避免 socket 事件闭包里拿到 stale 的 packs
  const packsRef     = useRef<Soundpack[]>([]);
  useEffect(() => { packsRef.current = packs; }, [packs]);

  // 初始加载列表
  useEffect(() => {
    fetch(`${serverURL}/api/soundpacks`)
      .then(r => r.json())
      .then((list: Soundpack[]) => setPacks(list))
      .catch(() => {});
  }, [serverURL]);

  // 播放函数（可被本地点击和远端事件共用）
  const playSound = useCallback((soundId: string) => {
    const sp = packsRef.current.find(p => p.id === soundId);
    if (!sp) return;
    // 停止正在播放的音频
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    const audio = new Audio(`${serverURL}/sounds/${sp.filename}`);
    audioRef.current = audio;
    setPlayingId(soundId);
    audio.play().catch(() => {});
    audio.onended = () => setPlayingId(null);
  }, [serverURL]);

  // Socket 事件监听
  useEffect(() => {
    const onAdded = (sp: Soundpack) =>
      setPacks(prev => [sp, ...prev]);

    const onPlay = ({ soundId }: { soundId: string; playedBy: string }) =>
      playSound(soundId);

    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:play',  onPlay);
    return () => {
      socket.off('soundpack:added', onAdded);
      socket.off('soundpack:play',  onPlay);
    };
  }, [socket, playSound]);

  // 点播放按钮：本地立即播放，同时通知其他人
  const handlePlay = (sp: Soundpack) => {
    playSound(sp.id);
    socket.emit('soundpack:play', { soundId: sp.id, roomId });
  };

  // 上传文件
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) { alert('请选择音频文件'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('文件过大，最大支持 8MB'); return; }

    setUploading(true);
    try {
      // ArrayBuffer → base64（分块避免大文件栈溢出）
      const buf = await file.arrayBuffer();
      const u8  = new Uint8Array(buf);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < u8.length; i += chunk)
        binary += String.fromCharCode(...u8.slice(i, i + chunk));
      const base64 = btoa(binary);

      const name = file.name.replace(/\.[^.]+$/, ''); // 去掉扩展名
      const res  = await fetch(`${serverURL}/api/soundpacks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: base64, mimeType: file.type, socketId: socket.id }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        alert(`上传失败：${error}`);
      }
    } catch {
      alert('上传失败，请检查网络连接');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="border-t border-white/[0.08] flex-shrink-0">
      {/* 标题栏 */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <span className="text-white/30 text-sm font-semibold uppercase tracking-wider">语音包</span>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="上传语音包"
          className="text-white/30 hover:text-white/70 transition-colors p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-40"
        >
          {uploading ? (
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* 列表 */}
      {packs.length === 0 ? (
        <p className="px-4 pb-3 text-white/20 text-xs">暂无语音包，点 + 上传音频</p>
      ) : (
        <div className="max-h-44 overflow-y-auto px-3 pb-3 space-y-1">
          {packs.map(sp => (
            <div key={sp.id} className="flex items-center gap-2">
              {/* 播放按钮 */}
              <button
                onClick={() => handlePlay(sp)}
                title="播放（所有人都能听到）"
                className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                  playingId === sp.id
                    ? 'bg-green-500/25 text-green-400 border border-green-500/30'
                    : 'bg-white/[0.06] hover:bg-white/15 text-white/45 hover:text-white/90 border border-transparent hover:border-white/10'
                }`}
              >
                {playingId === sp.id ? (
                  /* 暂停图标（播放中） */
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  /* 播放图标 */
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* 名称 + 上传者 */}
              <div className="flex-1 min-w-0">
                <p className="text-white/75 text-sm truncate leading-tight">{sp.name}</p>
                <p className="text-white/25 text-xs truncate">{sp.uploader}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
