import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Socket } from 'socket.io-client';
import { LayoutGrid, LoaderCircle, Pause, Play, Upload, Volume2, X } from 'lucide-react';

interface Soundpack { id: string; name: string; filename: string; uploader: string; createdAt: number }
interface Props { socket: Socket; roomId: string; serverURL: string; disabled?: boolean }

export function SoundPackPanel({ socket, roomId, serverURL, disabled = false }: Props) {
  const [packs, setPacks] = useState<Soundpack[]>([]);
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const packsRef = useRef<Soundpack[]>([]);
  useEffect(() => { packsRef.current = packs; }, [packs]);

  useEffect(() => {
    fetch(`${serverURL}/api/soundpacks`).then(response => response.json()).then((list: Soundpack[]) => setPacks(list)).catch(() => undefined);
  }, [serverURL]);

  const playSound = useCallback((soundId: string) => {
    const sound = packsRef.current.find(pack => pack.id === soundId);
    if (!sound) return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    const audio = new Audio(`${serverURL}/sounds/${sound.filename}`);
    audioRef.current = audio;
    setPlayingId(soundId);
    audio.play().catch(() => setPlayingId(null));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
  }, [serverURL]);

  useEffect(() => {
    const onAdded = (sound: Soundpack) => setPacks(previous => [sound, ...previous]);
    const onPlay = ({ soundId }: { soundId: string }) => playSound(soundId);
    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:play', onPlay);
    return () => { socket.off('soundpack:added', onAdded); socket.off('soundpack:play', onPlay); };
  }, [socket, playSound]);

  const handlePlay = (sound: Soundpack) => {
    if (disabled) return;
    playSound(sound.id);
    socket.emit('soundpack:play', { soundId: sound.id, roomId });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('audio/')) { alert('请选择音频文件'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('文件过大，最大支持 8MB'); return; }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.slice(index, index + 8192));
      const response = await fetch(`${serverURL}/api/soundpacks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ''), data: btoa(binary), mimeType: file.type, socketId: socket.id }),
      });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error ?? '上传失败'); }
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : '上传失败，请检查网络连接');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <div className="flex-shrink-0 border-t border-white/[0.08] p-3">
        <button onClick={() => setOpen(true)} disabled={disabled} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2.5 text-left text-white/60 transition hover:border-cyan-300/25 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/40 disabled:cursor-not-allowed disabled:opacity-35">
          <LayoutGrid size={18} /><span className="flex-1 font-medium">语音包</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/40">{packs.length}</span>
        </button>
      </div>

      {open && createPortal((
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-6 backdrop-blur-md" onMouseDown={() => setOpen(false)}>
          <section className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-zinc-900/95 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="soundpack-title">
            <header className="flex items-center gap-3 border-b border-white/10 px-6 py-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-200"><Volume2 size={20} /></div>
              <div className="min-w-0 flex-1"><h2 id="soundpack-title" className="text-lg font-bold text-white">房间语音包</h2><p className="text-sm text-white/40">点击方格后，房间内所有成员会同步播放</p></div>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled} className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-3.5 py-2.5 text-sm font-medium text-white/65 transition hover:bg-white/15 hover:text-white disabled:opacity-35"><Upload size={17} />{uploading ? '上传中' : '上传音频'}</button>
              <button onClick={() => setOpen(false)} className="rounded-xl p-2.5 text-white/40 transition hover:bg-white/10 hover:text-white" aria-label="关闭语音包"><X size={19} /></button>
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileChange} />
            </header>

            <div className="overflow-y-auto p-5">
              {packs.length === 0 ? (
                <button onClick={() => fileInputRef.current?.click()} className="flex min-h-52 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 text-white/35 transition hover:border-cyan-300/35 hover:bg-cyan-300/[0.04] hover:text-white/70"><Upload size={28} /><span className="font-medium">上传第一个语音包</span><span className="text-sm text-white/25">最大 8MB</span></button>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {packs.map(sound => {
                    const playing = playingId === sound.id;
                    return (
                      <button key={sound.id} onClick={() => handlePlay(sound)} disabled={disabled} className={`group relative min-h-20 overflow-hidden rounded-2xl border px-4 py-3 text-left transition-all focus:outline-none focus:ring-2 focus:ring-cyan-300/50 disabled:opacity-35 ${playing ? 'border-cyan-300/50 bg-cyan-300/15 text-cyan-100 shadow-lg shadow-cyan-950/30' : 'border-white/[0.07] bg-white/[0.055] text-white/75 hover:-translate-y-0.5 hover:border-cyan-300/25 hover:bg-white/10 hover:text-white'}`} title="点击同步播放">
                        <span className="flex items-start gap-3"><span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${playing ? 'bg-cyan-200 text-zinc-900' : 'bg-white/10 text-white/45 group-hover:bg-cyan-300/10 group-hover:text-cyan-100'}`}>{playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{sound.name}</span><span className="mt-1 block truncate text-xs text-white/30">{sound.uploader}</span></span></span>
                        {playing && <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-cyan-300" />}
                      </button>
                    );
                  })}
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploading || disabled} className="flex min-h-20 items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-sm font-medium text-white/35 transition hover:border-cyan-300/35 hover:bg-cyan-300/[0.04] hover:text-cyan-100 disabled:opacity-35">{uploading ? <LoaderCircle size={18} className="animate-spin" /> : <Upload size={18} />} 上传</button>
                </div>
              )}
            </div>
          </section>
        </div>
      ), document.body)}
    </>
  );
}
